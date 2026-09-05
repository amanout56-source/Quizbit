

/* ===================== USER FLOW ===================== */
let session = null; // {test, name, answers:{}, current, startTs, expiresAt, remaining, attemptId, timerHandle, persistent}

async function getLoggedInQuizUser(){
  try{ return typeof qbUser==='function' ? await qbUser() : null; }
  catch(e){ return null; }
}

async function loadPersistentAttempt(testId){
  if(!supabaseClient) return null;
  const user = await getLoggedInQuizUser();
  if(!user) return null;
  try{
    const {data,error}=await supabaseClient.rpc('quizbit_get_active_attempt',{p_test_id:String(testId)});
    if(error){ console.warn('QuizBIT attempt load failed:',error.message); return null; }
    // The RPC returns one JSON object. Normalize an array too so older
    // deployments do not break the resume flow while the migration is applied.
    if(Array.isArray(data)) return data[0] || null;
    return data || null;
  }catch(e){ console.warn('QuizBIT attempt load failed:',e); return null; }
}

async function startTestFlow(testId,mode='live'){
  await loadDB();
  const t = DB.tests.find(x=>x.id===testId);
  if(!t) return;
  session = { test:t, mode:mode==='practice'?'practice':'live', name:'', answers:{}, current:0, startTs:null, expiresAt:null, remaining:null, attemptId:null, timerHandle:null, persistent:false, saving:false };

  // Logged-in users already have a name on file — don't ask again.
  let knownName='';
  try{
    const user=await getLoggedInQuizUser();
    if(user && typeof getProfile==='function'){
      const p=await getProfile(user.id);
      knownName=p?.full_name||p?.display_name||'';
    }
  }catch(e){ /* fall through to the guest name prompt below */ }

  if(knownName){
    session.name=knownName;
    go({name:'instructions'});
    return;
  }
  go({name:'username'});
}
function renderUsername(){
  root.innerHTML = `
    <section class="qb-user-direct-page" style="max-width:420px; margin:0 auto; text-align:center;">
      <div class="eyebrow">Before You Start</div>
      <h1 class="hero" style="font-size:28px;">What should we call you?</h1>
      <p class="lede" style="margin:0 auto 26px;">This is only used to greet you on your results page — nothing else. No account, no login.</p>
      <div class="field"><input id="unameInput" placeholder="Your name" style="text-align:center; font-size:18px; border-bottom:1px solid var(--line);"></div>
      <button class="btn btn-solid" style="margin-top:12px;" onclick="confirmUsername()">Continue</button>
      <div style="margin-top:22px;"><a onclick="go({name:'home'})" style="font-size:12px;color:var(--text-faint);cursor:pointer;">&larr; Back to tests</a></div>
    </section>
  `;
  setTimeout(()=>document.getElementById('unameInput')?.focus(), 50);
}
function confirmUsername(){
  const v = document.getElementById('unameInput').value.trim();
  if(!v){ toast('Please enter a name'); return; }
  session.name = v;
  go({name:'instructions'});
}
async function renderInstructions(){
  const t = session.test;
  root.innerHTML = `
    <section class="qb-user-direct-page">
      <div class="breadcrumb" onclick="go({name:'home'})">&larr; Back to tests</div>
      <div class="eyebrow">Instructions</div>
      <h1 class="hero" style="font-size:28px;">${esc(t.title)}</h1>
    </section>
    <hr class="sep-soft">
    <section style="text-align:left;">
      <div class="eyebrow">Test Information</div>
      <p class="lede" style="white-space:pre-wrap;margin-left:0;margin-right:0;">${esc(t.instructions) || 'No additional instructions provided.'}</p>
      <div class="test-meta" style="margin-top:14px;"><span>${t.questions.length} Questions</span><span>${t.durationMins} minutes</span><span>Full marks ${fullMarks(t)}</span></div>
    </section>
    <hr class="sep-soft">
    <section style="text-align:left;">
      <div class="eyebrow">Marking Scheme</div>
      <p class="lede" style="white-space:pre-wrap;margin-left:0;margin-right:0;">${esc(t.markingSchemeText) || ('+' + t.marksCorrect + ' for each correct answer, ' + t.marksWrong + ' for each wrong answer, ' + t.marksUnattempted + ' for unattempted questions.')}</p>
    </section>
    <hr class="sep-soft">
    <section style="text-align:left;">
      <div class="eyebrow">Syllabus</div>
      <p class="lede" style="white-space:pre-wrap;margin-left:0;margin-right:0;">${esc(t.syllabus) || 'Not specified.'}</p>
    </section>
    <hr class="sep">
    <section style="text-align:left; padding:10px 0 40px;">
      <button id="beginTestBtn" class="btn btn-solid" onclick="beginTest()">Start Test — ${session.name}</button>
      <div id="attemptStatus" style="margin-top:10px;font-size:12px;color:var(--text-faint);"></div>
    </section>
  `;

  // Tell the student if an unfinished attempt already exists.
  const active=await loadPersistentAttempt(t.id);
  if(active?.attempt){
    session.resumeCandidate=active;
    const status=document.getElementById('attemptStatus');
    if(status) status.textContent='An unfinished attempt was found. Starting will continue it from where you left off.';
    const btn=document.getElementById('beginTestBtn');
    if(btn) btn.textContent='Continue Test — ' + session.name;
  }
}

async function beginTest(){
  if(!session || !session.test) return;
  const btn=document.getElementById('beginTestBtn');
  if(btn){ btn.disabled=true; btn.textContent='Loading test…'; }

  const user=await getLoggedInQuizUser();
  let attemptData=null;

  // Authenticated students get server-persisted attempts. Guests retain the
  // original browser-only flow because there is no account to attach an attempt to.
  if(user && supabaseClient){
    try{
      const durationSeconds=Math.max(1,Math.round(Number(session.test.durationMins ?? session.test.duration_mins ?? 0)*60));
      const {data,error}=await supabaseClient.rpc('quizbit_start_or_resume_attempt',{
        p_test_id:String(session.test.id),
        p_duration_seconds:durationSeconds
      });
      if(error) throw error;
      const normalized=Array.isArray(data) ? data[0] : data;
      if(!normalized?.id) throw new Error('Invalid attempt response from Supabase');
      attemptData=normalized;
      session.attemptId=normalized.id;
      session.persistent=true;
      session.startTs=new Date(normalized.started_at).getTime();
      session.expiresAt=new Date(normalized.expires_at).getTime();
      session.current=Math.max(0,Number(normalized.current_question)||0);

      // Load the canonical server state once more so answers/progress are never
      // reconstructed from stale browser state.
      const loaded=await loadPersistentAttempt(session.test.id);
      if(loaded?.attempt?.id===normalized.id || loaded?.id===normalized.id){
        const aobj=loaded.attempt || loaded;
        session.current=Math.max(0,Number(aobj.current_question)||0);
        session.startTs=new Date(aobj.started_at).getTime();
        session.expiresAt=new Date(aobj.expires_at).getTime();
        for(const a of (loaded.answers||[])){
          if(a && a.question_id && a.selected_option !== null && a.selected_option !== undefined){
            session.answers[a.question_id]=Number(a.selected_option);
          }
        }
      }
    }catch(e){
      console.error('QuizBIT persistent attempt start failed:',e);
      toast('Could not save your test session. Please try again.');
      if(btn){ btn.disabled=false; btn.textContent='Start Test — ' + session.name; }
      return;
    }
  }else{
    session.startTs=Date.now();
    session.expiresAt=session.startTs+(Math.max(1,Number(session.test.durationMins ?? session.test.duration_mins ?? 0)*60)*1000);
    session.remaining=Math.max(0,Math.ceil((session.expiresAt-Date.now())/1000));
  }

  if(session.persistent && session.test?.id){
    try{ localStorage.setItem('qb-active-test-id',String(session.test.id)); }catch(e){}
  }

  session.remaining=Math.max(0,Math.ceil((session.expiresAt-Date.now())/1000));
  if(session.remaining<=0){
    toast('This test attempt has already expired.');
    if(btn){ btn.disabled=false; btn.textContent='Start Test — ' + session.name; }
    return;
  }

  go({name:'taking'});
  clearInterval(session.timerHandle);
  session.timerHandle=setInterval(tick,1000);
  if(session.persistent){
    clearInterval(session.progressSaveHandle);
    session.progressSaveHandle=setInterval(saveAttemptProgress,15000);
  }
  tick();
}

function tick(){
  if(!session) return;
  // The server-provided expiry timestamp is authoritative. We never decrement
  // a locally stored counter as the source of truth.
  session.remaining=Math.max(0,Math.ceil((session.expiresAt-Date.now())/1000));
  const el=document.getElementById('timerVal');
  if(el){
    el.textContent=fmtTime(session.remaining);
    if(session.remaining<=60) el.classList.add('low');
    else el.classList.remove('low');
  }
  if(session.remaining<=0){
    clearInterval(session.timerHandle);
    session.timerHandle=null;
    submitTest(true);
  }
}
function fmtTime(s){ s=Math.max(0,Math.floor(Number(s)||0)); const m=Math.floor(s/60), sec=s%60; return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0'); }

function renderTaking(){
  if(!session?.test) return;
  const t = session.test;
  const q = t.questions[session.current];
  if(!q) return;
  root.innerHTML = `
    <div class="test-header">
      <div class="test-header-top">
        <div class="brand" style="font-size:19px;">Quiz<span class="dot">BIT</span></div>
        <div class="timer" id="timerVal">${fmtTime(session.remaining)}</div>
      </div>
      <div class="qgrid">
        ${t.questions.map((qq,i)=>`<div class="qchip ${session.answers[qq.id]!==undefined?'attempted':''} ${i===session.current?'current':''}" onclick="jumpTo(${i})">${i+1}</div>`).join('')}
      </div>
    </div>
    <div class="qbody">
      <div class="eyebrow">Question ${session.current+1} of ${t.questions.length}</div>
      ${q.image_url ? `<img class="qb-test-question-image" src="${esc(q.image_url)}" alt="Question image">` : ''}
      <div class="qtext">${esc(q.text)}</div>
      <div class="optlist">
        ${q.options.map((o,oi)=>`
          <div class="optrow ${session.answers[q.id]===oi?'selected':''}" onclick="selectOpt('${q.id}',${oi})">
            <div class="optletter">${'ABCD'[oi]}</div>
            <div class="opttext">${esc(o)}</div>
          </div>
        `).join('')}
      </div>
      <div class="test-nav">
        <button class="btn btn-ghost btn-sm" onclick="prevQ()" ${session.current===0?'disabled':''}>&larr; Previous</button>
        <button class="btn btn-ghost btn-sm" onclick="clearAns('${q.id}')">Clear Response</button>
        ${session.current===t.questions.length-1
          ? `<button class="btn btn-solid btn-sm" onclick="confirmSubmit()">Submit Test</button>`
          : `<button class="btn btn-sm" onclick="nextQ()">Next &rarr;</button>`}
      </div>
      ${session.persistent ? `<div style="margin-top:14px;text-align:center;font-size:11px;color:var(--text-faint);">Progress saved automatically</div>` : ''}
    </div>
  `;
}

async function saveAttemptAnswer(qid, oi){
  if(!session?.persistent || !session.attemptId || !supabaseClient) return true;
  try{
    const {error}=await supabaseClient.rpc('quizbit_save_attempt_answer',{
      p_attempt_id:session.attemptId,
      p_question_id:String(qid),
      p_selected_option:oi,
      p_marked_for_review:false
    });
    if(error) throw error;
    return true;
  }catch(e){
    console.error('QuizBIT answer save failed:',e);
    toast('Answer could not be saved. Check your connection and try again.');
    return false;
  }
}

async function saveAttemptProgress(){
  if(!session?.persistent || !session.attemptId || !supabaseClient) return true;
  try{
    const {error}=await supabaseClient.rpc('quizbit_save_attempt_progress',{
      p_attempt_id:session.attemptId,
      p_current_question:session.current
    });
    if(error) throw error;
    return true;
  }catch(e){
    console.error('QuizBIT progress save failed:',e);
    toast('Progress could not be saved. Check your connection.');
    return false;
  }
}

async function selectOpt(qid, oi){
  if(!session || session.submitting) return;
  const hadPrevious=Object.prototype.hasOwnProperty.call(session.answers,qid);
  const previous=session.answers[qid];
  session.answers[qid]=oi;
  const ok=await saveAttemptAnswer(qid,oi);
  if(!ok){
    if(hadPrevious) session.answers[qid]=previous;
    else delete session.answers[qid];
    return;
  }
  renderTakingKeepTimer();
}

async function clearAns(qid){
  if(!session) return;
  delete session.answers[qid];
  // NULL represents an explicitly cleared answer in the persistence layer.
  if(session.persistent && session.attemptId && supabaseClient){
    try{
      const {error}=await supabaseClient.rpc('quizbit_save_attempt_answer',{
        p_attempt_id:session.attemptId,
        p_question_id:String(qid),
        p_selected_option:null,
        p_marked_for_review:false
      });
      if(error) throw error;
    }catch(e){
      console.error('QuizBIT answer clear failed:',e);
      toast('Could not save the cleared response.');
      return;
    }
  }
  renderTakingKeepTimer();
}

async function jumpTo(i){
  if(!session || i<0 || i>=session.test.questions.length) return;
  session.current=i;
  await saveAttemptProgress();
  renderTakingKeepTimer();
}

async function nextQ(){
  if(!session) return;
  if(session.current<session.test.questions.length-1) session.current++;
  await saveAttemptProgress();
  renderTakingKeepTimer();
}

async function prevQ(){
  if(!session) return;
  if(session.current>0) session.current--;
  await saveAttemptProgress();
  renderTakingKeepTimer();
}

function renderTakingKeepTimer(){
  if(!session) return;
  renderTaking();
  tick();
}

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') saveAttemptProgress();
});
window.addEventListener('pagehide',()=>{
  if(session?.persistent) saveAttemptProgress();
});

function confirmSubmit(){
  const total = session.test.questions.length;
  const answered = Object.keys(session.answers).length;
  const msg = answered<total ? `You've attempted ${answered} of ${total}. Submit anyway?` : 'Submit your test now?';
  if(confirm(msg)) submitTest(false);
}

async function submitTest(auto){
  if(!session || session.submitting) return;
  session.submitting=true;
  clearInterval(session.timerHandle);
  clearInterval(session.progressSaveHandle);
  session.timerHandle=null;
  session.progressSaveHandle=null;

  const t = session.test;
  let score = 0;
  for(const q of t.questions){
    const a = session.answers[q.id];
    if(a===undefined) score += Number(t.marksUnattempted)||0;
    else if(a===q.correct) score += Number(t.marksCorrect)||0;
    else score += Number(t.marksWrong)||0;
  }
  score = Math.round(score*100)/100;
  const timeTakenSec = Math.max(0,Math.round((Date.now()-session.startTs)/1000));

  // Close the persistent attempt first. This prevents the same unfinished
  // attempt from being resumed after submission.
  if(session.persistent && session.attemptId && supabaseClient){
    try{
      const {error}=await supabaseClient.rpc('quizbit_close_attempt',{
        p_attempt_id:session.attemptId,
        p_status:auto ? 'expired' : 'submitted'
      });
      if(error) throw error;
    }catch(e){
      console.error('QuizBIT attempt close failed:',e);
      session.submitting=false;
      toast('Your submission could not be confirmed. Please check your connection and try again.');
      return;
    }
    try{ localStorage.removeItem('qb-active-test-id'); }catch(e){}
  }

  let results = await getResults(t.id);
  const resultRecord={name:session.name, score, timeTakenSec, ts:Date.now()};
  let resultsSaved=true;
  if(session.mode!=='practice'){
    results.push(resultRecord);
    resultsSaved=await saveResults(t.id, results);
    if(!resultsSaved){
      console.warn('QuizBIT: result leaderboard save failed after attempt close.');
      toast('Test submitted, but leaderboard sync failed.');
    }
  }
  const loggedInUser = await qbUser();
  if(loggedInUser){
    const full = fullMarks(t);
    await qbSaveUserAttempt({
      test_key:t.id,
      test_title:t.title,
      cohort_id:t.cohortId ?? t.cohort_id ?? QB.cohortId ?? null,
      subject:t.subject || t.section || 'General',
      score,
      max_score:full,
      percentage:full>0 ? (score/full)*100 : 0,
      time_taken_seconds:timeTakenSec
    });
  }
  session.finalScore = score;
  session.practiceResult = session.mode==='practice';
  session.allResults = results;
  session.submitting=false;
  go({name:'results'});
}

/* ===================== RESULTS ===================== */
function renderResults(){
  const t = session.test;
  const full = fullMarks(t);
  const pct = full>0 ? (session.finalScore/full)*100 : 0;
  const clamped = Math.max(0, Math.min(100, pct));
  const band = pickBand(t, pct);
  const sorted = [...session.allResults].sort((a,b)=> b.score-a.score || a.timeTakenSec-b.timeTakenSec);
  const rank = sorted.findIndex(r=> r.ts===undefined ? false : (r.name===session.name && r.score===session.finalScore && r.timeTakenSec===session.allResults[session.allResults.length-1].timeTakenSec)) ;
  const myRank = sorted.findIndex(r => r === session.allResults[session.allResults.length-1]) + 1;
  const totalStudents = sorted.length;
  const showName = myRank<=10;
  const r = 54, circumference = 2*Math.PI*r;
  const offset = circumference - (clamped/100)*circumference;
  root.innerHTML = `
    <section class="qb-user-direct-page">
      <div class="eyebrow">${esc(t.title)} — Results</div>
      <div class="ring-wrap">
        <svg width="150" height="150" viewBox="0 0 150 150">
          <circle cx="75" cy="75" r="${r}" stroke="rgba(201,162,39,0.15)" stroke-width="10" fill="none"/>
          <circle cx="75" cy="75" r="${r}" stroke="url(#goldgrad)" stroke-width="10" fill="none"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" transform="rotate(-90 75 75)"/>
          <defs><linearGradient id="goldgrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#c9a227"/><stop offset="100%" stop-color="#f0d17a"/>
          </linearGradient></defs>
          <text x="75" y="72" text-anchor="middle" class="ring-num">${session.finalScore}</text>
          <text x="75" y="92" text-anchor="middle" class="ring-den">/ ${full}</text>
        </svg>
      </div>
      <div class="greet-heading">${esc(band.heading)}</div>
      <div class="greet-msg">${esc(band.message)}</div>
      ${showName ? `<div style="text-align:center; margin-top:14px; color:var(--gold-bright); font-size:13px; letter-spacing:.5px;">🏆 ${esc(session.name)} — you're in the Top 10!</div>` : ''}
      <div class="result-meta">
        <div><div class="n">#${myRank}</div><div class="l">Your Rank</div></div>
        <div><div class="n">${totalStudents}</div><div class="l">Total Attempts</div></div>
        <div><div class="n">${clamped.toFixed(1)}%</div><div class="l">Percentage</div></div>
      </div>
    </section>
    <hr class="sep">
    <section style="text-align:center; padding-bottom:30px;">
      <button class="btn btn-ghost" onclick="session=null; go({name:'home'})">Back to All Tests</button>
    </section>
  `;
}
function pickBand(t, pct){
  const sorted = [...t.thresholds].sort((a,b)=>a.min-b.min);
  for(const b of sorted){ if(pct>=b.min && pct<=b.max) return b; }
  return sorted[sorted.length-1] || {heading:'Test complete', message:'Thanks for taking the test.'};
}
