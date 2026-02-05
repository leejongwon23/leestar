
const state={total:0,win:0,lose:0,tracks:[]};

function updateStats(){
  document.getElementById('stTotal').textContent=state.total;
  document.getElementById('stWin').textContent=state.win;
  document.getElementById('stLose').textContent=state.lose;
  const rate = state.total? Math.round((state.win/state.total)*100):0;
  document.getElementById('stRate').textContent=rate+'%';
}

document.getElementById('btnAnalyze').onclick=()=>{
  document.getElementById('analysisFrame').src='analysis.html';
  document.getElementById('analysisModal').classList.remove('hidden');
};
document.getElementById('btnCloseAnalysis').onclick=()=>{
  document.getElementById('analysisModal').classList.add('hidden');
};

document.getElementById('btnTrackStatus').onclick=()=>{
  const box=document.getElementById('trackStatusList');
  box.innerHTML = state.tracks.length? state.tracks.map(t=>'<div>'+t+'</div>').join(''):'추적 없음';
  document.getElementById('trackModal').classList.remove('hidden');
};
document.getElementById('btnCloseTrack').onclick=()=>{
  document.getElementById('trackModal').classList.add('hidden');
};

// demo data
state.total=20; state.win=14; state.lose=6;
state.tracks=['BTCUSDT LONG 진행중','ETHUSDT SHORT 진행중'];
updateStats();
