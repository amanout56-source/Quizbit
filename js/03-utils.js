function uid(){
  try{ if(window.crypto?.randomUUID) return crypto.randomUUID(); }catch(e){}
  return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
}
let QB_TOAST_TIMER=null;
function toast(msg){
  const t=document.getElementById('toast');
  if(!t) return;
  t.textContent=String(msg||'');
  t.classList.add('show');
  clearTimeout(QB_TOAST_TIMER);
  QB_TOAST_TIMER=setTimeout(()=>t.classList.remove('show'),2200);
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString(undefined,{day:'2-digit',month:'short'}) + ' · ' + d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
function isLive(t){ return t.active && (!t.deadline || new Date(t.deadline).getTime() > Date.now()); }
function fullMarks(t){ return (t.questions?.length||0) * (Number(t.marksCorrect)||0); }

const root = document.getElementById('root');
let VIEW = { name:'home' };
let lastFocused = null;
document.addEventListener('focusin', (e)=>{ if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') lastFocused = e.target; });
function insertSymbol(sym){
  if(!lastFocused){ toast('Click into a text field first'); return; }
  const el = lastFocused;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0,start) + sym + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + sym.length;
  el.focus();
  el.dispatchEvent(new Event('input'));
}
const SYMBOLS = ['∫','∬','Σ','Π','√','∛','π','θ','Δ','∞','±','≤','≥','≠','≈','∂','∇','α','β','γ','λ','μ','∈','∴','°','⁰','¹','²','³','ⁿ','ⁱ','½','⅓','×','÷','→','∵','⌊⌋','∑'];
function symbarHtml(){
  return `<div class="symbar">${SYMBOLS.map(s=>`<button type="button" class="symbtn" onclick="insertSymbol('${s.replace("'","\\'")}')">${s}</button>`).join('')}</div>`;
}


/* ===================== QuizBIT CORE ===================== */
const QB = {
  cohortId: null,
  source: new URLSearchParams(location.search).get('source') || '',
  exam: new URLSearchParams(location.search).get('exam') || ''
};

function qbEscape(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
