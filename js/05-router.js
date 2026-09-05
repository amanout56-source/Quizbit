
/* Owner entry point: /admin */
/* Optional account banner for the public experience */
async function qbStartTest(testId){
  await qbTrack('test_start_intent',{test_id:testId,cohort_id:QB.cohortId});
  if(typeof startTestFlow==='function'){
    startTestFlow(testId);
  }else{
    toast('Test flow is unavailable.');
  }
}

async function restorePersistentAttemptOnLoad(){
  if(!supabaseClient) return false;
  const user=await getLoggedInQuizUser();
  if(!user) return false;
  try{
    // The local key is only a routing hint. The actual attempt is still
    // verified server-side through RLS and the authenticated user.
    const hintedTestId=localStorage.getItem('qb-active-test-id');
    let query=supabaseClient.from('quizbit_test_attempts')
      .select('test_id,updated_at')
      .eq('status','in_progress')
      .order('updated_at',{ascending:false})
      .limit(1);
    if(hintedTestId) query=query.eq('test_id',String(hintedTestId));
    let {data,error}=await query.maybeSingle();
    if(error) throw error;

    // If the hint is stale, fall back to the user's latest active attempt.
    if(!data && hintedTestId){
      const fallback=await supabaseClient.from('quizbit_test_attempts')
        .select('test_id,updated_at')
        .eq('status','in_progress')
        .order('updated_at',{ascending:false})
        .limit(1)
        .maybeSingle();
      if(fallback.error) throw fallback.error;
      data=fallback.data;
    }

    if(!data?.test_id){
      localStorage.removeItem('qb-active-test-id');
      return false;
    }

    await loadDB();
    const t=DB.tests.find(x=>String(x.id)===String(data.test_id));
    if(!t){
      console.warn('QuizBIT: active attempt found but test is unavailable:',data.test_id);
      return false;
    }

    const loaded=await loadPersistentAttempt(t.id);
    if(!loaded?.attempt){
      localStorage.removeItem('qb-active-test-id');
      return false;
    }

    session={
      test:t,
      name:'',
      answers:{},
      current:Math.max(0,Number(loaded.attempt.current_question)||0),
      startTs:new Date(loaded.attempt.started_at).getTime(),
      expiresAt:new Date(loaded.attempt.expires_at).getTime(),
      remaining:0,
      attemptId:loaded.attempt.id,
      timerHandle:null,
      progressSaveHandle:null,
      persistent:true,
      saving:false,
      submitting:false
    };

    const profile=typeof getProfile==='function' ? await getProfile(user.id) : null;
    session.name=profile?.full_name||profile?.display_name||'Student';
    for(const a of (loaded.answers||[])){
      if(a && a.question_id && a.selected_option!==null && a.selected_option!==undefined){
        session.answers[a.question_id]=a.selected_option;
      }
    }

    localStorage.setItem('qb-active-test-id',String(t.id));
    session.remaining=Math.max(0,Math.ceil((session.expiresAt-Date.now())/1000));
    if(session.remaining<=0){
      await supabaseClient.rpc('quizbit_close_attempt',{p_attempt_id:session.attemptId,p_status:'expired'});
      localStorage.removeItem('qb-active-test-id');
      return false;
    }

    go({name:'taking'});
    clearInterval(session.timerHandle);
    session.timerHandle=setInterval(tick,1000);
    session.progressSaveHandle=setInterval(saveAttemptProgress,15000);
    tick();
    toast('Test resumed from your saved progress.');
    return true;
  }catch(e){
    console.warn('QuizBIT resume-on-load failed:',e);
    return false;
  }
}

/* ===================== RENDER ROOT ===================== */
let NAV_HISTORY = [];
let RENDER_TOKEN = 0;
function go(view){
  const next=view||{name:'home'};
  const same=VIEW && next && VIEW.name===next.name && JSON.stringify(VIEW)===JSON.stringify(next);
  if(same) return;
  if(VIEW && VIEW.name && VIEW.name!==next.name){
    NAV_HISTORY.push(JSON.parse(JSON.stringify(VIEW)));
    if(NAV_HISTORY.length>25) NAV_HISTORY.shift();
  }
  VIEW = next;
  RENDER_TOKEN++;
  render();
  window.scrollTo(0,0);
}
function goBack(){
  let prev = NAV_HISTORY.pop() || { name:'home' };
  while(NAV_HISTORY.length && prev?.name===VIEW?.name) prev=NAV_HISTORY.pop();
  VIEW = prev;
  RENDER_TOKEN++;
  render();
  window.scrollTo(0,0);
}
window.goBack = goBack;
function render(){
  const path=location.pathname.replace(/\/+$/,'');
  const legacyAdminRequested=path.endsWith('/admin') || new URLSearchParams(location.search).get('admin')==='1';
  if(legacyAdminRequested) return qbAdminGate();
  if(VIEW.name==='home') return renderHome();
  if(VIEW.name==='username') return renderUsername();
  if(VIEW.name==='instructions') return renderInstructions();
  if(VIEW.name==='taking') return renderTaking();
  if(VIEW.name==='results') return renderResults();
  if(VIEW.name==='dashboard') return renderQBDashboard(VIEW);
  if(VIEW.name==='cohorts') return renderQBCohorts(VIEW);
  if(VIEW.name==='cohort') return renderQBCohort(VIEW);
  if(VIEW.name==='account') return renderQBAccount();
  if(VIEW.name==='history') return renderQBHistory();
  if(VIEW.name==='historyResult') return renderQBHistoryResult(VIEW);
  if(VIEW.name==='purchases') return renderQBPurchases();
  if(VIEW.name==='bookmarks') return renderQBBookmarks();
  if(VIEW.name==='notifications') return renderQBNotifications();
  if(VIEW.name==='ownerDash') return renderOwnerDash();
  return renderHome();
}


/* ===================== HEADER ===================== */
/* ===================== HOME ===================== */

/* Owner authentication: Supabase Auth + server-side owner role only. */

/* ===================== OWNER DASHBOARD ===================== */
let draft = null; // draft test being built/edited
function tabBtn(key,label){
  return `<button class="tabbtn ${VIEW.tab===key?'active':''}" onclick="go({name:'ownerDash',tab:'${key}'})">${label}</button>`;
}

function previewQuestionImage(input){
  const file=input?.files?.[0];
  const img=document.getElementById('qImagePreview');
  const status=document.getElementById('qImageStatus');
  if(!file){
    if(img){img.src='';img.style.display='none';}
    if(status) status.textContent='Optional. The image will span the full test width.';
    return;
  }
  if(!file.type.startsWith('image/')){
    input.value='';
    if(status) status.textContent='Please choose an image file.';
    toast('Please choose an image file.');
    return;
  }
  if(file.size > 8*1024*1024){
    input.value='';
    if(status) status.textContent='Question image must be 8 MB or smaller.';
    toast('Question image must be 8 MB or smaller.');
    return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    if(img){img.src=reader.result;img.style.display='block';}
    if(status) status.textContent=`${file.name} · Ready to upload`;
  };
  reader.readAsDataURL(file);
}

async function addQuestion(){
  const text = document.getElementById('qText').value.trim();
  const opts = ['optA','optB','optC','optD'].map(id=>document.getElementById(id).value.trim());
  const correct = Number(document.getElementById('correctSel').value);
  const file = document.getElementById('qImage')?.files?.[0] || null;
  const status = document.getElementById('qImageStatus');
  if(!text || opts.some(o=>!o)){ toast('Fill the question and all 4 options'); return; }

  let image_url='';
  if(file){
    if(file.size > 8 * 1024 * 1024){ toast('Question image must be 8 MB or smaller'); return; }
    if(status) status.textContent='Uploading question image…';
    try{
      const uploaded=await qbUploadQuestionImage(file);
      if(uploaded.error){
        if(status) status.textContent=uploaded.error.message || 'Image upload failed.';
        toast(uploaded.error.message || 'Question image could not be uploaded.');
        return;
      }
      image_url=uploaded.url||'';
    }catch(e){
      console.error('Question image upload failed:',e);
      if(status) status.textContent='Image upload failed.';
      toast('Question image could not be uploaded.');
      return;
    }
  }

  draft.questions.push({id:uid(), text, options:opts, correct, image_url});
  go({name:'ownerDash',tab:'create'});
  toast(image_url ? 'Question added with image' : 'Question added');
}
function removeQuestion(i){ draft.questions.splice(i,1); go({name:'ownerDash',tab:'create'}); }
async function toggleActive(id){ const t=DB.tests.find(t=>t.id===id); t.active=!t.active; await saveTests(); go({name:'ownerDash',tab:'tests'}); }
async function deleteTest(id){ if(!confirm('Delete this test permanently?')) return; DB.tests = DB.tests.filter(t=>t.id!==id); await saveTests(); go({name:'ownerDash',tab:'tests'}); }
