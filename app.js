/* YOPO v3.3 (Step 3)
   - Step 2 + Integrated Analysis Window (6 timeframes: 15m/1h/4h/1D/1W/2W)
   - Rule-based Score Ensemble + Regime + Backtest metrics + ATR TP/SL
   - No server. All client-side JS.
   - NOTE: Binance Futures does NOT provide 2W interval. 2W is aggregated from 1W.
*/
(() => {
  'use strict';

  const APP_VERSION = 'v3.3-step10-fixed3';
  const APP_BUILD = '2026-02-04 07:52:08';

    const IS_ANALYSIS_PAGE = /\/analysis\.html(\?|$)/.test(location.pathname + location.search);

const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---- Fixed rules (from your decision) ----
  const TF_SET = ['15m', '1h', '4h', '1d', '1w', '2w']; // 6 timeframes
  const DEFAULT_SYMBOL = 'BTCUSDT';
  const STORAGE_KEY = 'yopo_v3_3_state';
  const SETTINGS_KEY = 'yopo_v3_3_settings';
  const STATS_KEY = 'yopo_v3_3_stats';
  const DRAW_KEY = 'yopo_v3_3_drawings';

  // ---- Binance Futures endpoints ----
  const WS_BASE = 'wss://fstream.binance.com/ws';
  const REST_BASE = 'https://fapi.binance.com';

  // ---- Backfill size ----
  const BACKFILL_LIMIT = 600; // for chart + analysis (still reasonable)

  // ---- User settings (Step 5) ----
  const DEFAULT_SETTINGS = {
    feePct: 0.04,      // % per side
    slippagePct: 0.02, // %
    spreadPct: 0.01,   // %
    recentN: 10,
  };
  let settings = loadSettings() ?? { ...DEFAULT_SETTINGS };

  // ---- Backtest defaults ----
  const BT_MIN_SAMPLES = 20;            // Spec: N < 20 -> warning / best exclude
  const BT_WARMUP = 60;                // indicator warmup bars
  const BT_MAX_TRADES = 260;           // cap trades to keep browser fast
    // (Step 5) 비용은 settings에서 사용자 조절
  const CONF_LOW_TH = 1.5;             // 확신도 낮음 기준
  const ATRPCT_HIGH_TH = 3.0;          // ATR% 변동성 경고 기준
  const MDD_HIGH_TH = 15.0;            // MDD% 높음(위험) 기준
  const EXP_LOW_TH = 0.0;              // 기대값(%) 낮음 기준 (0 미만이면 불리)

  // ---- TP/SL (ATR 기반 고정) ----
  const ATR_LEN = 14;
  const SL_ATR_MULT = 1.0;
  const TP_ATR_MULT = 1.5;

  // ---- Signal params ----
  const EMA_FAST = 20;
  const EMA_SLOW = 50;
  const RSI_LEN = 14;
  const MACD_FAST = 12;
  const MACD_SLOW = 26;
  const MACD_SIGNAL = 9;
  const VOL_MA_LEN = 20;
  const ADX_LEN = 14;

  // ---- Hardcoded "famous + large" 30 coins baseline (Step 2 validates tradability softly) ----
  // Required included: BTC, ETH, ADA, XRP, SOL, ONDO
  const COINS_30 = [
    { sym:'BTCUSDT', name:'Bitcoin' },
    { sym:'ETHUSDT', name:'Ethereum' },
    { sym:'BNBUSDT', name:'BNB' },
    { sym:'SOLUSDT', name:'Solana' },
    { sym:'XRPUSDT', name:'XRP' },
    { sym:'ADAUSDT', name:'Cardano' },
    { sym:'DOGEUSDT', name:'Dogecoin' },
    { sym:'TRXUSDT', name:'TRON' },
    { sym:'AVAXUSDT', name:'Avalanche' },
    { sym:'LINKUSDT', name:'Chainlink' },
    { sym:'TONUSDT', name:'Toncoin' },
    { sym:'DOTUSDT', name:'Polkadot' },
    { sym:'MATICUSDT', name:'Polygon' },
    { sym:'LTCUSDT', name:'Litecoin' },
    { sym:'BCHUSDT', name:'Bitcoin Cash' },
    { sym:'NEARUSDT', name:'NEAR' },
    { sym:'ATOMUSDT', name:'Cosmos' },
    { sym:'ETCUSDT', name:'Ethereum Classic' },
    { sym:'APTUSDT', name:'Aptos' },
    { sym:'ARBUSDT', name:'Arbitrum' },
    { sym:'OPUSDT', name:'Optimism' },
    { sym:'SUIUSDT', name:'Sui' },
    { sym:'INJUSDT', name:'Injective' },
    { sym:'FILUSDT', name:'Filecoin' },
    { sym:'RNDRUSDT', name:'Render' },
    { sym:'PEPEUSDT', name:'Pepe' },
    { sym:'WIFUSDT', name:'dogwifhat' },
    { sym:'SEIUSDT', name:'Sei' },
    { sym:'ONDOUSDT', name:'Ondo' },
    { sym:'TIAUSDT', name:'Celestia' },
  ];

  // ---- State ----
  const state = loadState() ?? {
    symbol: DEFAULT_SYMBOL,
    tf: '15m',
    diag: { debug:false, lastAction:'-', ws:'미연동', error:'오류 없음', errorDetail:'' },
  };

  // ---- Runtime caches ----
  const tickerMap = new Map(); // sym -> {price, chgPct, quoteVol}
  let wsTicker = null;         // WS for !ticker@arr
  let wsKline = null;          // WS for selected symbol kline
  let activeKlineKey = '';     // symbol|tf
  let chart, candleSeries, volumeSeries;
  let lastBackfillReqId = 0;

  // Step 6: server time sync (Binance) for exact candle close timing
  let serverTimeOffsetMs = 0; // serverNow - Date.now()
  let lastServerSyncAt = 0;

  // ---- Tracking list placeholder (Step 4 will implement full engine) ----
  const trackItems = []; // active tracks
  let stats = loadStats() ?? { trades: [] };

  // ---- Diagnostics (required) ----
  window.addEventListener('error', (e) => {
    setDiagError(formatErrorEvent(e), formatErrorEvent(e, true));
    showDiag();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = formatRejection(e, false);
    const detail = formatRejection(e, true);
    setDiagError(msg, detail);
    showDiag();
  });

  // Listen messages from analysis window (track add)
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if(!data || typeof data !== 'object') return;
    if(data.type === 'ADD_TRACK'){
      try{
        addTrackPlaceholder(data.payload);
      }catch(err){
        setDiagError('추적 추가 실패', String(err && err.message ? err.message : err));
        showDiag();
      }
    }
  });

  // ---- UI init ----
  document.addEventListener('DOMContentLoaded', async () => {
    if(IS_ANALYSIS_PAGE){
      initAnalysisPage();
      return;
    }

    bindNetworkBanner();
    bindTop();
    renderCoinList(COINS_30);
    bindCoinSearch();
    bindTFButtons();
    initChart();
    restoreSelectionUI();
    const v = document.getElementById('verInfo');
    if(v) v.textContent = `${APP_VERSION} · ${APP_BUILD}`;

    updateDiagUI();
    saveState();

    // Step 2 starts here
    setLastAction('초기 데이터 연결');
    await startTickerWS();
    await syncServerTime();
    await refreshKlines(true);

    // Step 3/5/6: render panels
    renderTrackList();
    bindCostSettings();
    bindResetButtons();
    renderStats();
    renderDrawings();
  });

  // ---------------- UI bindings ----------------
  function bindTop(){
    $('#btnDiag').addEventListener('click', () => { setLastAction('자가진단 열기'); showDiag(); });
    $('#btnCloseDiag').addEventListener('click', hideDiag);
    $('#btnCopyDiag').addEventListener('click', copyDiag);
    $('#dbgToggle').addEventListener('change', (e) => {
      state.diag.debug = !!e.target.checked;
      setLastAction('디버그 토글');
      updateDiagUI();
      saveState();
    });

    $('#btnAnalyze').addEventListener('click', async () => {
      setLastAction('통합 분석(새 창) 클릭');
      try{
        await openIntegratedAnalysis();
      }catch(err){
        setDiagError('통합 분석 열기 실패', String(err && err.message ? err.message : err));
        showDiag();
      }
    });

    const stopAll = $('#btnStopAll');
    stopAll.addEventListener('click', () => {
      setLastAction('전체 중지(현재는 자리)');
      // Step 4: implement
      trackItems.length = 0;
      renderTrackList();
      renderStats();
    });
  }

  function renderCoinList(items){
    const el = $('#coinList');
    el.innerHTML = '';
    for(const c of items){
      const row = document.createElement('div');
      row.className = 'coin' + (c.sym === state.symbol ? ' is-active' : '');
      row.dataset.sym = c.sym;
      row.dataset.name = c.name;
      row.innerHTML = `
        <div class="left">
          <div class="sym">${escapeHtml(c.sym.replace('USDT',''))}</div>
          <div class="name">${escapeHtml(c.name)}</div>
        </div>
        <div class="right">
          <div class="price" data-field="price">-</div>
          <div class="chg" data-field="chg">-</div>
        </div>
      `;
      row.addEventListener('click', async () => {
        setLastAction(`코인 선택: ${c.sym}`);
        state.symbol = c.sym;
        $('#selectedSymbol').textContent = c.sym;
        $$('.coin').forEach(x => x.classList.toggle('is-active', x.dataset.sym === c.sym));
        updateDiagUI();
        saveState();
        await refreshKlines(true);
      });
      el.appendChild(row);
    }
    repaintTickerList();
  }

  function repaintTickerList(){
    for(const row of $$('.coin')){
      const sym = row.dataset.sym;
      const t = tickerMap.get(sym);
      if(!t) continue;
      const priceEl = row.querySelector('[data-field="price"]');
      const chgEl = row.querySelector('[data-field="chg"]');
      if(priceEl) priceEl.textContent = formatPrice(t.price);
      if(chgEl) chgEl.textContent = formatPct(t.chgPct);
    }
  }

  function bindCoinSearch(){
    const input = $('#coinSearch');
    input.addEventListener('input', () => {
      const q = input.value.trim().toUpperCase();
      const filtered = COINS_30.filter(c => c.sym.includes(q) || c.name.toUpperCase().includes(q));
      renderCoinList(filtered);
    });
  }

  function bindTFButtons(){
    $$('.tf-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tf = btn.dataset.tf;
        if(!TF_SET.includes(tf)) return;
        setLastAction(`타임프레임 선택: ${tf}`);
        state.tf = tf;
        $$('.tf-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tf === tf));
        $('#dgSel').textContent = `${state.symbol} / ${tf}`;
        updateDiagUI();
        saveState();
        await refreshKlines(true);
      });
    });
  }

  function restoreSelectionUI(){
    $('#selectedSymbol').textContent = state.symbol;
    $$('.tf-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tf === state.tf));
    $('#dbgToggle').checked = !!state.diag.debug;
    $$('.coin').forEach(x => x.classList.toggle('is-active', x.dataset.sym === state.symbol));
  }

  // ---------------- Track UI (placeholder) ----------------
  function addTrackPlaceholder(payload){
    // payload: {symbol, tf, dir, entry, tp, sl, conf, regime}
    const id = 't_' + Math.random().toString(16).slice(2);
    trackItems.push({
      id,
      symbol: payload.symbol,
      tf: payload.tf,
      dir: payload.dir,
      entry: payload.entry,
      tp: payload.tp,
      sl: payload.sl,
      conf: payload.conf,
      regime: payload.regime,
      createdAt: Date.now(),
    });
    renderTrackList();
  }

  function renderTrackList(){
    const box = $('#trackList');
    const stopAll = $('#btnStopAll');
    if(trackItems.length === 0){
      box.innerHTML = `<div class="empty">아직 추적이 없습니다. (통합 분석 새 창에서 “이 전략 추적” 클릭 시 추가됨)</div>`;
      stopAll.disabled = true;
      return;
    }
    stopAll.disabled = false;

    box.innerHTML = trackItems.map(it => `
      <div class="track-item">
        <div class="ti-left">
          <div class="ti-title"><b>${escapeHtml(it.symbol)}</b> · ${escapeHtml(it.tf.toUpperCase())} · <span class="${it.dir==='LONG'?'oktxt':'dngtxt'}">${escapeHtml(it.dir)}</span></div>
          <div class="ti-sub">진입 ${formatPrice(it.entry)} · TP ${formatPrice(it.tp)} · SL ${formatPrice(it.sl)} · 확신도 ${formatNum(it.conf,2)} · 레짐 ${escapeHtml(it.regime||'-')}</div>
        </div>
        <div class="ti-right">
          <button class="btn btn-ghost" data-stop="${escapeHtml(it.id)}">중지</button>
        </div>
      </div>
    `).join('');

    $$('.track-item [data-stop]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-stop');
        const idx = trackItems.findIndex(x => x.id === id);
        if(idx >= 0){
          trackItems.splice(idx, 1);
          renderTrackList();
        }
      });
    });
  }

  
  // ---------------- Step 10: Drawing Engine (Line/Rect, time+price 저장) ----------------
  let drawTool = 'none'; // none | line | rect
  let isDrawing = false;
  let drawStart = null; // {x,y}
  let drawings = [];    // [{tool,t1,p1,t2,p2}]

  let drawCanvas = null;
  let drawCtx = null;

  function loadDrawings(){
    try{
      const raw = localStorage.getItem(DRAW_KEY);
      if(!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }catch(_){ return []; }
  }
  function saveDrawings(){
    try{ localStorage.setItem(DRAW_KEY, JSON.stringify(drawings)); }catch(_){}
  }

  function bindDrawToolbar(){
    const bar = document.getElementById('drawToolbar');
    if(!bar) return;
    bar.querySelectorAll('button[data-tool]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        drawTool = btn.getAttribute('data-tool') || 'none';
        bar.querySelectorAll('.btn').forEach(b=>b.classList.remove('is-active'));
        btn.classList.add('is-active');
      });
    });
  }

  function initDrawCanvas(){
    drawCanvas = document.getElementById('drawCanvas');
    if(!drawCanvas) return;
    drawCtx = drawCanvas.getContext('2d');
    resizeDrawCanvas();
    window.addEventListener('resize', ()=>{
      resizeDrawCanvas();
      renderDrawings();
    });
  }

  function resizeDrawCanvas(){
    if(!drawCanvas) return;
    const rect = drawCanvas.getBoundingClientRect();
    drawCanvas.width  = Math.max(1, Math.floor(rect.width * devicePixelRatio));
    drawCanvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
    if(drawCtx) drawCtx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  }

  function initDrawing(){
    bindDrawToolbar();
    initDrawCanvas();
    drawings = loadDrawings();
    renderDrawings();

    const container = document.getElementById('chart');
    if(!container) return;

    container.addEventListener('mousedown', (e)=>{
      if(drawTool === 'none') return;
      isDrawing = true;
      drawStart = { x: e.offsetX, y: e.offsetY };
    });

    container.addEventListener('mousemove', (e)=>{
      if(!isDrawing || !drawStart) return;
      renderDrawings({ x: e.offsetX, y: e.offsetY });
    });

    container.addEventListener('mouseup', (e)=>{
      if(!isDrawing || !drawStart) return;
      isDrawing = false;

      const t1 = chart && chart.timeScale().coordinateToTime(drawStart.x);
      const p1 = candleSeries && candleSeries.coordinateToPrice(drawStart.y);
      const t2 = chart && chart.timeScale().coordinateToTime(e.offsetX);
      const p2 = candleSeries && candleSeries.coordinateToPrice(e.offsetY);

      if(t1 == null || t2 == null || p1 == null || p2 == null){
        drawStart = null;
        renderDrawings();
        return;
      }

      drawings.push({ tool: drawTool, t1, p1, t2, p2 });
      saveDrawings();
      drawStart = null;
      renderDrawings();
    });

    if(chart){
      chart.timeScale().subscribeVisibleTimeRangeChange(()=>renderDrawings());
    }
  }

  function renderDrawings(preview=null){
    if(!drawCtx || !drawCanvas || !chart || !candleSeries) return;

    const ctx = drawCtx;
    const w = drawCanvas.clientWidth;
    const h = drawCanvas.clientHeight;
    ctx.clearRect(0,0,w,h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(122,168,255,.80)';
    ctx.fillStyle = 'rgba(122,168,255,.10)';

    const drawOne = (d, dashed=false) => {
      const x1 = chart.timeScale().timeToCoordinate(d.t1);
      const y1 = candleSeries.priceToCoordinate(d.p1);
      const x2 = chart.timeScale().timeToCoordinate(d.t2);
      const y2 = candleSeries.priceToCoordinate(d.p2);
      if(x1==null || y1==null || x2==null || y2==null) return;

      ctx.setLineDash(dashed ? [6,4] : []);
      if(d.tool === 'line'){
        ctx.beginPath();
        ctx.moveTo(x1,y1);
        ctx.lineTo(x2,y2);
        ctx.stroke();
      }else if(d.tool === 'rect'){
        const x = Math.min(x1,x2), y = Math.min(y1,y2);
        const rw = Math.abs(x2-x1), rh = Math.abs(y2-y1);
        ctx.strokeRect(x,y,rw,rh);
        ctx.fillRect(x,y,rw,rh);
      }
      ctx.setLineDash([]);
    };

    for(const d of drawings) drawOne(d,false);

    if(preview && drawStart){
      const t1 = chart.timeScale().coordinateToTime(drawStart.x);
      const p1 = candleSeries.coordinateToPrice(drawStart.y);
      const t2 = chart.timeScale().coordinateToTime(preview.x);
      const p2 = candleSeries.coordinateToPrice(preview.y);
      if(t1!=null && t2!=null && p1!=null && p2!=null){
        drawOne({ tool: drawTool, t1, p1, t2, p2 }, true);
      }
    }
  }


// ---------------- Chart ----------------
  function initChart(){
    const container = $('#chart');
    if(!window.LightweightCharts){
      setDiagError('차트 라이브러리 로딩 실패: LightweightCharts를 불러오지 못했습니다.', 'LightweightCharts missing');
      showDiag();
      return;
    }

    chart = LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: 'rgba(0,0,0,0)' },
        textColor: 'rgba(232,238,255,.88)',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,.06)' },
        horzLines: { color: 'rgba(255,255,255,.06)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,.10)' },
      timeScale: { borderColor: 'rgba(255,255,255,.10)' },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScroll: true,
      handleScale: true,
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: 'rgba(85,215,153,.95)',
      downColor: 'rgba(255,107,122,.95)',
      borderVisible: false,
      wickUpColor: 'rgba(85,215,153,.95)',
      wickDownColor: 'rgba(255,107,122,.95)',
    });

    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.80, bottom: 0 },
    });

    window.addEventListener('resize', () => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });

    // Step 10: enable drawings
    initDrawing();

  }

  function setChartData(bars, vols){
    if(!candleSeries || !volumeSeries) return;
    candleSeries.setData(bars);
    volumeSeries.setData(vols);
    chart.timeScale().fitContent();
  }

  function updateLastBar(bar, vol){
    if(!candleSeries || !volumeSeries) return;
    candleSeries.update(bar);
    volumeSeries.update(vol);
  }

  
  // ---------------- Step 9: robust fetch ----------------
  async function fetchJSON(url, { timeoutMs=8000, retries=2 } = {}){
    let lastErr = null;
    for(let i=0;i<=retries;i++){
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), timeoutMs);
      try{
        const res = await fetch(url, { method:'GET', signal: ctrl.signal, cache:'no-store' });
        clearTimeout(t);
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }catch(err){
        clearTimeout(t);
        lastErr = err;
        // small backoff
        await new Promise(r=>setTimeout(r, 300 + i*500));
      }
    }
    throw lastErr || new Error('fetchJSON failed');
  }

  function bindNetworkBanner(){
    const b = document.getElementById('offlineBanner');
    const set = (on)=>{
      if(!b) return;
      b.classList.toggle('hidden', on);
    };
    window.addEventListener('online', ()=>set(true));
    window.addEventListener('offline', ()=>set(false));
    // init
    set(navigator.onLine);
  }


// ---------------- Data: WS + REST ----------------
  async function startTickerWS(){
    try{
      closeWS(wsTicker);
      wsTicker = new WebSocket(`${WS_BASE}/!ticker@arr`);

      wsTicker.onopen = () => {
        wsTicker.__retry = 0;
        setConnStatus(true, 'WS 연결됨');
        state.diag.ws = '티커 WS: 연결됨';
        updateDiagUI();
        saveState();
      };

      wsTicker.onmessage = (ev) => {
        let data;
        try{ data = JSON.parse(ev.data); }catch{ return; }
        if(!Array.isArray(data)) return;

        for(const t of data){
          const sym = t.s;
          if(!isOurCoin(sym)) continue;
          const price = safeNum(t.c);
          const chgPct = safeNum(t.P);
          const quoteVol = safeNum(t.q);
          tickerMap.set(sym, { price, chgPct, quoteVol });
        }
        repaintTickerList();
      };

      wsTicker.onerror = () => {
        setConnStatus(false, 'WS 오류');
        state.diag.ws = '티커 WS: 오류';
        updateDiagUI();
        saveState();
      };

      wsTicker.onclose = () => {
        setConnStatus(false, 'WS 끊김');
        state.diag.ws = '티커 WS: 끊김';
        updateDiagUI();
        saveState();
        wsTicker.__retry = (wsTicker.__retry || 0) + 1;
        const wait = Math.min(15000, 800 + wsTicker.__retry*700);
        setTimeout(() => startTickerWS(), wait);
      };
    }catch(err){
      setConnStatus(false, 'WS 실패');
      setDiagError('티커 WS 연결 실패', String(err && err.message ? err.message : err));
      showDiag();
    }
  }

  function isOurCoin(sym){
    return COINS_30.some(c => c.sym === sym);
  }

  async function refreshKlines(){
    const symbol = state.symbol;
    const tf = state.tf;

    const reqId = ++lastBackfillReqId;
    activeKlineKey = `${symbol}|${tf}`;

    setConnStatus(null, '로딩 중…');
    state.diag.ws = 'kline: 로딩 중';
    updateDiagUI();

    try{
      const { bars, vols } = await fetchKlinesBackfill(symbol, tf, BACKFILL_LIMIT);
      if(reqId !== lastBackfillReqId) return;
      setChartData(bars, vols);
      setConnStatus(true, '데이터 OK');
    }catch(err){
      if(reqId !== lastBackfillReqId) return;
      setConnStatus(false, 'REST 실패');
      setDiagError('캔들 REST 백필 실패', String(err && err.message ? err.message : err));
      showDiag();
      return;
    }

    try{
      await startKlineWS(symbol, tf);
      if(reqId !== lastBackfillReqId) return;
      state.diag.ws = `티커 WS: ${wsTicker && wsTicker.readyState===1 ? '연결됨' : '상태불명'} · kline WS: 연결됨`;
      updateDiagUI();
      saveState();
    }catch(err){
      if(reqId !== lastBackfillReqId) return;
      setConnStatus(false, 'kline WS 실패');
      setDiagError('캔들 WS 연결 실패', String(err && err.message ? err.message : err));
      showDiag();
    }
  }

  async function fetchKlinesBackfill(symbol, tf, limit){
    const interval = (tf === '2w') ? '1w' : tf;
    const url = `${REST_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    const raw = await fetchJSON(url, { timeoutMs: 10000, retries: 2 });
    if(!Array.isArray(raw)) throw new Error('Invalid klines payload');

    const parsed = raw.map(k => ({
      openTime: Math.floor(k[0]/1000),
      open: safeNum(k[1]),
      high: safeNum(k[2]),
      low:  safeNum(k[3]),
      close:safeNum(k[4]),
      volume: safeNum(k[5]),
      closeTime: Math.floor(k[6]/1000),
      isFinal: true,
    }));

    let bars, vols, ohlcv;
    if(tf === '2w'){
      const agg = aggregate2WFrom1W(parsed);
      bars = agg.map(x => ({ time:x.openTime, open:x.open, high:x.high, low:x.low, close:x.close }));
      vols = agg.map(x => ({ time:x.openTime, value: Math.max(0, Math.round(x.volume)) }));
      ohlcv = agg;
    }else{
      bars = parsed.map(x => ({ time:x.openTime, open:x.open, high:x.high, low:x.low, close:x.close }));
      vols = parsed.map(x => ({ time:x.openTime, value: Math.max(0, Math.round(x.volume)) }));
      ohlcv = parsed;
    }
    return { bars, vols, ohlcv };
  }

  function aggregate2WFrom1W(weeks){
    const out = [];
    for(let i=0;i<weeks.length;i+=2){
      const a = weeks[i];
      const b = weeks[i+1];
      if(!a) continue;
      if(!b){
        out.push({ ...a, isFinal:false });
        continue;
      }
      out.push({
        openTime: a.openTime,
        closeTime: b.closeTime,
        open: a.open,
        close: b.close,
        high: Math.max(a.high, b.high),
        low: Math.min(a.low, b.low),
        volume: a.volume + b.volume,
        isFinal: true,
      });
    }
    return out;
  }

  async function startKlineWS(symbol, tf){
    closeWS(wsKline);
    const interval = (tf === '2w') ? '1w' : tf;
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    wsKline = new WebSocket(`${WS_BASE}/${stream}`);

    wsKline.onopen = () => {
      wsKline.__retry = 0;
      state.diag.ws = `kline WS: 연결됨 (${symbol} ${interval})`;
      updateDiagUI();
      saveState();
    };

    wsKline.onmessage = (ev) => {
      let msg;
      try{ msg = JSON.parse(ev.data); }catch{ return; }
      if(!msg || !msg.k) return;
      if(activeKlineKey !== `${state.symbol}|${state.tf}`) return;

      const k = msg.k;
      const openTime = Math.floor(k.t/1000);
      const isFinal = !!k.x;

      const one = {
        openTime,
        open: safeNum(k.o),
        high: safeNum(k.h),
        low:  safeNum(k.l),
        close:safeNum(k.c),
        volume: safeNum(k.v),
        isFinal,
      };

      if(state.tf !== '2w'){
        updateLastBar(
          { time: one.openTime, open: one.open, high: one.high, low: one.low, close: one.close },
          { time: one.openTime, value: Math.max(0, Math.round(one.volume)) }
        );
        return;
      }
      update2WFromWeekly(one);
    };

    wsKline.onerror = () => {
      state.diag.ws = 'kline WS: 오류';
      setConnStatus(false, 'kline WS 오류');
      updateDiagUI();
      saveState();
    };

    wsKline.onclose = () => {
      wsKline.__retry = (wsKline.__retry || 0) + 1;
      state.diag.ws = 'kline WS: 끊김';
      setConnStatus(false, 'kline WS 끊김');
      updateDiagUI();
      saveState();
      setTimeout(() => {
        if(activeKlineKey === `${state.symbol}|${state.tf}`) startKlineWS(state.symbol, state.tf);
      }, Math.min(15000, 800 + ((wsKline&&wsKline.__retry?wsKline.__retry:0)+1)*700));
    };
  }

  // 2W live aggregation buffer (weekly)
  let lastWeekA = null;
  let lastWeekB = null;

  function update2WFromWeekly(week){
    if(!lastWeekA || week.openTime > lastWeekA.openTime){
      lastWeekB = lastWeekA;
      lastWeekA = week;
    }else if(lastWeekA && week.openTime === lastWeekA.openTime){
      lastWeekA = week;
    }else if(lastWeekB && week.openTime === lastWeekB.openTime){
      lastWeekB = week;
    }else if(!lastWeekB){
      lastWeekB = week;
    }

    const older = (lastWeekB && lastWeekA && lastWeekB.openTime < lastWeekA.openTime) ? lastWeekB : lastWeekA;
    const newer = (older === lastWeekB) ? lastWeekA : lastWeekB;

    if(!older) return;

    if(!newer){
      updateLastBar(
        { time: older.openTime, open: older.open, high: older.high, low: older.low, close: older.close },
        { time: older.openTime, value: Math.max(0, Math.round(older.volume)) }
      );
      return;
    }

    const agg = {
      time: older.openTime,
      open: older.open,
      close: newer.close,
      high: Math.max(older.high, newer.high),
      low: Math.min(older.low, newer.low),
      volume: older.volume + newer.volume,
    };

    updateLastBar(
      { time: agg.time, open: agg.open, high: agg.high, low: agg.low, close: agg.close },
      { time: agg.time, value: Math.max(0, Math.round(agg.volume)) }
    );
  }

  function closeWS(ws){
    try{
      if(ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close();
    }catch(_){}
  }

  // ---------------- Integrated analysis window (Step 3) ----------------
  // -- Integrated analysis window (Step 3) ----------------
async function openIntegratedAnalysis(){
  const symbol = state.symbol;
  // Mobile-safe: open a real page (analysis.html) instead of document.write into about:blank
  const url = `analysis.html?symbol=${encodeURIComponent(symbol)}`;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if(!w){
    setDiagError('팝업이 차단되었습니다. 브라우저에서 팝업 허용 후 다시 시도해 주세요.', 'Popup blocked');
    showDiag();
    return;
  }
}

// Entry for analysis.html
async function initAnalysisPage(){
  try{

// minimal bindings for diag overlay buttons (analysis page)
const _c = document.getElementById('btnCloseDiag');
if(_c) _c.addEventListener('click', hideDiag);
const _cp = document.getElementById('btnCopyDiag');
if(_cp) _cp.addEventListener('click', copyDiag);
const _dbg = document.getElementById('dbgToggle');
if(_dbg) _dbg.addEventListener('change', (e)=>{ state.diag.debug = !!e.target.checked; updateDiagUI(); });

    const qs = new URLSearchParams(location.search || '');
    const symbol = (qs.get('symbol') || 'BTCUSDT').toUpperCase();
    // header
    const symEl = document.getElementById('sym');
    if(symEl) symEl.textContent = symbol;
    const tfBadgesEl = document.getElementById('tfBadges');
    if(tfBadgesEl) tfBadgesEl.innerHTML = TF_SET.map(tf => `<span class="pill">${escapeHtml(tf.toUpperCase())}</span>`).join('');
    const statusEl = document.getElementById('status');
    if(statusEl) statusEl.textContent = '데이터 불러오는 중…';

    const results = [];
    for(let i=0;i<TF_SET.length;i++){
      const tf = TF_SET[i];
      if(statusEl) statusEl.textContent = `[${i+1}/6] ${tf.toUpperCase()} 분석 중…`;
      const r = await analyzeOneTF(symbol, tf);
      results.push(r);
      renderAnalysisCard(window, r);
    }

    const best = pickBest(results);
    if(best){
      markBestCard(window, best.tf);
      const bestEl = document.getElementById('bestBox');
      if(bestEl){
        bestEl.innerHTML = `BEST: <b>${escapeHtml(best.tf.toUpperCase())}</b> · 승률 ${formatNum(best.bt.winRate,1)}% · 기대값 ${formatNum(best.bt.expectancy,3)}% · MDD ${formatNum(best.bt.mdd,1)}%`;
      }
    }
    if(statusEl) statusEl.textContent = '완료 ✅ (각 카드에서 “이 전략 추적” 클릭 가능)';
  }catch(err){
    // Use built-in diag overlay if present (analysis page has it too)
    try{
      setDiagError('통합 분석 페이지 초기화 실패', String(err && err.stack ? err.stack : err));
      showDiag();
    }catch(_e){}
  }
}



  function getAnalysisHTMLSkeleton(symbol){
    const tfBadges = TF_SET.map(tf => `<span class="pill">${tf.toUpperCase()}</span>`).join('');
    return `
      <!doctype html><html lang="ko"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>통합 분석 - ${escapeHtml(symbol)}</title>
      <style>
        :root{
          --bg:#0b1020; --panel:rgba(255,255,255,.03); --line:rgba(255,255,255,.10);
          --text:#e8eeff; --muted:rgba(232,238,255,.68);
          --ok:#55d799; --bad:#ff6b7a; --warn:#ffcc66; --accent:#7aa8ff;
        }
        body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,"Apple SD Gothic Neo","Noto Sans KR"}
        .wrap{max-width:1080px;margin:0 auto;padding:18px}
        .top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
        h1{margin:0;font-size:20px}
        .sub{color:var(--muted);font-size:13px;margin-top:6px;line-height:1.4}
        .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
        .pill{display:inline-block;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--muted);font-size:12px}
        .status{margin-top:10px;color:var(--muted);font-size:13px}
        .best{margin-top:12px;padding:10px 12px;border-radius:14px;border:1px solid rgba(122,168,255,.35);background:rgba(122,168,255,.10);font-size:13px}
        .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:14px}
        .card{border:1px solid var(--line);background:var(--panel);border-radius:18px;padding:14px}
        .card h3{margin:0 0 6px 0;font-size:15px}
        .tag{font-size:12px;color:var(--muted)}
        .big{font-size:18px;font-weight:900;margin-top:8px}
        .ok{color:var(--ok)} .bad{color:var(--bad)} .warn{color:var(--warn)}
        .kv{display:grid;grid-template-columns: 1fr 1fr; gap:8px;margin-top:10px}
        .kv .box{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;background:rgba(0,0,0,.20)}
        .k{color:var(--muted);font-size:12px}
        .v{font-weight:800;margin-top:6px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;font-size:12px}
        .why{margin-top:10px;color:var(--muted);font-size:12px;line-height:1.5}
        .btn{margin-top:12px;width:100%;padding:10px 12px;border-radius:14px;border:1px solid rgba(122,168,255,.45);
             background:rgba(122,168,255,.15);color:var(--text);font-weight:900;cursor:pointer}
        .btn:hover{filter:brightness(1.07)}
        .note{margin-top:10px;color:var(--muted);font-size:12px}
        @media (max-width: 900px){ .grid{grid-template-columns:1fr} }
      </style>
      </head><body>
        <div class="wrap">
          <div class="top">
            <div>
              <h1>통합 분석(새 창) · ${escapeHtml(symbol)}</h1>
              <div class="sub">
                각 카드 = 1개 구간(15m~2W).<br/>
                종료 기준: <b>해당 TF 캔들 마감</b> · TP/SL: <b>ATR 기반</b> · 백테스트: 같은 규칙으로 계산
              </div>
              <div class="row">${tfBadges}</div>
              <div id="bestBox" class="best">BEST: 계산 중…</div>
              <div class="status" id="status">준비중…</div>
            </div>
            <div class="note">
              신뢰 낮음 규칙(기본):<br/>
              - 표본 N &lt; ${BT_MIN_SAMPLES}<br/>
              - 확신도 &lt; ${CONF_LOW_TH}<br/>
              - ATR% &gt; ${ATRPCT_HIGH_TH}%<br/>
              - 기대값 &lt; ${EXP_LOW_TH}%<br/>
              - MDD &gt; ${MDD_HIGH_TH}%
            </div>
          </div>
          <div id="root" class="grid"></div>
        </div>
      </body></html>
    `;
  }

  function renderAnalysisCard(w, r){
    const root = w.document.getElementById('root');
    if(!root) return;

    const dirCls = r.dir === 'LONG' ? 'ok' : 'bad';
    const warn = (r.warns && r.warns.length)
      ? `<div class="tag warn">신뢰: ${escapeHtml(r.trust||'낮음')} · 이유: ${escapeHtml(r.warns.join(' / '))}</div>`
      : `<div class="tag">신뢰: ${escapeHtml(r.trust||'보통')}</div>`;

    const html = `
      <div class="card" id="card_${escapeHtml(r.tf)}">
        <h3>${escapeHtml(r.tf.toUpperCase())} 구간</h3>
        ${warn}
        <div class="big ${dirCls}">${escapeHtml(r.dir)} <span class="tag">(확신도 ${formatNum(r.conf,2)})</span></div>

        <div class="kv">
          <div class="box">
            <div class="k">진입가(현재가)</div>
            <div class="v">${formatPrice(r.entry)}</div>
          </div>
          <div class="box">
            <div class="k">레짐</div>
            <div class="v">${escapeHtml(r.regime)} (ADX ${formatNum(r.regimeInfo.adx,1)}, ATR% ${formatNum(r.regimeInfo.atrPct,2)}%)</div>
          </div>
          <div class="box">
            <div class="k">목표가 / 손절가</div>
            <div class="v">TP ${formatPrice(r.tp)} (${formatNum(r.tpPct,2)}%) · SL ${formatPrice(r.sl)} (${formatNum(r.slPct,2)}%)</div>
          </div>
          <div class="box">
            <div class="k">백테스트 (N=${r.bt.n})</div>
            <div class="v">승률 ${formatNum(r.bt.winRate,1)}% · 평균손익 ${formatNum(r.bt.avgRet,3)}% · MDD ${formatNum(r.bt.mdd,1)}%</div>
          </div>
          <div class="box">
            <div class="k">신뢰도(종합)</div>
            <div class="v">${escapeHtml(r.trust||'보통')}</div>
          </div>
          <div class="box">
            <div class="k">기대값(Expectancy)</div>
            <div class="v">${formatNum(r.bt.expectancy,3)}%</div>
          </div>
          <div class="box">
            <div class="k">근거(요약)</div>
            <div class="v">${escapeHtml(r.reasonShort)}</div>
          </div>
        </div>

        <div class="why">${escapeHtml(r.reasonLong)}</div>

        <button class="btn" data-track='${escapeHtml(JSON.stringify({
          symbol: r.symbol, tf: r.tf, dir: r.dir, entry: r.entry, tp: r.tp, sl: r.sl, conf: r.conf, regime: r.regime
        }))}'>이 전략 추적</button>
      </div>
    `;

    const tmp = w.document.createElement('div');
    tmp.innerHTML = html;
    const card = tmp.firstElementChild;
    root.appendChild(card);

    const btn = card.querySelector('[data-track]');
    btn.addEventListener('click', () => {
      try{
        const payload = JSON.parse(btn.getAttribute('data-track'));
        w.opener?.postMessage({ type:'ADD_TRACK', payload }, '*');
        btn.textContent = '추적에 추가됨 ✅';
        btn.disabled = true;
        btn.style.opacity = '0.75';
      }catch(_){
        // ignore
      }
    });
  }

  function markBestCard(w, tf){
    try{
      const card = w.document.getElementById('card_' + tf);
      if(!card) return;
      card.style.borderColor = 'rgba(122,168,255,.55)';
      card.style.boxShadow = '0 0 0 2px rgba(122,168,255,.15) inset';
      const h3 = card.querySelector('h3');
      if(h3 && !h3.innerHTML.includes('BEST')){
        h3.innerHTML = h3.textContent + ' <span class="best-badge">BEST</span>';
      }
    }catch(_){ }
  }

  function pickBest(results){
    // Composite: winRate + expectancy - mdd penalty, also require N >= min
    const valid = results.filter(r => r.bt && r.bt.n >= BT_MIN_SAMPLES);
    if(valid.length === 0) return null;
    let best = null;
    let bestScore = -Infinity;
    for(const r of valid){
      const score = (r.bt.winRate * 0.4) + (r.bt.expectancy * 12) - (r.bt.mdd * 0.3);
      if(score > bestScore){
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  function calcTrustLevel(bt, conf, atrPct){
    // EASY: High / Medium / Low
    let score = 0;
    // Step 10: WFO recent fold bonus/penalty
    const wfoBoost = (r.bt && r.bt.folds && r.bt.folds.length) ? (r.bt.folds[r.bt.folds.length-1].avgRet||0) : 0;
    if(bt.n >= BT_MIN_SAMPLES) score += 2; else score -= 2;
    if(conf >= CONF_LOW_TH) score += 1; else score -= 1;
    if(atrPct <= ATRPCT_HIGH_TH) score += 1; else score -= 1;
    if(bt.expectancy >= EXP_LOW_TH) score += 1; else score -= 1;
    if(bt.mdd <= MDD_HIGH_TH) score += 1; else score -= 1;
    if(score >= 3) return '높음';
    if(score >= 0) return '보통';
    return '낮음';
  }

  
  // ---------------- Step 10: WFO (rolling) backtest ----------------
  function backtestWFO(candles, dir, tpPx, slPx, atrPx, entryPx){
    // This is a walk-forward simulation: signal and trade evaluation use only past bars.
    // Additionally, we report rolling folds performance to avoid "one big number" bias.
    const costPct = costPctNow();
    const n = candles.length;
    if(n < 60){
      return { n:0, winRate:0, avgRet:0, mdd:0, expectancy:0, folds:[], lastFoldOk:false };
    }

    // Trade rule: open at close(i) and exit by TP/SL within next bar range; else exit at close(i+1).
    const rets = [];
    const times = [];
    for(let i=20;i<n-2;i++){ // warmup for indicators already applied outside; keep safe
      const e = candles[i].c;
      const next = candles[i+1];
      // build dynamic TP/SL around entry using ATR-based distance (same as analysis)
      const tp = (dir==='LONG') ? e + atrPx*2.0 : e - atrPx*2.0;
      const sl = (dir==='LONG') ? e - atrPx*1.2 : e + atrPx*1.2;

      let exit = next.c;
      let outcome = 'TIME';

      if(dir==='LONG'){
        if(next.h >= tp){ exit = tp; outcome='TP'; }
        else if(next.l <= sl){ exit = sl; outcome='SL'; }
      }else{
        if(next.l <= tp){ exit = tp; outcome='TP'; }
        else if(next.h >= sl){ exit = sl; outcome='SL'; }
      }

      const gross = (dir==='LONG') ? (exit-e)/e*100 : (e-exit)/e*100;
      const ret = gross - costPct;
      rets.push(ret);
      times.push(candles[i+1].t);
    }

    const tradesN = rets.length;
    if(tradesN === 0){
      return { n:0, winRate:0, avgRet:0, mdd:0, expectancy:0, folds:[], lastFoldOk:false };
    }

    // Overall stats
    const wins = rets.filter(x=>x>0).length;
    const winRate = wins/tradesN*100;
    const avgRet = rets.reduce((a,b)=>a+b,0)/tradesN;

    // equity curve and MDD
    let eq=1.0, peak=1.0, mdd=0;
    for(const r of rets){
      eq *= (1 + r/100);
      if(eq>peak) peak=eq;
      const dd=(peak-eq)/peak*100;
      if(dd>mdd) mdd=dd;
    }
    const expectancy = avgRet;

    // Rolling folds (3 folds by time)
    const folds = [];
    const foldCount = 3;
    for(let k=0;k<foldCount;k++){
      const a = Math.floor(tradesN * (k/foldCount));
      const b = Math.floor(tradesN * ((k+1)/foldCount));
      const seg = rets.slice(a,b);
      if(seg.length===0) continue;
      const w = seg.filter(x=>x>0).length/seg.length*100;
      const av = seg.reduce((x,y)=>x+y,0)/seg.length;
      let eq2=1.0, pk2=1.0, m2=0;
      for(const r of seg){
        eq2 *= (1 + r/100);
        if(eq2>pk2) pk2=eq2;
        const dd2=(pk2-eq2)/pk2*100;
        if(dd2>m2) m2=dd2;
      }
      folds.push({ fold:k+1, n:seg.length, winRate:w, avgRet:av, mdd:m2 });
    }

    const last = folds[folds.length-1] || null;
    const lastFoldOk = last ? (last.winRate>=50 && last.avgRet>=0) : true;

    return { n: tradesN, winRate, avgRet, mdd, expectancy, folds, lastFoldOk };
  }


async function analyzeOneTF(symbol, tf){
    // 1) load candles
    const { ohlcv } = await fetchKlinesBackfill(symbol, tf, BACKFILL_LIMIT);
    if(!ohlcv || ohlcv.length < (BT_WARMUP + 5)) {
      return makeEmptyResult(symbol, tf, '데이터 부족');
    }

    // 2) arrays
    const closes = ohlcv.map(x => x.close);
    const highs  = ohlcv.map(x => x.high);
    const lows   = ohlcv.map(x => x.low);
    const vols   = ohlcv.map(x => x.volume);

    // 3) indicators
    const ema20 = ema(closes, EMA_FAST);
    const ema50 = ema(closes, EMA_SLOW);
    const rsi14 = rsi(closes, RSI_LEN);
    const macdObj = macd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    const atr14 = atr(highs, lows, closes, ATR_LEN);
    const volMA = sma(vols, VOL_MA_LEN);
    const adx14 = adx(highs, lows, closes, ADX_LEN);

    const last = ohlcv.length - 1;
    const entry = closes[last]; // spec: entry=current
    const atrNow = atr14[last] || 0;
    const atrPct = entry > 0 ? (atrNow / entry * 100) : 0;

    // 4) regime
    const regimeInfo = classifyRegime(ema20, ema50, adx14, atrPct, last);
    const regime = regimeInfo.regime;

    // 5) signal score ensemble at "now"
    const sig = scoreEnsemble({
      ohlcv, closes, highs, lows, vols,
      ema20, ema50, rsi14, macdObj, atr14, volMA, adx14,
      idx:last,
      regime
    });

    const dir = (sig.longScore >= sig.shortScore) ? 'LONG' : 'SHORT';
    const conf = Math.abs(sig.longScore - sig.shortScore);

    // 6) TP/SL by ATR
    const { tp, sl, tpPct, slPct } = calcTpSl(entry, atrNow, dir);

    // 7) backtest
    const bt = backtestWFO(candles, pred.dir, tp, sl, atr, entry);

    // 8) 신뢰도 경고(강화)
    const warns = [];
    if(bt.n < BT_MIN_SAMPLES) warns.push(`표본부족(N<${BT_MIN_SAMPLES})`);
    if(conf < CONF_LOW_TH) warns.push(`확신도낮음(<${CONF_LOW_TH})`);
    if(atrPct > ATRPCT_HIGH_TH) warns.push(`변동성큼(ATR%>${ATRPCT_HIGH_TH})`);
    if(bt.expectancy < EXP_LOW_TH) warns.push(`기대값낮음(<${EXP_LOW_TH}%)`);
    if(bt.mdd > MDD_HIGH_TH) warns.push(`낙폭큼(MDD>${MDD_HIGH_TH}%)`);
    if(bt.folds && bt.folds.length && bt.lastFoldOk===false) warns.push('최근구간 부진(WFO)');

    const trust = calcTrustLevel(bt, conf, atrPct);

    // 9) reason strings (easy mode)
    const reasonShort = sig.reasonShort;
    const reasonLong = sig.reasonLong;

    return {
      symbol, tf, dir, conf,
      entry, tp, sl, tpPct, slPct,
      regime, regimeInfo: { adx: regimeInfo.adx, atrPct },
      bt, warns, trust, reasonShort, reasonLong,
    };
  }

  function makeEmptyResult(symbol, tf, msg){
    return {
      symbol, tf,
      dir: 'LONG',
      conf: 0,
      entry: 0, tp: 0, sl: 0, tpPct: 0, slPct: 0,
      regime: 'Range',
      regimeInfo: { adx: 0, atrPct: 0 },
      bt: { n:0, winRate:0, avgRet:0, mdd:0, expectancy:0 },
      warns: [msg],
      reasonShort: msg,
      reasonLong: msg,
    };
  }

  function classifyRegime(ema20, ema50, adx14, atrPct, idx){
    const e20 = ema20[idx] || 0;
    const e50 = ema50[idx] || 0;
    const adxV = adx14[idx] || 0;

    // slope: compare to 5 bars ago
    const back = Math.max(0, idx - 5);
    const s20 = (ema20[idx] && ema20[back]) ? (ema20[idx] - ema20[back]) : 0;
    const s50 = (ema50[idx] && ema50[back]) ? (ema50[idx] - ema50[back]) : 0;

    let regime = 'Range';

    // HighVol first
    if(atrPct > ATRPCT_HIGH_TH) regime = 'HighVolatility';
    else{
      const trendStrong = adxV >= 20;
      const up = (e20 >= e50) && (s20 >= 0) && (s50 >= 0);
      const down = (e20 <= e50) && (s20 <= 0) && (s50 <= 0);

      if(trendStrong && up) regime = 'Uptrend';
      else if(trendStrong && down) regime = 'Downtrend';
      else regime = 'Range';
    }

    return { regime, adx: adxV };
  }

  function calcTpSl(entry, atrNow, dir){
    const slDist = atrNow * SL_ATR_MULT;
    const tpDist = atrNow * TP_ATR_MULT;
    let tp, sl;

    if(dir === 'LONG'){
      tp = entry + tpDist;
      sl = entry - slDist;
    }else{
      tp = entry - tpDist;
      sl = entry + slDist;
    }
    const tpPct = entry>0 ? ((tp-entry)/entry*100) : 0;
    const slPct = entry>0 ? ((sl-entry)/entry*100) : 0;
    return { tp, sl, tpPct, slPct };
  }

  // ---------------- Backtest (one-bar horizon, TP/SL within next bar) ----------------
  function backtestOneBar(ctx){
    const nBars = ctx.ohlcv.length;
    const start = BT_WARMUP;
    const end = nBars - 2; // need next bar for exit/TP/SL check
    const trades = [];
    const equity = [1.0];
    let peak = 1.0;
    let mdd = 0;

    // roundtrip cost (simple): fee*2 + slippage + spread
    const costPct = ((settings.feePct||0)*2) + (settings.slippagePct||0) + (settings.spreadPct||0);

    for(let i=start;i<=end;i++){
      // classify regime at i
      const atrNow = ctx.atr14[i] || 0;
      const close = ctx.closes[i];
      const atrPct = close>0 ? (atrNow/close*100) : 0;
      const reg = classifyRegime(ctx.ema20, ctx.ema50, ctx.adx14, atrPct, i).regime;

      const sig = scoreEnsemble({
        ...ctx,
        idx: i,
        regime: reg,
      });

      const dir = (sig.longScore >= sig.shortScore) ? 'LONG' : 'SHORT';
      const entry = ctx.closes[i]; // entry at close of signal bar
      const { tp, sl } = calcTpSl(entry, atrNow, dir);

      // Evaluate next bar outcome
      const nx = i + 1;
      const hi = ctx.highs[nx];
      const lo = ctx.lows[nx];
      const exitClose = ctx.closes[nx];

      let exit = exitClose;
      let outcome = 'TIME'; // time end (bar close)
      // Conservative: if TP and SL both touched in same bar => count SL (loss)
      if(dir === 'LONG'){
        const hitTP = hi >= tp;
        const hitSL = lo <= sl;
        if(hitSL && hitTP){ exit = sl; outcome='SL'; }
        else if(hitTP){ exit = tp; outcome='TP'; }
        else if(hitSL){ exit = sl; outcome='SL'; }
      }else{
        const hitTP = lo <= tp;
        const hitSL = hi >= sl;
        if(hitSL && hitTP){ exit = sl; outcome='SL'; }
        else if(hitTP){ exit = tp; outcome='TP'; }
        else if(hitSL){ exit = sl; outcome='SL'; }
      }

      let retPct = 0;
      if(dir === 'LONG'){
        retPct = (exit - entry) / entry * 100;
      }else{
        retPct = (entry - exit) / entry * 100;
      }
      retPct -= costPct;

      trades.push({ dir, retPct, outcome });
      // equity
      const lastEq = equity[equity.length - 1];
      const nextEq = lastEq * (1 + (retPct / 100));
      equity.push(nextEq);
      if(nextEq > peak) peak = nextEq;
      const dd = (peak - nextEq) / peak * 100;
      if(dd > mdd) mdd = dd;

      if(trades.length >= BT_MAX_TRADES) break;
    }

    const n = trades.length;
    if(n === 0) return { n:0, winRate:0, avgRet:0, mdd:0, expectancy:0 };

    const wins = trades.filter(t => t.retPct > 0);
    const losses = trades.filter(t => t.retPct <= 0);

    const winRate = wins.length / n * 100;
    const avgRet = trades.reduce((a,t)=>a+t.retPct,0)/n;
    const avgWin = wins.length ? (wins.reduce((a,t)=>a+t.retPct,0)/wins.length) : 0;
    const avgLoss = losses.length ? (losses.reduce((a,t)=>a+t.retPct,0)/losses.length) : 0;
    // expectancy = P(win)*avgWin + P(loss)*avgLoss
    const expectancy = (wins.length/n)*avgWin + (losses.length/n)*avgLoss;

    return { n, winRate, avgRet, mdd, expectancy };
  }

  // ---------------- Score Ensemble (rule-based) ----------------
  function scoreEnsemble(ctx){
    const i = ctx.idx;
    const c = ctx.closes[i];
    const e20 = ctx.ema20[i] || 0;
    const e50 = ctx.ema50[i] || 0;
    const rsiV = ctx.rsi14[i] || 50;
    const macdV = ctx.macdObj.macd[i] || 0;
    const sigV  = ctx.macdObj.signal[i] || 0;
    const histV = ctx.macdObj.hist[i] || 0;
    const atrV  = ctx.atr14[i] || 0;
    const vol = ctx.vols[i] || 0;
    const volm = ctx.volMA[i] || 0;
    const volRatio = (volm > 0) ? (vol / volm) : 1;

    // slopes (simple)
    const back = Math.max(0, i - 5);
    const e20s = (ctx.ema20[i] && ctx.ema20[back]) ? (ctx.ema20[i] - ctx.ema20[back]) : 0;
    const e50s = (ctx.ema50[i] && ctx.ema50[back]) ? (ctx.ema50[i] - ctx.ema50[back]) : 0;

    // Divergence (simple pivot-based)
    const div = divergenceSignals(ctx, i);

    // Pattern (simple)
    const pat = patternSignals(ctx, i);

    // Base weights per regime
    const w = getRegimeWeights(ctx.regime);

    let longScore = 0;
    let shortScore = 0;

    // (1) Trend: EMA20/EMA50 + slopes
    if(e20 >= e50) longScore += 1.0 * w.trend; else shortScore += 1.0 * w.trend;
    if(e20s > 0) longScore += 0.6 * w.trend; else if(e20s < 0) shortScore += 0.6 * w.trend;
    if(e50s > 0) longScore += 0.4 * w.trend; else if(e50s < 0) shortScore += 0.4 * w.trend;

    // (2) Momentum: RSI + MACD
    if(rsiV >= 55) longScore += 0.8 * w.momo;
    else if(rsiV <= 45) shortScore += 0.8 * w.momo;

    if(macdV >= sigV) longScore += 0.8 * w.momo; else shortScore += 0.8 * w.momo;
    if(histV > 0) longScore += 0.4 * w.momo; else if(histV < 0) shortScore += 0.4 * w.momo;

    // (3) Volume ratio
    if(volRatio >= 1.2) { longScore += 0.35 * w.vol; shortScore += 0.35 * w.vol; } // confirmation (both)
    else if(volRatio <= 0.8) { /* low volume -> no add */ }

    // (4) Volatility risk (ATR)
    // high ATR% doesn't choose direction but reduces confidence by adding to both side
    const atrPct = c>0 ? (atrV/c*100) : 0;
    if(atrPct > ATRPCT_HIGH_TH) { longScore += 0.25 * w.risk; shortScore += 0.25 * w.risk; }

    // (5) Divergence
    if(div.bull) longScore += 1.0 * w.div;
    if(div.bear) shortScore += 1.0 * w.div;
    if(div.hiddenBull) longScore += 0.6 * w.div;
    if(div.hiddenBear) shortScore += 0.6 * w.div;

    // (6) Pattern (support)
    if(pat.rangeBox) { longScore += 0.25 * w.pat; shortScore += 0.25 * w.pat; }
    if(pat.triUp) longScore += 0.35 * w.pat;
    if(pat.triDown) shortScore += 0.35 * w.pat;

    // Easy reasons
    const reasons = [];
    reasons.push(`EMA20 ${e20>=e50?'≥':'<'} EMA50`);
    reasons.push(`RSI ${formatNum(rsiV,1)}`);
    reasons.push(`MACD ${macdV>=sigV?'상승':'하락'}`);
    reasons.push(`거래량비 ${formatNum(volRatio,2)}`);
    reasons.push(`레짐 ${ctx.regime}`);

    if(div.bull) reasons.push('다이버전스(상승)');
    if(div.bear) reasons.push('다이버전스(하락)');
    if(pat.triUp) reasons.push('삼각수렴(상향)');
    if(pat.triDown) reasons.push('삼각수렴(하향)');

    const reasonShort = reasons.slice(0,4).join(' · ');
    const reasonLong = `근거: ${reasons.join(' / ')}`;

    return { longScore, shortScore, reasonShort, reasonLong };
  }

  function getRegimeWeights(regime){
    // Default weights 1.0. Adjust by regime per spec.
    const w = { trend:1.0, momo:1.0, vol:1.0, risk:1.0, div:1.0, pat:1.0 };
    if(regime === 'Uptrend'){
      w.trend = 1.25; w.momo = 1.20; w.div = 0.90; w.pat = 0.95;
    }else if(regime === 'Downtrend'){
      w.trend = 1.25; w.momo = 1.20; w.div = 0.90; w.pat = 0.95;
    }else if(regime === 'Range'){
      w.trend = 0.85; w.momo = 0.95; w.div = 1.25; w.pat = 1.10;
    }else if(regime === 'HighVolatility'){
      w.risk = 1.30; w.trend = 0.95; w.momo = 0.95; w.div = 0.90; w.pat = 0.90;
    }
    return w;
  }

  // ---------------- Divergence (simple pivot) ----------------
  function divergenceSignals(ctx, idx){
    // Pivot window fixed for simplicity
    const L = 3; // pivot lookback/forward
    if(idx < 10) return { bull:false, bear:false, hiddenBull:false, hiddenBear:false };

    // Find last two pivot lows/highs for price + RSI
    const price = ctx.closes;
    const rsiA = ctx.rsi14;

    const pivL = findLastPivots(price, idx, L, 'low', 2);
    const pivH = findLastPivots(price, idx, L, 'high', 2);
    const rsiPivL = findLastPivots(rsiA, idx, L, 'low', 2);
    const rsiPivH = findLastPivots(rsiA, idx, L, 'high', 2);

    let bull=false, bear=false, hiddenBull=false, hiddenBear=false;

    if(pivL.length>=2 && rsiPivL.length>=2){
      const [p1,p2] = pivL;      // older, newer
      const [r1,r2] = rsiPivL;
      // Regular bullish: price lower low, RSI higher low
      if(price[p2] < price[p1] && rsiA[r2] > rsiA[r1]) bull = true;
      // Hidden bullish: price higher low, RSI lower low (trend continuation)
      if(price[p2] > price[p1] && rsiA[r2] < rsiA[r1]) hiddenBull = true;
    }
    if(pivH.length>=2 && rsiPivH.length>=2){
      const [p1,p2] = pivH;
      const [r1,r2] = rsiPivH;
      // Regular bearish: price higher high, RSI lower high
      if(price[p2] > price[p1] && rsiA[r2] < rsiA[r1]) bear = true;
      // Hidden bearish: price lower high, RSI higher high
      if(price[p2] < price[p1] && rsiA[r2] > rsiA[r1]) hiddenBear = true;
    }

    return { bull, bear, hiddenBull, hiddenBear };
  }

  function findLastPivots(arr, idx, L, type, need){
    const piv = [];
    // scan backwards
    for(let i=idx-1; i>=L && piv.length<need; i--){
      let ok = true;
      for(let j=1;j<=L;j++){
        if(type==='low'){
          if(!(arr[i] <= arr[i-j] && arr[i] <= arr[i+j])) { ok=false; break; }
        }else{
          if(!(arr[i] >= arr[i-j] && arr[i] >= arr[i+j])) { ok=false; break; }
        }
      }
      if(ok) piv.unshift(i);
    }
    return piv;
  }

  // ---------------- Pattern (simple) ----------------
  function patternSignals(ctx, idx){
    // Range box: last 20 bars width small vs ATR
    const win = 20;
    if(idx < win) return { rangeBox:false, triUp:false, triDown:false };
    const start = idx - win + 1;

    let hi = -Infinity, lo = Infinity;
    for(let i=start;i<=idx;i++){
      hi = Math.max(hi, ctx.highs[i]);
      lo = Math.min(lo, ctx.lows[i]);
    }
    const width = hi - lo;
    const atrNow = ctx.atr14[idx] || 0;

    const rangeBox = (atrNow > 0) ? (width <= atrNow * 2.5) : false;

    // Triangle: highs decreasing & lows increasing (very simplified)
    const h1 = ctx.highs[idx - 15], h2 = ctx.highs[idx];
    const l1 = ctx.lows[idx - 15], l2 = ctx.lows[idx];
    const tri = (h2 < h1) && (l2 > l1);
    const triUp = tri && (ctx.closes[idx] > (lo + width*0.6));
    const triDown = tri && (ctx.closes[idx] < (lo + width*0.4));

    return { rangeBox, triUp, triDown };
  }

  // ---------------- Indicators ----------------
  function sma(arr, len){
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for(let i=0;i<arr.length;i++){
      sum += arr[i] || 0;
      if(i >= len) sum -= arr[i-len] || 0;
      if(i >= len-1) out[i] = sum / len;
    }
    return out;
  }

  function ema(arr, len){
    const out = new Array(arr.length).fill(null);
    const k = 2 / (len + 1);
    let prev = null;
    for(let i=0;i<arr.length;i++){
      const v = arr[i];
      if(v == null) { out[i]=prev; continue; }
      if(prev == null){
        prev = v;
      }else{
        prev = (v - prev) * k + prev;
      }
      out[i] = prev;
    }
    return out;
  }

  function rsi(closes, len){
    const out = new Array(closes.length).fill(null);
    let gain = 0, loss = 0;

    for(let i=1;i<closes.length;i++){
      const ch = closes[i] - closes[i-1];
      const up = Math.max(0, ch);
      const dn = Math.max(0, -ch);

      if(i <= len){
        gain += up; loss += dn;
        if(i === len){
          const rs = (loss === 0) ? 100 : (gain / loss);
          out[i] = 100 - (100 / (1 + rs));
        }
      }else{
        gain = (gain*(len-1) + up) / len;
        loss = (loss*(len-1) + dn) / len;
        const rs = (loss === 0) ? 100 : (gain / loss);
        out[i] = 100 - (100 / (1 + rs));
      }
    }
    // fill nulls with 50
    for(let i=0;i<out.length;i++) if(out[i]==null) out[i]=50;
    return out;
  }

  function macd(closes, fast, slow, signalLen){
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const macdLine = closes.map((_,i) => (ef[i] ?? 0) - (es[i] ?? 0));
    const sigLine = ema(macdLine, signalLen);
    const hist = macdLine.map((v,i) => v - (sigLine[i] ?? 0));
    return { macd: macdLine, signal: sigLine, hist };
  }

  function atr(highs, lows, closes, len){
    const tr = new Array(closes.length).fill(0);
    for(let i=0;i<closes.length;i++){
      if(i===0){ tr[i] = highs[i] - lows[i]; continue; }
      const h = highs[i], l = lows[i], pc = closes[i-1];
      tr[i] = Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
    }
    // Wilder's smoothing
    const out = new Array(closes.length).fill(null);
    let prev = 0;
    for(let i=0;i<tr.length;i++){
      if(i < len){
        prev += tr[i];
        if(i === len-1){
          prev = prev / len;
          out[i] = prev;
        }
      }else{
        prev = (prev*(len-1) + tr[i]) / len;
        out[i] = prev;
      }
    }
    for(let i=0;i<out.length;i++) if(out[i]==null) out[i]=out[i-1] ?? 0;
    return out;
  }

  function adx(highs, lows, closes, len){
    const n = closes.length;
    const plusDM = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);
    const tr = new Array(n).fill(0);

    for(let i=1;i<n;i++){
      const upMove = highs[i] - highs[i-1];
      const downMove = lows[i-1] - lows[i];
      plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
      minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
      tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    }

    const atrW = wilderSmooth(tr, len);
    const pDM = wilderSmooth(plusDM, len);
    const mDM = wilderSmooth(minusDM, len);

    const pDI = new Array(n).fill(0);
    const mDI = new Array(n).fill(0);
    const dx  = new Array(n).fill(0);

    for(let i=0;i<n;i++){
      if(atrW[i] === 0){ pDI[i]=0; mDI[i]=0; dx[i]=0; continue; }
      pDI[i] = 100 * (pDM[i] / atrW[i]);
      mDI[i] = 100 * (mDM[i] / atrW[i]);
      const denom = (pDI[i] + mDI[i]);
      dx[i] = denom === 0 ? 0 : (100 * Math.abs(pDI[i]-mDI[i]) / denom);
    }

    const adx = wilderSmooth(dx, len);
    return adx;
  }

  function wilderSmooth(arr, len){
    const out = new Array(arr.length).fill(0);
    let sum = 0;
    for(let i=0;i<arr.length;i++){
      if(i < len){
        sum += arr[i];
        out[i] = (i === len-1) ? (sum/len) : 0;
      }else{
        out[i] = ((out[i-1] * (len-1)) + arr[i]) / len;
      }
    }
    return out;
  }

  // ---------------- Diagnostics overlay ----------------
  function showDiag(){ $('#diagOverlay').classList.remove('hidden'); updateDiagUI(); }
  function hideDiag(){ $('#diagOverlay').classList.add('hidden'); }

  function updateDiagUI(){
    $('#dgLastAction').textContent = state.diag.lastAction || '-';
    $('#dgWs').textContent = state.diag.ws || '미연동';
    $('#dgSel').textContent = `${state.symbol} / ${state.tf}`;

    const hasTicker = tickerMap.size > 0;
    const health = [
      'UI OK',
      (navigator.onLine ? '온라인' : '오프라인'),
      hasTicker ? '시세 OK' : '시세 대기',
      (wsKline && wsKline.readyState===1) ? '캔들 WS OK' : '캔들 WS 대기',
      `트랙 ${trackItems.length}`,
      `서버시차 ${Math.round(serverTimeOffsetMs)}ms`,
    ].join(' · ');
    $('#dgHealth').textContent = health;

    $('#dgErrorBox').textContent =
      state.diag.debug ? (state.diag.errorDetail || state.diag.error || '오류 없음')
                       : (state.diag.error || '오류 없음');
  }

  function setLastAction(txt){ state.diag.lastAction = txt; updateDiagUI(); }

  function setDiagError(msg, detail){
    state.diag.error = msg || '오류 발생';
    state.diag.errorDetail = detail || msg || '오류 발생';
    updateDiagUI();
    saveState();
  }

  function copyDiag(){
    setLastAction('자가진단 복사');
    const payload = {
      app: 'YOPO v3.3 (Step 3)',
      time: new Date().toISOString(),
      lastAction: state.diag.lastAction,
      ws: state.diag.ws,
      selected: { symbol: state.symbol, tf: state.tf },
      tickerSize: tickerMap.size,
      trackCount: trackItems.length,
      error: state.diag.error,
      errorDetail: state.diag.errorDetail,
    };
    const text = JSON.stringify(payload, null, 2);
    navigator.clipboard?.writeText(text).then(() => {
      $('#dgErrorBox').textContent = state.diag.debug ? text : '복사 완료 ✅ (디버그 ON 시 상세 JSON 표시)';
      if(state.diag.debug) $('#dgErrorBox').textContent = text;
    }).catch(() => {
      $('#dgErrorBox').textContent = '복사 실패: 브라우저 권한/환경 문제일 수 있습니다.';
    });
  }

  function formatErrorEvent(e, full){
    const file = e.filename || '(unknown file)';
    const line = e.lineno != null ? e.lineno : '(?)';
    const col = e.colno != null ? e.colno : '(?)';
    const msg = e.message || 'Unknown error';
    const stack = e.error && e.error.stack ? e.error.stack : '';
    if(full) return `${msg}\n@ ${file}:${line}:${col}\n\n${stack}`;
    return `${msg} (@ ${file}:${line})`;
  }

  function formatRejection(e, full){
    const reason = e.reason;
    if(typeof reason === 'string') return reason;
    if(reason && reason.message){
      const stack = reason.stack || '';
      return full ? `${reason.message}\n\n${stack}` : reason.message;
    }
    try{ return full ? JSON.stringify(reason, null, 2) : 'Promise 오류(unhandledrejection)'; }
    catch{ return 'Promise 오류(unhandledrejection)'; }
  }

  function setConnStatus(ok, text){
    const el = $('#connStatus');
    if(!el) return;
    if(ok === true){
      el.classList.remove('warn');
      el.classList.add('ok');
      el.textContent = text || 'OK';
    }else if(ok === false){
      el.classList.add('warn');
      el.classList.remove('ok');
      el.textContent = text || '오류';
    }else{
      el.classList.add('warn');
      el.classList.remove('ok');
      el.textContent = text || '로딩';
    }
  }

  // ---------------- Storage ----------------
  function saveState(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        symbol: state.symbol,
        tf: state.tf,
        diag: { debug: state.diag.debug, lastAction: state.diag.lastAction, ws: state.diag.ws, error: state.diag.error, errorDetail: state.diag.errorDetail },
      }));
    }catch(_){}
  }

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return null;
      return JSON.parse(raw);
    }catch(_){ return null; }
  }

  
  
  // ---------------- Step 10: trade finalizer (TP/SL/TIME/STOP) ----------------
  function costPctNow(){
    return ((settings.feePct||0)*2) + (settings.slippagePct||0) + (settings.spreadPct||0);
  }

  function finalizeTradeFromTrack(t, outcome, exitPrice){
    const costPct = costPctNow();
    const gross = (t.dir==='LONG')
      ? (exitPrice - t.entry)/t.entry*100
      : (t.entry - exitPrice)/t.entry*100;
    const retPct = gross - costPct;

    recordTrade({
      time: new Date().toISOString(),
      symbol: t.symbol,
      tf: t.tf,
      dir: t.dir,
      entry: t.entry,
      exit: exitPrice,
      outcome,
      retPct,
      costPct,
    });
  }


// ---------------- Step 5: settings & stats ----------------
  function loadSettings(){
    try{
      const raw = localStorage.getItem(SETTINGS_KEY);
      if(!raw) return null;
      const obj = JSON.parse(raw);
      return obj;
    }catch(_){ return null; }
  }
  function saveSettings(){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(_){}
  }

  function loadStats(){
    try{
      const raw = localStorage.getItem(STATS_KEY);
      if(!raw) return null;
      return JSON.parse(raw);
    }catch(_){ return null; }
  }
  function saveStats(){
    try{ localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }catch(_){}
  }

  
  function bindResetButtons(){
    const bTracks = document.getElementById('btnResetTracks');
    const bDraw   = document.getElementById('btnResetDraw');
    const bSet    = document.getElementById('btnResetSettings');
    const bAll    = document.getElementById('btnResetAll');

    bTracks?.addEventListener('click', () => {
      setLastAction('추적 초기화');
      trackItems.length = 0;
      renderTrackList();
    });

    bDraw?.addEventListener('click', () => {
      setLastAction('작도 초기화');
      try{ localStorage.removeItem(DRAW_KEY); }catch(_){ }
      drawings = [];
      renderDrawings();
      showToast('작도 초기화 완료 ✅');
    });

    bSet?.addEventListener('click', () => {
      setLastAction('설정 초기화');
      settings = { ...DEFAULT_SETTINGS };
      try{ localStorage.removeItem(SETTINGS_KEY); }catch(_){}
      saveSettings();
      // refresh inputs
      bindCostSettings();
      showToast('설정 초기화 완료 ✅');
    });

    bAll?.addEventListener('click', () => {
      setLastAction('전체 초기화');
      // 1) stats
      stats = { trades: [] };
      saveStats();
      // 2) tracks
      trackItems.length = 0;
      // 3) settings
      settings = { ...DEFAULT_SETTINGS };
      try{ localStorage.removeItem(SETTINGS_KEY); }catch(_){}
      saveSettings();
      // 4) drawings
      try{ localStorage.removeItem(DRAW_KEY); }catch(_){}
      // 5) ui state
      try{ localStorage.removeItem(STORAGE_KEY); }catch(_){}
      renderTrackList();
      renderStats();
      bindCostSettings();
      showToast('전체 초기화 완료 ✅');
    });
  }

  function showToast(msg){
    // very light inline feedback using connStatus
    const el = document.getElementById('connStatus');
    if(!el) return;
    const prev = el.textContent;
    el.textContent = msg;
    el.classList.add('ok');
    setTimeout(()=>{ el.textContent = prev; }, 1200);
  }

function bindCostSettings(){
    const fee = document.getElementById('costFee');
    const slip = document.getElementById('costSlip');
    const spr = document.getElementById('costSpr');
    const btn = document.getElementById('btnSaveCost');
    const reset = document.getElementById('btnResetStats');

    if(fee) fee.value = String(settings.feePct ?? DEFAULT_SETTINGS.feePct);
    if(slip) slip.value = String(settings.slippagePct ?? DEFAULT_SETTINGS.slippagePct);
    if(spr) spr.value = String(settings.spreadPct ?? DEFAULT_SETTINGS.spreadPct);

    btn?.addEventListener('click', () => {
      setLastAction('거래비용 저장');
      settings.feePct = clampNum(parseFloat(fee?.value), 0, 5);
      settings.slippagePct = clampNum(parseFloat(slip?.value), 0, 5);
      settings.spreadPct = clampNum(parseFloat(spr?.value), 0, 5);
      saveSettings();
      // immediately refresh stats display (cost affects future trades; backtest uses current settings)
      renderStats();
      // small feedback
      btn.textContent = '저장됨 ✅';
      setTimeout(() => btn.textContent = '저장', 1200);
    });

    reset?.addEventListener('click', () => {
      setLastAction('통계 초기화');
      stats = { trades: [] };
      saveStats();
      renderStats();
      renderRecent();
    });
  }

  function recordTrade(tr){
    stats.trades.push(tr);
    // keep only recent window for list but keep full history for stats if you want.
    // We'll keep full but cap to 2000 to avoid storage bloat.
    if(stats.trades.length > 2000) stats.trades.splice(0, stats.trades.length - 2000);
    saveStats();
  }

  function renderStats(){
    const trades = stats.trades || [];
    const total = trades.length;
    const wins = trades.filter(t => t.retPct > 0).length;
    const winRate = total ? (wins/total*100) : 0;

    // equity curve for compounded pnl + MDD
    let eq = 1.0;
    let peak = 1.0;
    let mdd = 0;
    for(const t of trades){
      eq *= (1 + (t.retPct/100));
      if(eq > peak) peak = eq;
      const dd = (peak - eq) / peak * 100;
      if(dd > mdd) mdd = dd;
    }
    const pnl = (eq - 1) * 100;
    const avg = total ? (trades.reduce((a,t)=>a+t.retPct,0)/total) : 0;
    const exp = avg; // expectancy ~ average return per trade (%)

    setText('stTotal', String(total));
    setText('stWinRate', formatNum(winRate,1) + '%');
    setText('stPnl', formatNum(pnl,2) + '%');
    setText('stExp', formatNum(exp,3) + '%');
    setText('stMdd', formatNum(mdd,1) + '%');

    renderRecent();
  }

  function renderRecent(){
    const el = document.getElementById('recentList');
    if(!el) return;
    const trades = (stats.trades || []).slice(- (settings.recentN || 10)).reverse();
    if(trades.length === 0){
      el.innerHTML = '<div class="empty">아직 종료된 결과가 없습니다.</div>';
      return;
    }
    el.innerHTML = trades.map(t => {
      const cls = t.retPct >= 0 ? 'oktxt' : 'dngtxt';
      return `
        <div class="recent-item">
          <div class="ri-left">
            <div class="ri-title"><b>${escapeHtml(t.symbol)}</b> · ${escapeHtml(t.tf.toUpperCase())} · ${escapeHtml(t.dir)} · <span class="${cls}">${formatNum(t.retPct,2)}%</span></div>
            <div class="ri-sub">종료: ${escapeHtml(t.outcome)} · 종료가 ${formatPrice(t.exit)} · 비용합계 ${formatNum(t.costPct,3)}%</div>
          </div>
          <div class="ri-right"></div>
        </div>
      `;
    }).join('');
  }

  function setText(id, txt){
    const el = document.getElementById(id);
    if(el) el.textContent = txt;
  }

  function clampNum(x, a, b){
    if(!Number.isFinite(x)) return a;
    return Math.max(a, Math.min(b, x));
  }



  // ---------------- Step 6: server time & candle close ----------------
  async function syncServerTime(){
    const now = Date.now();
    if(now - lastServerSyncAt < 30_000) return; // throttle
    lastServerSyncAt = now;
    try{
      const data = await fetchJSON(`${REST_BASE}/fapi/v1/time`, { timeoutMs: 5000, retries: 1 });
      if(!data || !data.serverTime) return;
      serverTimeOffsetMs = (Number(data.serverTime) || 0) - Date.now();
    }catch(_){}
  }
  function serverNow(){
    return Date.now() + serverTimeOffsetMs;
  }

  function tfMs(tf){
    const sec = ({ '15m':900,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'2w':1209600 })[tf] || 0;
    return sec*1000;
  }

  function getCandleWindow(tf, tMs){
    // Binance candles are UTC aligned.
    // For intraday (15m/1h/4h): align to epoch multiples.
    // For 1d: align to UTC 00:00.
    // For 1w/2w: align to Monday 00:00 UTC (week0 = 1970-01-05).
    const ms = tfMs(tf);
    if(ms <= 0) return { open:tMs, close:tMs };

    const dayMs = 86400*1000;
    const weekMs = 7*dayMs;
    const week0 = Date.UTC(1970,0,5,0,0,0,0); // 1970-01-05 Monday 00:00Z

    if(tf === '1d'){
      const d0 = Date.UTC(new Date(tMs).getUTCFullYear(), new Date(tMs).getUTCMonth(), new Date(tMs).getUTCDate(), 0,0,0,0);
      const open = d0;
      const close = d0 + dayMs;
      return { open, close };
    }

    if(tf === '1w'){
      const k = Math.floor((tMs - week0)/weekMs);
      const open = week0 + k*weekMs;
      const close = open + weekMs;
      return { open, close };
    }

    if(tf === '2w'){
      const k = Math.floor((tMs - week0)/weekMs);
      const k2 = k - (k % 2);
      const open = week0 + k2*weekMs;
      const close = open + 2*weekMs;
      return { open, close };
    }

    // 15m/1h/4h
    const open = Math.floor(tMs / ms) * ms;
    return { open, close: open + ms };
  }


// ---------------- Formatting utils ----------------
  function safeNum(x){
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }

  function formatPrice(p){
    if(!Number.isFinite(p) || p === 0) return '-';
    if(Math.abs(p) >= 1000) return p.toFixed(2);
    if(Math.abs(p) >= 10) return p.toFixed(3);
    return p.toFixed(6);
  }

  function formatPct(p){
    if(!Number.isFinite(p)) return '-';
    const s = p.toFixed(2) + '%';
    return (p > 0 ? '+' : '') + s;
  }

  function formatRemain(sec){
    const s = Math.max(0, sec|0);
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const r = s%60;
    if(h>0) return `${h}h ${m}m ${r}s`;
    if(m>0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function formatNum(x, d){
    const n = Number(x);
    if(!Number.isFinite(n)) return '0';
    return n.toFixed(d ?? 2);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

/* =====================
   Step 4: Live Tracking Engine
   - Multi-track concurrent
   - Updates PnL by ticker price
   - Ends by TP / SL / TF candle close / manual stop
===================== */

const TF_SECONDS = { '15m':900, '1h':3600, '4h':14400, '1d':86400, '1w':604800, '2w':1209600 };

let trackTimer = null;

// override addTrackPlaceholder to full track
const _oldAdd = addTrackPlaceholder;
addTrackPlaceholder = function(payload){
  const id = 'trk_' + Math.random().toString(16).slice(2);
  const now = Date.now();
  const tfSec = TF_SECONDS[payload.tf] || 0;
  // exact candle close based on Binance server time
  const sn = serverNow();
  const win = getCandleWindow(payload.tf, sn);

  trackItems.push({
    id,
    symbol: payload.symbol,
    tf: payload.tf,
    dir: payload.dir,
    entry: payload.entry,
    tp: payload.tp,
    sl: payload.sl,
    conf: payload.conf,
    regime: payload.regime,
    startAt: now,
    endAt: win.close,
    startAt: win.open,
    status: 'RUN',
    lastPrice: payload.entry,
    pnlPct: 0,
  });

  renderTrackList();
  ensureTrackLoop();
};

function ensureTrackLoop(){
  if(trackTimer) return;
  trackTimer = setInterval(updateTracks, 1000);
}

async function updateTracks(){
  await syncServerTime();
  const now = serverNow();
  const costPct = ((settings.feePct||0)*2) + (settings.slippagePct||0) + (settings.spreadPct||0);
  let alive = 0;

  // iterate backwards because we may splice
  for(let i=trackItems.length-1;i>=0;i--){
    const t = trackItems[i];
    if(t.status !== 'RUN') continue;

    const tick = tickerMap.get(t.symbol);
    if(!tick || !tick.price) { alive++; continue; }

    t.lastPrice = tick.price;

    // check TP/SL first (based on real price)
    let outcome = null;
    let exit = null;

    if(t.dir==='LONG'){
      if(t.lastPrice >= t.tp){ outcome='TP'; exit=t.tp; }
      else if(t.lastPrice <= t.sl){ outcome='SL'; exit=t.sl; }
    }else{
      if(t.lastPrice <= t.tp){ outcome='TP'; exit=t.tp; }
      else if(t.lastPrice >= t.sl){ outcome='SL'; exit=t.sl; }
    }

    // time end
    if(!outcome && now >= t.endAt){
      outcome='TIME';
      exit=t.lastPrice;
    }

    // update live pnl (raw, without cost) for display
    const raw = (t.dir==='LONG')
      ? (t.lastPrice - t.entry)/t.entry*100
      : (t.entry - t.lastPrice)/t.entry*100;
    t.pnlPct = raw;

    if(outcome){
      // final return with cost
      const gross = (t.dir==='LONG')
        ? (exit - t.entry)/t.entry*100
        : (t.entry - exit)/t.entry*100;
      const retPct = gross - costPct;

      recordTrade({
        time: new Date().toISOString(),
        symbol: t.symbol,
        tf: t.tf,
        dir: t.dir,
        entry: t.entry,
        exit,
        outcome,
        retPct,
        costPct,
      });

      // remove from active list (ended)
      trackItems.splice(i, 1);
      continue;
    }

    alive++;
  }

  renderTrackList();
  renderStats();

  if(alive===0 && trackItems.length===0){
    clearInterval(trackTimer);
    trackTimer=null;
  }
}

// enhance renderTrackList
const _oldRender = renderTrackList;
renderTrackList = function(){
  const box = document.getElementById('trackList');
  const stopAll = document.getElementById('btnStopAll');
  if(trackItems.length === 0){
    box.innerHTML = `<div class="empty">아직 추적이 없습니다.</div>`;
    stopAll.disabled = true;
    return;
  }
  stopAll.disabled = false;

  const now = Date.now();
  box.innerHTML = trackItems.map(t => {
    const remain = Math.max(0, t.endAt - now);
    const sec = Math.floor(remain/1000);
    const txtRemain = t.status==='RUN' ? formatRemain(sec) : '종료';
    const total = tfMs(t.tf) || 1;
    const pct = Math.max(0, Math.min(100, (1 - (remain/total)) * 100));
    const pnlCls = t.pnlPct>=0 ? 'oktxt':'dngtxt';

    const costPct = ((settings.feePct||0)*2) + (settings.slippagePct||0) + (settings.spreadPct||0);
    return `
      <div class="track-item">
        <div class="ti-left">
          <div class="ti-title"><b>${t.symbol}</b> · ${t.tf.toUpperCase()} · ${t.dir} · <span class="${pnlCls}">${t.pnlPct.toFixed(2)}%</span></div>
          <div class="ti-sub">진입 ${formatPrice(t.entry)} → 현재 ${formatPrice(t.lastPrice)} · 남은시간 ${txtRemain} · 상태 ${t.status} · 비용합계 ${costPct.toFixed(3)}%</div>
          <div class="remainbar"><div style="width:${pct.toFixed(1)}%"></div></div>
        </div>
        <div class="ti-right">
          <button class="btn btn-ghost" data-stop="${t.id}">중지</button>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('[data-stop]').forEach(btn=>{
    btn.onclick=()=>{
      const id=btn.getAttribute('data-stop');
      const idx=trackItems.findIndex(x=>x.id===id);
      if(idx>=0){
        const t = trackItems[idx];
        const tick = tickerMap.get(t.symbol);
        const exitPx = (tick && tick.price) ? tick.price : (t.lastPrice || t.entry);
        finalizeTradeFromTrack(t, 'STOP', exitPx);
        trackItems.splice(idx,1);
        renderTrackList();
        renderStats();
      }
    };
  });
};

})();