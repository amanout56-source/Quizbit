
/* Initialization is performed once at the end of the rebuilt application. */
/* Admin access:
   Preferred: https://YOUR-DOMAIN/admin
   Fallback:  https://YOUR-DOMAIN/?admin=1
   The admin entry is never shown in the public UI. */


/* ===================== QUIZBIT PUBLIC FLOW =====================
   New public flow:
   Home -> Find Tests -> Account (or Skip) -> Exam Cohort -> Cohort
   Logged-in users with a saved cohort go straight to that cohort.
   Homepage heading/text remain unchanged; homepage clutter and home ads are removed.
*/
(function(){
  const originalLoadDB = loadDB;

  function profileSelect(){
    return 'id,full_name,display_name,role,exam_cohort_id,exam_cohort_ids';
  }

  const PROFILE_CACHE=new Map();
  const PROFILE_PROMISES=new Map();

  async function getProfile(userId,force=false){
    if(!supabaseClient || !userId) return null;
    const key=String(userId);
    if(!force && PROFILE_CACHE.has(key)) return PROFILE_CACHE.get(key);
    if(!force && PROFILE_PROMISES.has(key)) return PROFILE_PROMISES.get(key);

    const promise=supabaseClient.from('profiles')
      .select(profileSelect())
      .eq('id',userId)
      .maybeSingle()
      .then(({data,error})=>{
        if(error){console.warn('QuizBIT profile read failed:',error.message);return null;}
        const profile=data||null;
        if(profile){
          profile.exam_cohort_ids=Array.isArray(profile.exam_cohort_ids)
            ? profile.exam_cohort_ids
            : (profile.exam_cohort_id ? [profile.exam_cohort_id] : []);
          PROFILE_CACHE.set(key,profile);
        }
        return profile;
      })
      .catch(error=>{console.warn('QuizBIT profile read failed:',error?.message||error);return null;})
      .finally(()=>PROFILE_PROMISES.delete(key));

    PROFILE_PROMISES.set(key,promise);
    return promise;
  }

  async function ensureProfile(user){
    if(!supabaseClient || !user) return null;
    const existing=await getProfile(user.id);
    if(existing) return existing;
    const fullName=String(user.user_metadata?.full_name || '').trim() || null;
    const {data,error}=await supabaseClient.from('profiles').upsert({
      id:user.id,
      full_name:fullName,
      display_name:fullName
    },{onConflict:'id'}).select(profileSelect()).maybeSingle();
    if(error){ console.warn('QuizBIT profile create failed:',error.message); return null; }
    return data || null;
  }

  async function syncPendingCohort(user){
    if(!user || !supabaseClient) return null;
    const pending=localStorage.getItem('qb-pending-cohort');
    if(!pending) return await getProfile(user.id);
    const {error}=await supabaseClient.from('profiles').update({exam_cohort_id:pending}).eq('id',user.id);
    if(!error){ localStorage.removeItem('qb-pending-cohort'); return await getProfile(user.id); }
    console.warn('QuizBIT cohort sync failed:',error.message);
    return await getProfile(user.id);
  }

  window.qbGetProfile=getProfile;
  window.qbEnsureProfile=ensureProfile;

  let QB_COHORT_CACHE=null;
  let QB_COHORT_CACHE_AT=0;
  let QB_COHORT_PROMISE=null;
  const QB_COHORT_CACHE_TTL=5000;

  window.qbInvalidateCohortCache=function(){QB_COHORT_CACHE=null;QB_COHORT_CACHE_AT=0;};

  window.qbGetCohorts=async function(force=false){
    if(!supabaseClient) return {data:[],error:{message:'Supabase is not configured yet.'}};
    const now=Date.now();
    if(!force && QB_COHORT_CACHE && now-QB_COHORT_CACHE_AT<QB_COHORT_CACHE_TTL){
      return {data:QB_COHORT_CACHE,error:null};
    }
    if(!force && QB_COHORT_PROMISE) return QB_COHORT_PROMISE;
    QB_COHORT_PROMISE=supabaseClient.from('exam_cohorts')
      .select('*').eq('active',true).order('created_at',{ascending:true})
      .then(({data,error})=>{
        if(!error){QB_COHORT_CACHE=data||[];QB_COHORT_CACHE_AT=Date.now();}
        return {data:data||[],error};
      })
      .finally(()=>{QB_COHORT_PROMISE=null;});
    return QB_COHORT_PROMISE;
  };

  window.qbGetCohort=async function(id){
    const {data}=await qbGetCohorts();
    return (data||[]).find(c=>String(c.id)===String(id))||null;
  };
  
  window.qbGetLatestTests=async function(cohortId,limit=100){
    await loadDB();
    const tests=(DB.tests||[])
      .filter(t=>t.active!==false && String(t.cohortId)===String(cohortId))
      .sort((a,b)=>new Date(b.createdAt||b.updatedAt||0)-new Date(a.createdAt||a.updatedAt||0));
    return {
      data:tests.slice(0,limit).map(t=>({
        id:t.id,title:t.title,description:t.instructions||'',duration_mins:t.durationMins,
        difficulty:t.difficulty||'Moderate',subject:t.subject||t.section||'General',
        test_type:t.testType||'Full Test',active:t.active,deadline:t.deadline,
        start_time:t.startTime||t.start_time||null,questions:t.questions||[],
        marksCorrect:t.marksCorrect||0,exam:t.exam||t.examName||t.category||'QuizBIT',
        category:qbNormalizeCategory(t),isFree:qbIsFree(t),
        cohortId:t.cohortId,cohortName:t.cohortName||''
      })),
      error:null
    };
  };

  window.renderQBCohort=async function(view){
    const {data,error}=await qbGetLatestTests(view.id,100);
    const cohort=await qbGetCohort(view.id);
    await loadDB();
    const filters={testType:view.filters?.testType||'all',testSize:view.filters?.testSize||'all',status:view.filters?.status||'all'};
    const allTests=data||[];
    const attemptMap=await qbGetUserAttemptMap();
    const user=await getLoggedInQuizUser();
    if(user && supabaseClient){
      await Promise.all(allTests.map(async t=>{
        const key=String(t.id);
        if(attemptMap.get(key)?.completed_at) return;
        try{const active=await loadPersistentAttempt(t.id);if(active) attemptMap.set(key,active);}catch(e){console.warn('QuizBIT cohort active attempt load failed:',e);}
      }));
    }
    const tests=allTests.filter(t=>{
      const type=qbNormalizeTestType(t.test_type||t.testType);
      const testSize=qbNormalizeTestSize(t);
      const attempt=attemptMap.get(String(t.id));
      const attempted=!!attempt;
      return (filters.testType==='all'||type===filters.testType)
        && (filters.testSize==='all'||testSize===filters.testSize)
        && (filters.status==='all'
          || (filters.status==='attempted'&&attempted)
          || (filters.status==='unattempted'&&!attempted));
    });
    root.innerHTML=`
      <section class="qb-user-direct-page qb-cohort-page">
        <div class="qb-direct-back" onclick="go({name:'dashboard'})" role="button" tabindex="0" aria-label="Back to student dashboard" title="Back to dashboard">←</div>
        <div class="qb-cohort-header">
          ${cohort?.logo_url?`<div class="qb-cohort-detail-logo"><img src="${qbEscape(cohort.logo_url)}" alt="${qbEscape(cohort?.name||'Exam')} logo"></div>`:''}
          <div class="eyebrow">${qbEscape(cohort?.category||'Exam cohort')}</div>
          <h1 class="hero">${qbEscape(cohort?.name||'Exam')}</h1>
          <p class="lede">${qbEscape(cohort?.description||'')}</p>
        </div>
      </section>
      <hr class="sep">
      <section class="qb-cohort-tests-content">
        <div class="qb-user-tests-heading">
          <h2 class="qb-user-section-title">All Tests</h2>
          <span class="qb-user-test-count">${tests.length} / ${allTests.length}</span>
        </div>
        <div class="qb-user-filterbar qb-cohort-filterbar" aria-label="Filter tests">
          <label class="qb-user-filter"><span>Test Type</span><select onchange="qbUserCohortSetFilter('testType',this.value)">
            <option value="all" ${filters.testType==='all'?'selected':''}>All Test Types</option>
            <option value="Full Mock Test" ${filters.testType==='Full Mock Test'?'selected':''}>Full Mock Test</option>
            <option value="Subject Test" ${filters.testType==='Subject Test'?'selected':''}>Subject Test</option>
            <option value="Chapter Test" ${filters.testType==='Chapter Test'?'selected':''}>Chapter Test</option>
            <option value="Full Syllabus Mini Tests" ${filters.testType==='Full Syllabus Mini Tests'?'selected':''}>Full Syllabus Mini Tests</option>
          </select></label>
          <label class="qb-user-filter"><span>Test Size</span><select onchange="qbUserCohortSetFilter('testSize',this.value)">
            <option value="all" ${filters.testSize==='all'?'selected':''}>All Test Sizes</option>
            <option value="Full Length Tests" ${filters.testSize==='Full Length Tests'?'selected':''}>Full Length Tests</option>
            <option value="Part Length Tests" ${filters.testSize==='Part Length Tests'?'selected':''}>Part Length Tests</option>
          </select></label>
          <label class="qb-user-filter"><span>Test Status</span><select onchange="qbUserCohortSetFilter('status',this.value)">
            <option value="all" ${filters.status==='all'?'selected':''}>All Tests</option>
            <option value="attempted" ${filters.status==='attempted'?'selected':''}>Attempted</option>
            <option value="unattempted" ${filters.status==='unattempted'?'selected':''}>Unattempted</option>
          </select></label>
        </div>
        ${error?'<div class="center-empty">Unable to load tests.</div>':tests.length?`<div class="qb-cohort-test-list">${tests.map(t=>qbDashboardTestCard(t,attemptMap.get(String(t.id)))).join('')}</div>`:'<div class="center-empty">No tests match these filters.</div>'}
      </section>`;
    await qbTrack('cohort_view',{cohort_id:view.id});
  };

  window.qbUserCohortSetFilter=function(key,value){
    const allowed=['testType','testSize','status'];
    if(!allowed.includes(key)) return;
    VIEW={...(VIEW||{}),name:'cohort',filters:{...(VIEW.filters||{}),[key]:String(value||'all')}};
    render();
    window.scrollTo(0,0);
  };


  window.qbSearchCohorts=async function(term){
    const {data,error}=await qbGetCohorts();
    const needle=String(term||'').trim().toLowerCase();
    return {data:(data||[]).filter(c=>!needle || [c.name,c.category,c.description].some(v=>String(v||'').toLowerCase().includes(needle))),error};
  };

  window.qbGetSavedCohort=async function(){
    const user=await qbUser();
    if(!user) return null;
    const profile=await getProfile(user.id);
    return profile?.exam_cohort_ids?.[0] || profile?.exam_cohort_id || null;
  };

  window.qbSaveCohort=async function(cohortId){
    const user=await qbUser();
    if(!user){
      localStorage.setItem('qb-pending-cohort',cohortId);
      return true;
    }
    if(!supabaseClient) return false;
    await ensureProfile(user);
    const {error}=await supabaseClient.from('profiles').update({exam_cohort_id:cohortId}).eq('id',user.id);
    if(error){
      console.warn('QuizBIT cohort save failed:',error.message);
      localStorage.setItem('qb-pending-cohort',cohortId);
      return false;
    }
    try{ await supabaseClient.from('profiles').update({exam_cohort_ids:[cohortId]}).eq('id',user.id); }catch(e){}
    localStorage.removeItem('qb-pending-cohort');
    return true;
  };

  window.qbSaveCohorts=async function(cohortIds){
    const ids=[...new Set((cohortIds||[]).filter(Boolean).map(String))];
    const user=await qbUser();
    if(!user){
      localStorage.setItem('qb-pending-cohorts',JSON.stringify(ids));
      if(ids[0]) localStorage.setItem('qb-pending-cohort',ids[0]);
      return true;
    }
    if(!supabaseClient) return false;
    await ensureProfile(user);
    const payload={exam_cohort_ids:ids,exam_cohort_id:ids[0]||null};
    const {error}=await supabaseClient.from('profiles').update(payload).eq('id',user.id);
    if(error){
      // The new column may not exist until the migration is run. Preserve
      // single-cohort compatibility instead of breaking the profile page.
      const legacy=await supabaseClient.from('profiles').update({exam_cohort_id:ids[0]||null}).eq('id',user.id);
      if(legacy.error){ console.warn('QuizBIT cohort save failed:',legacy.error.message); return false; }
    }
    localStorage.removeItem('qb-pending-cohorts');
    localStorage.removeItem('qb-pending-cohort');
    return true;
  };

  async function qbSaveUserAttempt(attempt){
    const user=await qbUser();
    if(!user || !supabaseClient) return {ok:false,guest:true};
    const row={
      user_id:user.id,
      test_key:String(attempt.test_key),
      test_title:attempt.test_title||'Untitled Test',
      cohort_id:attempt.cohort_id||null,
      subject:attempt.subject||'General',
      score:Number(attempt.score)||0,
      max_score:Number(attempt.max_score)||0,
      percentage:Number(attempt.percentage)||0,
      time_taken_seconds:Number(attempt.time_taken_seconds)||0,
      completed_at:new Date().toISOString()
    };
    const {data,error}=await supabaseClient.from('quizbit_user_attempts').insert(row).select('*').single();
    if(error){ console.warn('QuizBIT user attempt save failed:',error.message); return {ok:false,error}; }
    if(typeof window.qbInvalidateUserAttemptCache==='function') window.qbInvalidateUserAttemptCache();
    return {ok:true,data};
  }

  async function qbGetUserAttempts(limit=10){
    const user=await qbUser();
    if(!user || !supabaseClient) return {data:[],error:{message:'Please log in first.'}};
    return await supabaseClient.from('quizbit_user_attempts').select('*').eq('user_id',user.id).order('completed_at',{ascending:false}).limit(limit);
  }

  window.qbSaveUserAttempt=qbSaveUserAttempt;
  window.qbGetUserAttempts=qbGetUserAttempts;

  async function qbFindTestByKey(testKey){
    await originalLoadDB();
    return (DB.tests||[]).find(t=>String(t.id)===String(testKey)) || null;
  }

  window.qbRetakeAttempt=async function(testKey){
    const t=await qbFindTestByKey(testKey);
    if(!t){ toast('This test is no longer available.'); return; }
    if(!isLive(t)){ toast('This test has expired.'); return; }
    startTestFlow(t.id);
  };

  window.qbViewHistoryResult=async function(id){
    const {data,error}=await qbGetUserAttempts(50);
    const a=(data||[]).find(x=>x.id===id);
    if(error || !a){ toast('Result could not be loaded.'); return; }
    go({name:'historyResult',id:a.id,attempt:a});
  };

  window.renderQBHistory=async function(){
    const user=await qbUser();
    if(!user){ go({name:'account'}); return; }
    const {data,error}=await qbGetUserAttempts(10);
    root.innerHTML=`
      <section class="qb-user-direct-page qb-history-page">
        <div class="qb-direct-back" onclick="go({name:'dashboard'})" role="button" tabindex="0" aria-label="Back to student dashboard" title="Back to dashboard">←</div>
        <div class="qb-history-header">
          <div class="eyebrow">Test History</div>
          <h1 class="hero">My Tests</h1>
          <p class="lede">Your 10 most recent completed tests. Retake any test that is still live.</p>
        </div>
        <hr class="sep">
        <section class="qb-history-content">
          <div class="qb-history-section-title">All Recent Tests</div>
          ${error ? `<div class="center-empty">Unable to load your test history.</div>` :
            (data||[]).length ? `<div class="qb-history-list">${(data||[]).map(a=>{
              const pct=Number(a.percentage||0).toFixed(1);
              const date=a.completed_at?new Date(a.completed_at).toLocaleString(undefined,{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
              return `<article class="qb-history-card">
                <div style="min-width:0;flex:1">
                  <div class="qb-history-title">${qbEscape(a.test_title||'Test')}</div>
                  <div class="qb-history-meta"><span>${qbEscape(a.subject||'General')}</span><span>${qbEscape(date)}</span><span>${Math.round(Number(a.time_taken_seconds||0)/60)} min</span></div>
                </div>
                <div class="qb-history-score">${qbEscape(String(a.score))} / ${qbEscape(String(a.max_score))}<div style="font-size:10px;font-weight:400;margin-top:3px;text-align:right;">${pct}%</div></div>
                <div class="qb-history-actions"><button class="qb-history-btn" onclick="qbViewHistoryResult('${a.id}')">View Result</button><button class="qb-history-btn" onclick="qbRetakeAttempt('${qbEscape(a.test_key)}')">Retake</button></div>
              </article>`;
            }).join('')}</div>` : `<div class="center-empty">You haven't completed any tests yet.</div>`}
        </section>
      </section>`;
  };

  window.renderQBHistoryResult=async function(view){
    const attempt=view.attempt || (await qbGetUserAttempts(50)).data?.find(x=>x.id===view.id);
    if(!attempt){toast('Result could not be loaded.');go({name:'history'});return;}
    const t=await qbFindTestByKey(attempt.test_key);
    root.innerHTML=`
      <section class="qb-user-direct-page" style="max-width:620px;margin:auto;text-align:center;">
        <div class="breadcrumb" onclick="go({name:'history'})">← My Tests</div>
        <div class="eyebrow">Saved Result</div>
        <h1 class="hero" style="font-size:30px;">${qbEscape(attempt.test_title||t?.title||'Test')}</h1>
        <div class="ring-wrap"><div style="font-family:'JetBrains Mono',monospace;font-size:46px;color:var(--gold-bright);font-weight:700;">${qbEscape(String(attempt.score))} / ${qbEscape(String(attempt.max_score))}</div><div class="qb-v2-muted" style="margin-top:6px;">${Number(attempt.percentage||0).toFixed(1)}%</div></div>
        <div class="result-meta">
          <div><div class="n">${Number(attempt.percentage||0).toFixed(1)}%</div><div class="l">Percentage</div></div>
          <div><div class="n">${Math.round(Number(attempt.time_taken_seconds||0)/60)}m</div><div class="l">Time Taken</div></div>
        </div>
        <div style="margin-top:26px;color:var(--text-faint);font-size:12px;">${attempt.completed_at?qbEscape(new Date(attempt.completed_at).toLocaleString()):''}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:26px;">
          <button class="btn btn-ghost" onclick="go({name:'history'})">Back to My Tests</button>
          ${t&&isLive(t)?`<button class="btn btn-solid" onclick="qbRetakeAttempt('${qbEscape(attempt.test_key)}')">Retake Test</button>`:''}
        </div>
      </section>`;
  };


  window.qbBeginFindTests=async function(){
    const user=await qbUser();
    if(user){
      await syncPendingCohort(user);
      const saved=await qbGetSavedCohort();
      if(saved){ QB.cohortId=saved; go({name:'cohort',id:saved}); return; }
      go({name:'dashboard'}); return;
    }
    VIEW.afterAccount='findTests';
    go({name:'account'});
  };

  window.qbContinueAfterLogin=async function(){
    const user=await qbUser();
    if(!user) return;

    // Owner accounts go directly to the protected dashboard.
    // Supabase Auth + the server-side owner role check are the only gate.
    const owner=await qbRequireOwner();
    if(owner.ok){
      await renderOwnerDash();
      return;
    }

    await syncPendingCohort(user);
    // Students always land on their dashboard after logging in — never dropped
    // straight into a single exam cohort page, even if one was saved previously.
    go({name:'dashboard'});
  };


  window.homeHeaderHtml=function(){
    return `<div class="topbar qb-home-topbar"><div class="brand" onclick="go({name:'home'})" style="cursor:pointer;">Quiz<span class="dot">BIT</span></div><div class="topbar-right"><button class="qb-home-login" onclick="go({name:'account'})" aria-label="Log in">Log in</button></div></div>`;
  };

  window.renderHome=async function(){
    // Authenticated users must never land on the public homepage.
    // Students go straight to their selected-exams hub; owners go to the owner dashboard.
    const loggedInUser=await qbUser().catch(()=>null);
    if(loggedInUser){
      const owner=await qbRequireOwner().catch(()=>({ok:false}));
      if(owner?.ok){
        await renderOwnerDash();
        return;
      }
      await renderQBDashboard({});
      return;
    }

    await originalLoadDB();
    const {data:cohorts=[]}=await qbGetCohorts();
    const cohortMap=Object.fromEntries((cohorts||[]).map(c=>[c.id,c.name]));
    const tests=[...(DB.tests||[])].sort((a,b)=>{
      const aLive=isLive(a), bLive=isLive(b);
      if(aLive!==bLive) return aLive ? -1 : 1;
      const ad=a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      const bd=b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      return ad-bd;
    });

    const homeTestCard=(t)=>{
      const live=isLive(t);
      const exam=cohortMap[t.cohortId] || t.exam || 'SBI PO';
      const subject=t.subject || t.section || 'General';
      const expiry=t.deadline ? fmtDate(t.deadline) : 'No expiry';
      return `<article class="qb-home-test-card">
        <div>
          <div class="qb-home-test-title">${qbEscape(t.title||'Untitled Test')}</div>
          <div class="qb-home-test-info">
            <div class="qb-home-test-info-row"><span class="qb-home-test-label">Exam</span><span class="qb-home-test-value">${qbEscape(exam)}</span></div>
            <div class="qb-home-test-info-row"><span class="qb-home-test-label">Subject</span><span class="qb-home-test-value">${qbEscape(subject)}</span></div>
            <div class="qb-home-test-info-row"><span class="qb-home-test-label">Test Expiry</span><span class="qb-home-test-value">${qbEscape(expiry)}</span></div>
            <div class="qb-home-test-info-row"><span class="qb-home-test-label">Status</span><span class="qb-home-test-value qb-home-test-status ${live?'live':'expired'}">${live?'Live':'Expired'}</span></div>
          </div>
        </div>
        <button class="qb-home-test-start" ${live?'':'disabled'} onclick="event.stopPropagation();${live?`startTestFlow('${t.id}')`:''}">Start Test</button>
      </article>`;
    };

    root.innerHTML=`
      ${homeHeaderHtml()}
      <section style="padding-top:38px;">
        <div class="eyebrow">Live &middot; Timed &middot; No Login Needed</div>
        <h1 class="hero">Take a test. See where you stand.</h1>
        <p class="lede">QuizBIT hosts live knowledge tests across subjects and exams. Pick one, tell us your name, read the rules, and go — no accounts, no clutter.</p>
        <div style="margin-top:28px;text-align:center;">
          <button class="qb-v2-start" onclick="qbBeginFindTests()">Find Tests</button>
        </div>
      </section>

      <hr class="sep">

      <section>
        <div class="eyebrow">All Live Tests</div>
        ${tests.length ? `<div class="qb-home-tests-grid">${tests.map(homeTestCard).join('')}</div>` : `<div class="center-empty">No tests are available at the moment. Check back soon.</div>`}
      </section>`;
    await qbTrack('home_view');
  };

  window.renderQBCohorts=async function(view={}){
    const {data,error}=await qbGetCohorts();
    const user=await qbUser();
    if(!user){ go({name:'account'}); return; }

    let selectedIds=[];
    try{
      const profile=await getProfile(user.id);
      selectedIds=Array.isArray(profile?.exam_cohort_ids)
        ? profile.exam_cohort_ids.map(String).filter(Boolean)
        : (profile?.exam_cohort_id ? [String(profile.exam_cohort_id)] : []);
    }catch(e){ console.warn('QuizBIT all-exams selection load:',e); }

    const selectedSet=new Set(selectedIds);
    const cohorts=(data||[]);
    const card=c=>{
      const id=String(c.id);
      const selected=selectedSet.has(id);
      const logo=c.logo_url||c.logoUrl||'';
      const initials=String(c.name||'Exam').trim().charAt(0).toUpperCase();
      return `<button type="button" class="qb-all-exam-card ${selected?'selected':''}" onclick="qbToggleAllExam('${qbEscape(id)}',this)" aria-pressed="${selected}" aria-label="${selected?'Remove ':'Select '}${qbEscape(c.name||'Exam')}">
        <span class="qb-all-exam-check" aria-hidden="true">${selected?'✓':''}</span>
        <span class="qb-user-cohort-logo">${logo?`<img src="${qbEscape(logo)}" alt="">`:`<span>${qbEscape(initials)}</span>`}</span>
        <span class="qb-all-exam-name">${qbEscape(c.name||'Exam')}</span>
        ${c.category?`<span class="qb-all-exam-category">${qbEscape(c.category)}</span>`:''}
      </button>`;
    };

    root.innerHTML=`
      <section class="qb-all-exams-page qb-all-exams-page-spacious">
        <div class="qb-all-exams-back">
          <button type="button" class="qb-round-btn" onclick="go({name:'dashboard'})" aria-label="Back to student dashboard" title="Back to dashboard">←</button>
        </div>
        <div class="qb-all-exams-head">
          <div class="eyebrow">Exam Library</div>
          <h1 class="hero">All Exams on QuizBIT</h1>
          <p class="lede">Select the exams you want on your dashboard. You can choose more than one.</p>
        </div>
        ${error ? `<div class="center-empty">Unable to load exam cohorts right now.</div>` :
          cohorts.length ? `<div class="qb-all-exams-grid">${cohorts.map(card).join('')}</div>` : `<div class="center-empty">No exam cohorts are available yet.</div>`}
        <div class="qb-all-exams-action">
          <div class="qb-all-exams-selected"><strong id="qb-all-exams-count">${selectedIds.length}</strong> exam${selectedIds.length===1?'':'s'} selected</div>
          <button type="button" class="btn btn-solid qb-add-exams-btn" id="qb-add-exams-btn" onclick="qbAddSelectedExams()" ${!selectedIds.length?'disabled':''}>Add to Dashboard</button>
        </div>
      </section>`;
    await qbTrack('all_exams_view');
  };

  window.qbToggleAllExam=function(id,el){
    const key=String(id);
    if(!window.QB_ALL_EXAM_SELECTION) window.QB_ALL_EXAM_SELECTION=new Set();
    const set=window.QB_ALL_EXAM_SELECTION;
    if(set.has(key)) set.delete(key); else set.add(key);
    if(el){
      const on=set.has(key);
      el.classList.toggle('selected',on);
      el.setAttribute('aria-pressed',String(on));
      const check=el.querySelector('.qb-all-exam-check'); if(check) check.textContent=on?'✓':'';
    }
    const count=set.size;
    const countEl=document.getElementById('qb-all-exams-count');
    if(countEl) countEl.textContent=String(count);
    const label=document.querySelector('.qb-all-exams-selected');
    if(label) label.innerHTML=`<strong id="qb-all-exams-count">${count}</strong> exam${count===1?'':'s'} selected`;
    const btn=document.getElementById('qb-add-exams-btn'); if(btn) btn.disabled=count===0;
  };

  window.qbAddSelectedExams=async function(){
    const ids=[...(window.QB_ALL_EXAM_SELECTION||new Set())].map(String);
    if(!ids.length){toast('Select at least one exam');return;}
    const btn=document.getElementById('qb-add-exams-btn');
    if(btn){btn.disabled=true;btn.textContent='Saving…';}
    const ok=await qbSaveCohorts(ids);
    if(!ok){ if(btn){btn.disabled=false;btn.textContent='Add to Dashboard';} toast('Could not update your dashboard.'); return; }
    window.QB_ALL_EXAM_SELECTION=null;
    toast('Dashboard updated');
    go({name:'dashboard'});
  };

  window.renderQBDashboard=async function(view={}){
    const {data,error}=await qbGetCohorts();

    // Your Exams dashboard: only show cohorts selected on the signed-in profile.
    let selectedIds=Array.isArray(view.selectedIds) ? view.selectedIds.map(String).filter(Boolean) : [];
    try{
      const user=await qbUser();
      if(user){
        const profile=await getProfile(user.id);
        const profileIds=Array.isArray(profile?.exam_cohort_ids)
          ? profile.exam_cohort_ids.map(String).filter(Boolean)
          : (profile?.exam_cohort_id ? [String(profile.exam_cohort_id)] : []);
        if(profileIds.length) selectedIds=profileIds;
      }
    }catch(e){ console.warn('QuizBIT dashboard cohort load:',e); }

    let dashboardName='Student';
    try{
      const user=await qbUser();
      if(user){
        const profile=await getProfile(user.id);
        dashboardName=profile?.full_name||profile?.display_name||user.user_metadata?.full_name||'Student';
      }
    }catch(e){}

    window.QB_ALL_EXAM_SELECTION=new Set(selectedIds);
    const selectedSet=new Set(selectedIds);
    const selected=(data||[]).filter(c=>selectedSet.has(String(c.id)))
      .sort((a,b)=>selectedIds.indexOf(String(a.id))-selectedIds.indexOf(String(b.id)));

    if(!selected.length){
      root.innerHTML=`${studentDashboardHeaderHtml(dashboardName)}<section class="qb-user-dashboard-empty"><div class="eyebrow">Your Dashboard</div><h1 class="hero">Select your Cohort</h1><p class="lede">Choose an exam cohort from your profile to see its tests here.</p><button class="btn btn-solid" onclick="go({name:'cohorts'})">SELECT EXAMS</button></section>`;
      await qbTrack('cohort_directory_view');
      return;
    }

    const activeId=selected.some(c=>String(c.id)===String(view.cohortId))
      ? String(view.cohortId) : String(selected[0].id);
    QB.cohortId=activeId;
    const card=c=>{
      const logo=c.logo_url||c.logoUrl||'';
      return `<button type="button" class="qb-user-cohort-card ${String(c.id)===activeId?'active':''}" onclick="qbUserDashboardSelectCohort('${qbEscape(c.id)}')" aria-label="Select ${qbEscape(c.name)}">
        <div class="qb-user-cohort-logo">${logo?`<img src="${qbEscape(logo)}" alt="">`:`<span>${qbEscape(String(c.name||'E').trim().charAt(0).toUpperCase())}</span>`}</div>
        <div class="qb-user-cohort-name">${qbEscape(c.name||'Exam')}</div>
      </button>`;
    };

    root.innerHTML=`
      ${studentDashboardHeaderHtml(dashboardName)}
      <main class="qb-user-dashboard">
        <section class="qb-user-dashboard-heading">
          <h1 class="hero">Your Exams</h1>
          <button type="button" class="qb-user-manage-exams" onclick="go({name:'cohorts'})">Manage <span aria-hidden="true">›</span></button>
        </section>

        <div class="qb-user-cohort-scroller" role="tablist" aria-label="Your exam cohorts">
          ${selected.map(card).join('')}
        </div>

        <section class="qb-user-tests-panel" id="qb-user-tests-panel" aria-live="polite">
          <div class="qb-user-tests-loading"><span class="qb-user-spinner"></span> Loading tests…</div>
        </section>
      </main>`;

    await qbRenderUserDashboardTests(activeId);
    await qbTrack('cohort_directory_view',{cohort_id:activeId});
  };

  const QB_USER_ATTEMPT_CACHE={value:null,at:0,promise:null};
  async function qbGetUserAttemptMap(){
    const now=Date.now();
    if(QB_USER_ATTEMPT_CACHE.value && now-QB_USER_ATTEMPT_CACHE.at<15000) return QB_USER_ATTEMPT_CACHE.value;
    if(QB_USER_ATTEMPT_CACHE.promise) return QB_USER_ATTEMPT_CACHE.promise;
    QB_USER_ATTEMPT_CACHE.promise=(async()=>{
      const user=await qbUser();
      if(!user || !supabaseClient) return new Map();
      try{
        const {data,error}=await supabaseClient.from('quizbit_user_attempts')
          .select('test_key,completed_at,score,percentage,time_taken_seconds')
          .eq('user_id',user.id).order('completed_at',{ascending:false}).limit(5000);
        if(error) throw error;
        const map=new Map();
        (data||[]).forEach(r=>{
          const key=String(r.test_key||'');
          if(key && !map.has(key)) map.set(key,r);
        });
        QB_USER_ATTEMPT_CACHE.value=map;
        QB_USER_ATTEMPT_CACHE.at=Date.now();
        return map;
      }catch(e){
        console.warn('QuizBIT user attempt status load failed:',e?.message||e);
        return new Map();
      }
    })().finally(()=>{QB_USER_ATTEMPT_CACHE.promise=null;});
    return QB_USER_ATTEMPT_CACHE.promise;
  }
  async function qbGetUserAttemptedTestKeys(){
    const map=await qbGetUserAttemptMap();
    return new Set(map.keys());
  }
  window.qbInvalidateUserAttemptCache=function(){ QB_USER_ATTEMPT_CACHE.value=null; QB_USER_ATTEMPT_CACHE.at=0; };

  function qbNormalizeTestType(value){
    const v=String(value||'').trim().toLowerCase();
    if(v==='full test'||v==='full mock test'||v==='full mock') return 'Full Mock Test';
    if(v==='sectional test'||v==='subject test'||v==='subject') return 'Subject Test';
    if(v==='topic test'||v==='chapter test'||v==='chapter') return 'Chapter Test';
    if(v==='mini test'||v==='full syllabus mini tests'||v==='full syllabus mini test'||v==='mini') return 'Full Syllabus Mini Tests';
    return String(value||'Other');
  }
  function qbNormalizeDifficulty(value){
    const v=String(value||'').trim().toLowerCase();
    if(v==='easy') return 'Easy';
    if(v==='moderate'||v==='medium'||v==='mediocre') return 'mediocre';
    if(v==='hard'||v==='tough'||v==='mixed'||v==='difficult') return 'Tough';
    return String(value||'Other');
  }
  function qbNormalizeTestSize(test){
    const explicit=String(test?.test_size||test?.testSize||'').trim().toLowerCase();
    if(explicit==='part length tests'||explicit==='part length test'||explicit==='part length'||explicit==='part test'||explicit==='part') return 'Part Length Tests';
    if(explicit==='full length tests'||explicit==='full length test'||explicit==='full length mock tests'||explicit==='full length mock test'||explicit==='full mock test'||explicit==='full test'||explicit==='full length') return 'Full Length Tests';
    const type=String(test?.test_type||test?.testType||'').trim().toLowerCase();
    if(type==='full mock test'||type==='full test'||type==='full length mock test'||type==='full length tests') return 'Full Length Tests';
    return '';
  }
  function qbTestCardState(t,attempt){
    const now=Date.now();
    const start=t.start_time ? new Date(t.start_time).getTime() : (t.startTime ? new Date(t.startTime).getTime() : null);
    const end=t.deadline ? new Date(t.deadline).getTime() : null;
    const completed=attempt?.completed_at ? new Date(attempt.completed_at).getTime() : null;
    if(completed) return 'completed';
    if(start && now < start) return 'upcoming';
    if(end && now <= end && t.active!==false) return 'live';
    if(end && now > end) return 'missed';
    return t.active===false ? 'missed' : 'upcoming';
  }

  function qbFormatTestWindow(t){
    const start=t.start_time ? new Date(t.start_time) : (t.startTime ? new Date(t.startTime) : null);
    const end=t.deadline ? new Date(t.deadline) : null;
    const fmt=d=>d?d.toLocaleString(undefined,{day:'2-digit',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'—';
    if(start && end) return `${fmt(start)} → ${fmt(end)}`;
    if(start) return `Starts ${fmt(start)}`;
    if(end) return `Ends ${fmt(end)}`;
    return 'Schedule not set';
  }

  function qbDashboardTestCard(t,attempt){
    const state=qbTestCardState(t,attempt);
    const completed=!!attempt?.completed_at;
    const active=!!attempt && !completed;
    let label,cls,action,handler;
    if(completed){label='Results Declared';cls='results';action='View Analysis';handler=`qbViewUserTestResult('${qbEscape(t.id)}')`;}
    else if(state==='live'||state==='upcoming'){label='Live';cls='live';action=active?'Resume Test':'Attempt Now';handler=`qbStartTest('${qbEscape(t.id)}')`;}
    else{label='Missed';cls='missed';action=active?'Resume Test':'Attempt Now';handler=active?`qbStartPracticeTest('${qbEscape(t.id)}')`:`qbStartPracticeTest('${qbEscape(t.id)}')`;}
    const questions=(t.questions||[]).length;
    const marks=questions*(Number(t.marksCorrect)||0);
    const minutes=Number(t.duration_mins||t.durationMins)||0;
    const start=t.start_time?new Date(t.start_time):(t.startTime?new Date(t.startTime):null);
    const end=t.deadline?new Date(t.deadline):null;
    const fmt=d=>d?d.toLocaleString(undefined,{day:'2-digit',month:'short',hour:'numeric',minute:'2-digit'}):'';
    let windowText='Schedule not set';
    if(start&&end) windowText=`${fmt(start)} &#8212; ${fmt(end)}`;
    else if(start) windowText=`Starts ${fmt(start)}`;
    else if(end) windowText=`Ends ${fmt(end)}`;
    return `<article class="qb-test-card"><div class="content-wrap"><div class="main-info"><div class="chip ${cls}"><span class="dot"></span>${label}</div><div class="test-name">${qbEscape(t.title||'Untitled Test')}</div><div class="details"><div class="detail"><svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12h7M9 15.5h7"/></svg>${questions} Questions &#8226; ${marks} Marks &#8226; ${minutes} Minutes</div><div class="detail clock"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.2 1.9"/></svg>${windowText}</div></div></div></div><div class="action"><a class="${completed?'analysis':active?'resume':'attempt'}" href="javascript:void(0)" onclick="${handler}"><span class="circle">&#8594;</span>${action}</a></div></article>`;
  }

  window.qbStartPracticeTest=async function(testId){
    const test=DB.tests.find(t=>String(t.id)===String(testId));
    if(!test){toast('Test not found');return;}
    await qbTrack('late_test_resume',{test_id:testId,cohort_id:QB.cohortId});
    if(typeof startTestFlow==='function') startTestFlow(testId,'practice'); else toast('Test flow is unavailable.');
  };

  window.qbViewUserTestResult=function(testId){
    const test=DB.tests.find(t=>String(t.id)===String(testId));
    if(!test){toast('Test not found');return;}
    (async()=>{
      const {data,error}=await qbGetUserAttempts(50);
      const r=(data||[]).find(x=>String(x.test_key)===String(testId));
      if(error||!r){toast('Result not found');return;}
      if(typeof renderQBHistoryResult==='function'){
        await renderQBHistoryResult({name:'historyResult',id:r.id,attempt:r});
      }else{
        toast(`Score ${Number(r.score||0)}/${Number(r.max_score||fullMarks(test)||0)} · ${Number(r.percentage||0).toFixed(1)}%`);
      }
    })();
  };

  async function qbRenderUserDashboardTests(cohortId){
    const panel=document.getElementById('qb-user-tests-panel');
    if(!panel) return;
    const {data,error}=await qbGetLatestTests(cohortId,100);
    if(error){ panel.innerHTML='<div class="center-empty">Unable to load tests right now. Please try again.</div>'; return; }

    const attemptMap=await qbGetUserAttemptMap();
    const allTests=data||[];
    const user=await getLoggedInQuizUser();
    if(user && supabaseClient){
      await Promise.all(allTests.map(async t=>{
        const key=String(t.id);
        if(attemptMap.get(key)?.completed_at) return;
        try{const active=await loadPersistentAttempt(t.id);if(active) attemptMap.set(key,active);}catch(e){console.warn('QuizBIT dashboard active attempt load failed:',e);}
      }));
    }

    const tests=allTests;
    const count=tests.length;
    panel.innerHTML=`
      <div class="qb-user-tests-heading">
        <h2 class="qb-user-section-title">All Tests</h2>
        <button type="button" class="qb-view-all-tests" onclick="go({name:'cohort',id:'${qbEscape(cohortId)}'})">View All <span aria-hidden="true">›</span></button>
      </div>
      <section class="qb-mock-tests-section" aria-label="QuizBIT Mock Tests">
        <div class="qb-mock-header-row"><h3 class="qb-mock-tests-subheader">QuizBIT Mock Tests</h3></div>
        <div class="qb-mock-tests-grid">
          <button type="button" class="qb-mock-test-card" onclick="go({name:'cohort',id:'${qbEscape(cohortId)}',filters:{testType:'all',testSize:'Full Length Tests',status:'all'}})" aria-label="Full Tests"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="2"></rect><path d="M8.5 8h7M8.5 12h7M8.5 16h4"></path><path d="M8 3.5V2.5h8v1"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Full Tests</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'quizbit_mock')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
          <button type="button" class="qb-mock-test-card" onclick="go({name:'cohort',id:'${qbEscape(cohortId)}',filters:{testType:'all',testSize:'Part Length Tests',status:'all'}})" aria-label="Part Tests"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M12 4v16M4 12h16"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Part Tests</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'quizbit_part')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
        </div>
      </section>
      <section class="qb-dashboard-content-section" aria-label="QuizBIT Weekly Challenges">
        <h3 class="qb-dashboard-section-heading no-divider">QuizBIT Weekly Challenges <span class="qb-free-tag">Free</span></h3>
        <div class="qb-mock-tests-grid">
          <button type="button" class="qb-mock-test-card" onclick="toast('Part Syllabus Challenges will be available here.')" aria-label="Part Syllabus Challenges"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4.5h12v15H6z"></path><path d="M9 8h6M9 12h4"></path><path d="M15 15l1.5 1.5 2.5-3"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Part Syllabus Challenges</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'part_syllabus_challenge')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
          <button type="button" class="qb-mock-test-card" onclick="toast('Subject Based Challenges will be available here.')" aria-label="Subject Based Challenges"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v5l3.5 2"></path><path d="M8 4.5l1.5 1.5M16 4.5l-1.5 1.5"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Subject Based Challenges</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'subject_challenge')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
          <button type="button" class="qb-mock-test-card" onclick="toast('Full Syllabus Challenges will be available here.')" aria-label="Full Syllabus Challenges"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M8.5 8h7M8.5 12h7M8.5 16h4"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Full Syllabus Challenges</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'full_syllabus_challenge')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
        </div>
      </section>
      <section class="qb-dashboard-content-section" aria-label="PYQs as Mock Tests">
        <h3 class="qb-dashboard-section-heading no-divider">PYQs as Mock Tests</h3>
        <div class="qb-mock-tests-grid">
          <button type="button" class="qb-mock-test-card" onclick="toast('Previous Years Papers will be available here.')" aria-label="Previous Years Papers (2020-26)"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h8l3 3v14H7z"></path><path d="M15 3.5v4h3M9.5 11h6M9.5 14.5h6M9.5 18h4"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">Previous Years Papers (2020-26)</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'previous_year')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
          <button type="button" class="qb-mock-test-card" onclick="toast('PYQ Replica Mock Tests will be available here.')" aria-label="PYQ Replica Mock Tests"><span class="qb-mock-test-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M8.5 8h7M8.5 12h7M8.5 16h7"></path><path d="M16.5 3v3"></path><path d="M18 16.5l1.5 1.5"></path></svg></span><span class="qb-mock-test-copy"><span class="qb-mock-test-name">PYQ Replica Mock Tests</span><span class="qb-mock-test-count">${qbCardCountText(allTests,'pyq_replica')}</span></span><span class="qb-mock-test-arrow" aria-hidden="true">›</span></button>
        </div>
      </section>
      <div class="qb-user-test-list">
        ${tests.length ? tests.map(t=>qbDashboardTestCard(t,attemptMap.get(String(t.id)))).join('') : '<div class="qb-user-no-tests qb-user-test-empty">No tests available yet.</div>'}
      </div>`;
  }

  window.qbUserDashboardSelectCohort=function(id){
    const nextId=String(id||'');
    if(!nextId) return;
    QB.cohortId=nextId;
    VIEW={...(VIEW||{}),name:'dashboard',cohortId:nextId};
    RENDER_TOKEN++;
    render();
    window.scrollTo(0,0);
  };
  window.qbUserDashboardSetFilter=function(){};

  window.qbSelectCohort=function(id){ qbUserDashboardSelectCohort(id); };


  async function qbOpenEditProfile(){
    const user=await qbUser();
    if(!user) return;
    const p=await getProfile(user.id);
    const name=p?.full_name||p?.display_name||user.user_metadata?.full_name||'';
    const ids=p?.exam_cohort_ids?.length ? p.exam_cohort_ids : (p?.exam_cohort_id?[p.exam_cohort_id]:[]);
    const {data:cohorts=[]}=await qbGetCohorts();
    const overlay=document.createElement('div');
    overlay.className='qb-edit-overlay';
    overlay.id='qb-edit-profile-overlay';
    overlay.innerHTML=`
      <div class="qb-edit-sheet qb-edit-profile-sheet" role="dialog" aria-modal="true" aria-label="Edit profile">
        <div class="qb-edit-sheet-head">
          <div class="qb-edit-sheet-title">Edit profile</div>
          <button class="qb-edit-close" onclick="document.getElementById('qb-edit-profile-overlay')?.remove()">×</button>
        </div>
        <div class="field"><label>Full name</label><input id="qb-edit-full-name" value="${qbEscape(name)}" maxlength="80" autocomplete="name"></div>
        <div class="field"><label>Email address</label><input id="qb-edit-email" type="email" value="${qbEscape(user.email||'')}" autocomplete="email"></div>
        <div class="field"><label>Exams you're targeting</label>
          <div class="qb-edit-exams">
            ${(cohorts||[]).map(c=>`<label class="qb-edit-exam-row"><input type="checkbox" value="${qbEscape(c.id)}" ${ids.some(x=>String(x)===String(c.id))?'checked':''}><span>${qbEscape(c.name)}</span></label>`).join('') || '<div class="qb-v2-muted">No exam cohorts available yet.</div>'}
          </div>
        </div>
        <div class="qb-edit-actions">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('qb-edit-profile-overlay')?.remove()">Cancel</button>
          <button class="btn btn-solid btn-sm" onclick="qbSaveProfileEdit()">Save changes</button>
        </div>
        <div id="qb-edit-error" class="pin-error" style="margin-top:10px;height:auto;"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  window.qbOpenEditProfile=qbOpenEditProfile;

  window.qbSaveProfileEdit=async function(){
    const user=await qbUser();
    const name=document.getElementById('qb-edit-full-name')?.value.trim();
    const email=document.getElementById('qb-edit-email')?.value.trim().toLowerCase();
    const ids=[...document.querySelectorAll('#qb-edit-profile-overlay input[type="checkbox"]:checked')].map(x=>x.value);
    const e=document.getElementById('qb-edit-error');
    if(e)e.textContent='';
    if(!user)return;
    if(!name || name.length<2){if(e)e.textContent='Please enter your full name.';return;}
    if(!/^\S+@\S+\.\S+$/.test(email||'')){if(e)e.textContent='Please enter a valid email address.';return;}
    if(!supabaseClient){if(e)e.textContent='Supabase is not configured yet.';return;}
    const {error:profileError}=await supabaseClient.from('profiles').update({full_name:name,display_name:name,exam_cohort_ids:ids,exam_cohort_id:ids[0]||null}).eq('id',user.id);
    if(profileError){
      const legacy=await supabaseClient.from('profiles').update({full_name:name,display_name:name,exam_cohort_id:ids[0]||null}).eq('id',user.id);
      if(legacy.error){if(e)e.textContent=profileError.message;return;}
    }
    PROFILE_CACHE.delete(String(user.id));
    PROFILE_PROMISES.delete(String(user.id));
    if(email!==String(user.email||'').toLowerCase()){
      const {error:emailError}=await supabaseClient.auth.updateUser({email});
      if(emailError){if(e)e.textContent=emailError.message;return;}
      toast('Profile updated. Check your email to confirm the new address.');
    }else toast('Profile updated.');
    try{await supabaseClient.auth.updateUser({data:{full_name:name}});}catch(err){}
    document.getElementById('qb-edit-profile-overlay')?.remove();
    render();
  };

  window.renderQBAccount=async function(){
    // Account/owner login must never render underneath the student menu.
    // Closing it here also covers navigation to the account view from any
    // menu action, not only the /admin entry point.
    if(typeof qbCloseMenu==='function') qbCloseMenu();
    const user=await qbUser();
    if(user){
      await ensureProfile(user);
      const owner=await qbRequireOwner();
      if(owner.ok){ await renderOwnerDash(); return; }
      const p=await getProfile(user.id);
      const name=p?.full_name||p?.display_name||user.user_metadata?.full_name||'Your account';
      const ids=p?.exam_cohort_ids?.length ? p.exam_cohort_ids : (p?.exam_cohort_id?[p.exam_cohort_id]:[]);
      const {data:cohorts=[]}=await qbGetCohorts();
      const selected=(cohorts||[]).filter(c=>ids.some(x=>String(x)===String(c.id)));
      const firstExam=selected[0]?.name || '';
      const otherCount=Math.max(0, selected.length-1);
      const examSummary=firstExam
        ? `${qbEscape(firstExam)}${otherCount ? `, <button type="button" class="qb-profile-other-exams" onclick="event.stopPropagation();go({name:'cohorts',selectedIds:${JSON.stringify(selected.map(c=>c.id)).replace(/</g,'\u003c')}})">${otherCount} other exam${otherCount===1?'':'s'}</button>` : ''}`
        : 'No exams selected yet';
      const initial=(name||user.email||'?').trim().charAt(0).toUpperCase();
      root.innerHTML=`
        <div class="qb-profile-screen">
          <div class="qb-profile-screen-head">
            <div class="qb-profile-screen-title">My Profile</div>
            <button class="qb-profile-close" onclick="go({name:'dashboard'})" aria-label="Back to user dashboard" title="Back to dashboard">←</button>
          </div>
          <section class="qb-profile-main-card">
            <div class="qb-profile-user-row">
              <div class="qb-profile-user-avatar">${qbEscape(initial)}</div>
              <div class="qb-profile-user-info">
                <div class="qb-profile-user-name">${qbEscape(name)}</div>
                <div class="qb-profile-user-exams"><span>Exams:</span> ${examSummary}</div>
                <div class="qb-profile-user-email">${qbEscape(user.email||'')}</div>
              </div>
              <button class="qb-profile-edit-btn" onclick="qbOpenEditProfile()">Edit <span>›</span></button>
            </div>
          </section>
          <button class="qb-profile-logout-wide" onclick="qbSignOut().then(()=>go({name:'home'}))">Log out <span>↪</span></button>
        </div>`;
      return;
    }
    root.innerHTML=`
      <div class="qb-login-shell">
        <button class="qb-login-close" onclick="goBack()" aria-label="Close login">×</button>
        <div class="qb-login-card">
          <div class="qb-login-brand">Quiz<span>BIT</span></div>
          <div class="qb-login-heading">Welcome to QuizBIT</div>
          <p class="qb-login-sub">Log in to save your exam preferences, test history and bookmarks.</p>
          <div class="qb-account-tabs">
            <button id="qb-create-tab" class="btn btn-solid btn-sm" onclick="qbShowAccountMode('create')">Create Account</button>
            <button id="qb-login-tab" class="btn btn-ghost btn-sm" onclick="qbShowAccountMode('login')">Log In</button>
          </div>
          <div id="qb-create-form" style="margin-top:22px;">
            <div class="field"><label>Full name</label><input id="qb-full-name" autocomplete="name" maxlength="80" placeholder="Enter your full name"></div>
            <div class="field"><label>Email</label><input id="qb-email" type="email" autocomplete="email" placeholder="you@example.com"></div>
            <div class="field"><label>Password</label><input id="qb-password" type="password" autocomplete="new-password" placeholder="Create a strong password"></div>
            <div class="qb-password-hint">At least 8 characters, including a letter, a number and a special character.</div>
            <button class="btn btn-solid" style="margin-top:18px;width:100%;" onclick="qbCreateAccount()">Continue</button>
          </div>
          <div id="qb-login-form" style="display:none;margin-top:22px;">
            <div class="field"><label>Email</label><input id="qb-login-email" type="email" autocomplete="username"></div>
            <div class="field"><label>Password</label><input id="qb-login-password" type="password" autocomplete="current-password"></div>
            <button class="btn btn-solid" style="margin-top:18px;width:100%;" onclick="qbLoginAccount()">Log In</button>
            <div style="margin-top:14px;text-align:center;"><button class="btn btn-ghost btn-sm" onclick="qbStartPasswordRecovery()">Forgot password?</button></div>
          </div>
          <div id="qb-account-error" class="pin-error" style="margin-top:14px;"></div>
          <div class="qb-login-skip"><button class="btn btn-ghost btn-sm" onclick="go({name:'dashboard'})">Continue as guest</button></div>
        </div>
      </div>`;
  };

  window.qbShowAccountMode=function(mode){
    const create=document.getElementById('qb-create-form');
    const login=document.getElementById('qb-login-form');
    const ct=document.getElementById('qb-create-tab');
    const lt=document.getElementById('qb-login-tab');
    if(!create||!login)return;
    const isCreate=mode==='create';
    create.style.display=isCreate?'block':'none';
    login.style.display=isCreate?'none':'block';
    ct.className=isCreate?'btn btn-solid btn-sm':'btn btn-ghost btn-sm';
    lt.className=isCreate?'btn btn-ghost btn-sm':'btn btn-solid btn-sm';
  };

  window.qbStartPasswordRecovery=async function(){
    const email=document.getElementById('qb-login-email')?.value.trim() || '';
    root.innerHTML=`
      <section class="qb-user-direct-page" style="max-width:520px;margin:auto;">
        <div class="eyebrow">Account Recovery</div>
        <h1 class="hero" style="font-size:30px;">Reset your password</h1>
        <p class="lede">Enter your account email. QuizBIT will send a one-time verification code to that email.</p>
        <div style="margin-top:24px;">
          <div class="field"><label>Email</label><input id="qb-recovery-email" type="email" value="${qbEscape(email)}" autocomplete="email" placeholder="you@example.com"></div>
          <button class="btn btn-solid" onclick="qbSendRecoveryOtp()">Send OTP</button>
          <button class="btn btn-ghost" style="margin-left:8px;" onclick="go({name:'account'})">Back to login</button>
          <div id="qb-recovery-error" class="pin-error" style="margin-top:14px;height:auto;min-height:14px;"></div>
        </div>
      </section>`;
  };

  window.qbSendRecoveryOtp=async function(){
    const email=document.getElementById('qb-recovery-email')?.value.trim().toLowerCase();
    const e=document.getElementById('qb-recovery-error');
    if(e)e.textContent='';
    if(!email){if(e)e.textContent='Enter your account email.';return;}
    if(!supabaseClient){if(e)e.textContent='Supabase is not configured yet.';return;}
    const {error}=await supabaseClient.auth.signInWithOtp({
      email,
      options:{shouldCreateUser:false}
    });
    if(error){if(e)e.textContent=error.message;return;}
    root.innerHTML=`
      <section class="qb-user-direct-page" style="max-width:520px;margin:auto;">
        <div class="eyebrow">Email Verification</div>
        <h1 class="hero" style="font-size:30px;">Enter your OTP</h1>
        <p class="lede">We sent a one-time code to <strong>${qbEscape(email)}</strong>. Enter it below to verify your identity and choose a new password.</p>
        <input type="hidden" id="qb-recovery-email" value="${qbEscape(email)}">
        <div style="margin-top:24px;">
          <div class="field"><label>6-digit OTP</label><input id="qb-recovery-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Enter OTP"></div>
          <div class="field"><label>New password</label><input id="qb-recovery-new-password" type="password" autocomplete="new-password" placeholder="Create a new password"></div>
          <div class="field"><label>Confirm new password</label><input id="qb-recovery-confirm-password" type="password" autocomplete="new-password" placeholder="Repeat your new password"></div>
          <button class="btn btn-solid" onclick="qbVerifyRecoveryOtpAndReset()">Verify &amp; Reset Password</button>
          <button class="btn btn-ghost" style="margin-left:8px;" onclick="qbStartPasswordRecovery()">Use another email</button>
          <div id="qb-recovery-error" class="pin-error" style="margin-top:14px;height:auto;min-height:14px;"></div>
        </div>
      </section>`;
  };

  window.qbVerifyRecoveryOtpAndReset=async function(){
    const email=document.getElementById('qb-recovery-email')?.value.trim().toLowerCase() || '';
    const otp=document.getElementById('qb-recovery-otp')?.value.trim();
    const password=document.getElementById('qb-recovery-new-password')?.value || '';
    const confirm=document.getElementById('qb-recovery-confirm-password')?.value || '';
    const e=document.getElementById('qb-recovery-error');
    if(e)e.textContent='';
    if(!/^\d{6}$/.test(otp||'')){if(e)e.textContent='Enter the 6-digit OTP from your email.';return;}
    if(password.length<8){if(e)e.textContent='New password must be at least 8 characters.';return;}
    if(password!==confirm){if(e)e.textContent='Passwords do not match.';return;}
    const {data,error}=await supabaseClient.auth.verifyOtp({email,token:otp,type:'recovery'});
    if(error || !data?.session){if(e)e.textContent=error?.message || 'The OTP is invalid or has expired.';return;}
    const {error:updateError}=await supabaseClient.auth.updateUser({password});
    if(updateError){if(e)e.textContent=updateError.message;return;}
    await ensureProfile(data.user);
    toast('Password reset successfully.');
    go({name:'account'});
  };

  window.qbCreateAccount=async function(){
    const fullName=document.getElementById('qb-full-name')?.value.trim();
    const email=document.getElementById('qb-email')?.value.trim();
    const password=document.getElementById('qb-password')?.value;
    const errorEl=document.getElementById('qb-account-error');
    if(errorEl) errorEl.textContent='';
    if(!fullName || fullName.length < 2){
      if(errorEl) errorEl.textContent='Please enter your full name.';
      return;
    }
    const result=await qbSignUp(email,password,fullName);
    if(result.error){ if(errorEl) errorEl.textContent=result.error.message; return; }
    const user=result.data?.user;
    if(!user){ if(errorEl) errorEl.textContent='Account creation failed. Please try again.'; return; }
    if(result.data?.session){
      toast('Account created.');
      go({name:'dashboard'});
    }else{
      toast('Account created. Check your email if confirmation is required.');
      go({name:'dashboard'});
    }
  };

  window.qbLoginAccount=async function(){
    const email=document.getElementById('qb-login-email')?.value.trim();
    const password=document.getElementById('qb-login-password')?.value;
    const errorEl=document.getElementById('qb-account-error');
    if(errorEl) errorEl.textContent='';
    const {error}=await qbSignIn(email,password);
    if(error){ if(errorEl) errorEl.textContent=error.message; return; }
    toast('Welcome back.');
    await qbContinueAfterLogin();
  };

  // ----- Owner dashboard: cohorts + cohort assignment -----
  window.blankTest=function(){
    return {
      id:uid(), title:'', cohortId:'', subject:'General', section:'General',
      testType:'Full Test', testSize:'Full Length Tests', category:'quizbit_mock', isFree:false, difficulty:'Moderate', deadline:'', durationMins:30,
      active:true, marksCorrect:1, marksWrong:0, marksUnattempted:0,
      instructions:'', syllabus:'', markingSchemeText:'', questions:[],
      createdAt:new Date().toISOString(), updatedAt:'',
      thresholds:[
        {key:'poor',min:0,max:40,heading:'Tough one.',message:'But hey, this is just one test — not your final story. Find what went wrong, fix it, and come back stronger.'},
        {key:'average',min:40,max:60,heading:'Decent attempt.',message:"You're on the board, but there's plenty of room to level up."},
        {key:'good',min:60,max:85,heading:'Nice work!',message:"You're clearly getting things right. Now sharpen the weak areas and push for the next level."},
        {key:'excellent',min:85,max:100,heading:'Outstanding! 🔥',message:"You didn't just take the test — you owned it."}
      ]
    };
  };

  const QB_TEST_CATEGORIES=[
    {value:'quizbit_mock',label:'QuizBIT Mock Tests — Full Tests'},
    {value:'quizbit_part',label:'QuizBIT Part Tests'},
    {value:'part_syllabus_challenge',label:'Part Syllabus Challenges'},
    {value:'subject_challenge',label:'Subject Based Challenges'},
    {value:'full_syllabus_challenge',label:'Full Syllabus Challenges'},
    {value:'previous_year',label:'Previous Years Papers'},
    {value:'pyq_replica',label:'PYQ Replica Mock Tests'}
  ];
  function qbNormalizeCategory(t){
    const raw=String(t?.category||t?.test_category||'').trim().toLowerCase();
    if(QB_TEST_CATEGORIES.some(c=>c.value===raw)) return raw;
    const size=qbNormalizeTestSize(t);
    const type=String(t?.testType||t?.test_type||'').toLowerCase();
    if(raw.includes('replica')) return 'pyq_replica';
    if(raw.includes('previous')||raw.includes('pyq')) return 'previous_year';
    if(raw.includes('part syllabus')) return 'part_syllabus_challenge';
    if(raw.includes('subject') && raw.includes('challenge')) return 'subject_challenge';
    if(raw.includes('full syllabus') && raw.includes('challenge')) return 'full_syllabus_challenge';
    if(size==='Part Length Tests') return 'quizbit_part';
    if(size==='Full Length Tests') return 'quizbit_mock';
    if(type.includes('previous')) return 'previous_year';
    if(type.includes('topic')||type.includes('chapter')) return 'part_syllabus_challenge';
    if(type.includes('sectional')||type.includes('subject')) return 'subject_challenge';
    if(type.includes('mini')) return 'full_syllabus_challenge';
    return 'quizbit_mock';
  }
  function qbCategoryLabel(value){ return QB_TEST_CATEGORIES.find(c=>c.value===value)?.label || 'QuizBIT Mock Tests — Full Tests'; }
  function qbIsFree(t){ return t?.isFree===true || t?.is_free===true || String(t?.access||'').toLowerCase()==='free'; }
  function qbCategoryStats(tests,category){
    const items=(tests||[]).filter(t=>qbNormalizeCategory(t)===category);
    return {total:items.length,free:items.filter(qbIsFree).length};
  }
  function qbCardCountText(tests,category){
    const st=qbCategoryStats(tests,category);
    return `${st.total} Test${st.total===1?'':'s'}${st.free ? ` &#8226; ${st.free} Free Test${st.free===1?'':'s'}` : ''}`;
  }

  window.ownerCreateHtml=function(){
    const t=draft;
    const cohorts=DB.__ownerCohorts||[];
    t.subject=t.subject||t.section||'General';
    t.section=t.subject;
    t.testType=t.testType||'Full Test';
    t.category=qbNormalizeCategory(t);
    t.isFree=qbIsFree(t);
    t.testSize=t.testSize||((t.category==='quizbit_part')?'Part Length Tests':'Full Length Tests');
    t.difficulty=t.difficulty||'Moderate';
    return `<section>
      <div class="eyebrow">Test Details & Organisation</div>
      <div class="row2">
        <div class="field"><label>Test Title</label><input value="${esc(t.title)}" oninput="draft.title=this.value"></div>
        <div class="field"><label>Exam Cohort</label><select onchange="draft.cohortId=this.value"><option value="">Select cohort</option>${cohorts.map(c=>`<option value="${c.id}" ${String(t.cohortId)===String(c.id)?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="row3">
        <div class="field"><label>Subject / Section</label><input value="${esc(t.subject)}" placeholder="Quantitative Aptitude" oninput="draft.subject=this.value;draft.section=this.value"></div>
        <div class="field"><label>Test Type</label><select onchange="draft.testType=this.value">${['Full Test','Mini Test','Sectional Test','Topic Test','Previous Year'].map(x=>`<option ${t.testType===x?'selected':''}>${x}</option>`).join('')}</select></div>
        <div class="field"><label>Difficulty</label><select onchange="draft.difficulty=this.value">${['Easy','Moderate','Hard','Mixed'].map(x=>`<option ${t.difficulty===x?'selected':''}>${x}</option>`).join('')}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label>QuizBIT Category</label><select onchange="draft.category=this.value;draft.testSize=this.value==='quizbit_part'?'Part Length Tests':this.value==='quizbit_mock'?'Full Length Tests':draft.testSize">${QB_TEST_CATEGORIES.map(c=>`<option value="${c.value}" ${t.category===c.value?'selected':''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Access</label><select onchange="draft.isFree=this.value==='free'"><option value="paid" ${!t.isFree?'selected':''}>Paid / Premium</option><option value="free" ${t.isFree?'selected':''}>Free</option></select></div>
      </div>
      <div class="row3">
        <div class="field"><label>Deadline</label><input type="datetime-local" value="${t.deadline||''}" oninput="draft.deadline=this.value"></div>
        <div class="field"><label>Duration (minutes)</label><input type="number" min="1" value="${t.durationMins}" oninput="draft.durationMins=Number(this.value)"></div>
        <div class="field"><label>Publish</label><select onchange="draft.active=this.value==='true'"><option value="true" ${t.active?'selected':''}>Published</option><option value="false" ${!t.active?'selected':''}>Unpublished</option></select></div>
      </div>
      <div class="row3">
        <div class="field"><label>Marks Correct</label><input type="number" step="0.25" value="${t.marksCorrect}" oninput="draft.marksCorrect=Number(this.value)"></div>
        <div class="field"><label>Marks Wrong</label><input type="number" step="0.25" value="${t.marksWrong}" oninput="draft.marksWrong=Number(this.value)"></div>
        <div class="field"><label>Marks Unattempted</label><input type="number" step="0.25" value="${t.marksUnattempted}" oninput="draft.marksUnattempted=Number(this.value)"></div>
      </div>
    </section>
    <hr class="sep-soft"><section>
      <div class="eyebrow">Instructions & Syllabus</div>${symbarHtml()}
      <div class="field"><label>Instructions</label><textarea oninput="draft.instructions=this.value">${esc(t.instructions)}</textarea></div>
      <div class="field"><label>Syllabus</label><textarea oninput="draft.syllabus=this.value">${esc(t.syllabus)}</textarea></div>
      <div class="field"><label>Marking scheme</label><textarea oninput="draft.markingSchemeText=this.value">${esc(t.markingSchemeText)}</textarea></div>
    </section>
    <hr class="sep-soft"><section>
      <div class="eyebrow">Score Bands & Greetings</div>
      ${t.thresholds.map((th,i)=>`<div class="thresh-row"><div style="color:var(--gold)">${th.key}</div><input class="subtle-input" type="number" value="${th.min}" oninput="draft.thresholds[${i}].min=Number(this.value)"><input class="subtle-input" type="number" value="${th.max}" oninput="draft.thresholds[${i}].max=Number(this.value)"><div><input class="subtle-input" style="width:100%;margin-bottom:6px" value="${esc(th.heading)}" oninput="draft.thresholds[${i}].heading=this.value"><textarea class="subtle-input" style="width:100%;min-height:50px" oninput="draft.thresholds[${i}].message=this.value">${esc(th.message)}</textarea></div></div>`).join('')}
    </section>
    <hr class="sep-soft"><section>
      <div class="eyebrow">Questions</div>${symbarHtml()}
      <div class="field"><label>Question text</label><textarea id="qText"></textarea></div>
      <div class="field"><label>Question image (optional)</label><input id="qImage" type="file" accept="image/*" onchange="previewQuestionImage(this)"><div id="qImageStatus" class="qb-upload-status">Optional. The image will span the full test width.</div><img id="qImagePreview" class="qb-owner-question-image" style="display:none;max-height:320px" alt="Question image preview"></div>
      <div class="row2"><div class="field"><label>Option A</label><input id="optA"></div><div class="field"><label>Option B</label><input id="optB"></div></div>
      <div class="row2"><div class="field"><label>Option C</label><input id="optC"></div><div class="field"><label>Option D</label><input id="optD"></div></div>
      <div class="field"><label>Correct option</label><select id="correctSel"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></div>
      <button class="btn btn-sm" onclick="addQuestion()">+ Add Question</button>
      <div id="qList" style="margin-top:20px">${(t.questions||[]).map((q,i)=>`<div class="q-item"><span class="q-del" onclick="removeQuestion(${i})">Remove</span><div class="qnum">Q${i+1}</div>${q.image_url?`<img class="qb-owner-question-image" src="${esc(q.image_url)}" alt="Question image">`:''}<div class="qtext">${esc(q.text)}</div><div class="q-opts">${q.options.map((o,oi)=>`<div class="${oi===q.correct?'correct':''}">${'ABCD'[oi]}. ${esc(o)} ${oi===q.correct?'✓':''}</div>`).join('')}</div></div>`).join('')||'<div class="center-empty">No questions added yet.</div>'}</div>
    </section>
    <hr class="sep-soft"><section style="display:flex;gap:14px">
      <button class="btn btn-solid" onclick="saveDraft()">Save Test</button>
      <button class="btn btn-ghost" onclick="draft=blankTest();go({name:'ownerDash',tab:'create'})">Clear / New Test</button>
    </section>`;
  };

  window.saveDraft=async function(){
    if(!draft.title?.trim()){toast('Give the test a title');return;}
    if(!draft.cohortId){toast('Select an exam cohort');return;}
    if(!draft.questions?.length){toast('Add at least one question');return;}
    draft.subject=(draft.subject||draft.section||'General').trim();
    draft.section=draft.subject;
    draft.testType=draft.testType||'Full Test';
    draft.category=qbNormalizeCategory(draft);
    draft.isFree=qbIsFree(draft);
    draft.testSize=draft.testSize||((draft.category==='quizbit_part')?'Part Length Tests':'Full Length Tests');
    draft.difficulty=draft.difficulty||'Moderate';
    draft.updatedAt=new Date().toISOString();
    if(!draft.createdAt) draft.createdAt=draft.updatedAt;
    const idx=DB.tests.findIndex(x=>String(x.id)===String(draft.id));
    if(idx>=0) DB.tests[idx]=draft; else DB.tests.push(draft);
    const ok=await sset('qb-tests',DB.tests);
    if(!ok){toast('Test could not be saved');return;}
    const cohortName=(DB.__ownerCohorts||[]).find(c=>String(c.id)===String(draft.cohortId))?.name;
    toast('Test saved'+(cohortName?` to ${cohortName}`:''));
    draft=blankTest();
    go({name:'ownerDash',tab:'tests'});
  };

  window.ownerCohortsHtml=function(){
    const cohorts=DB.__ownerCohorts||[];
    return `<section>
      <div class="eyebrow">Exam Cohorts</div>
      <p class="lede">Create, edit, activate and organise the exams students can choose after Find Tests.</p>
      <div class="row2"><div class="field"><label>Cohort name</label><input id="owner-cohort-name" placeholder="SBI Clerk"></div><div class="field"><label>Category</label><input id="owner-cohort-category" placeholder="Banking"></div></div>
      <div class="field"><label>Description</label><textarea id="owner-cohort-description" placeholder="Short description shown to students"></textarea></div>
      <div class="field"><label>Exam Logo</label><input id="owner-cohort-logo-file" type="file" accept="image/*"><div id="owner-cohort-logo-status" class="qb-upload-status">Upload the logo that will appear for this exam.</div></div>
      <button class="btn btn-solid btn-sm" onclick="ownerAddCohort()">Create Cohort</button>
      <hr class="sep-soft">
      ${cohorts.map(c=>`<div class="test-row" style="cursor:default">
        <div style="display:flex;align-items:center;gap:14px;min-width:0;">
          <div class="qb-owner-cohort-logo">${c.logo_url?`<img src="${esc(c.logo_url)}" alt="">`:'+'}</div>
          <div style="min-width:0"><div class="test-title">${esc(c.name)}</div><div class="test-meta"><span>${esc(c.category||'Exam')}</span><span>${c.active?'Active':'Inactive'}</span><span>${DB.tests.filter(t=>String(t.cohortId||'')===String(c.id)).length} tests</span></div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm btn-ghost" onclick="ownerEditCohort('${c.id}')">Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="ownerToggleCohort('${c.id}',${c.active?'false':'true'})">${c.active?'Deactivate':'Activate'}</button>
          <button class="btn btn-sm btn-danger" onclick="ownerDeleteCohort('${c.id}')">Delete</button>
        </div>
      </div>`).join('')||'<div class="center-empty">No cohorts found.</div>'}
    </section>`;
  };

  window.ownerAddCohort=async function(){
    const name=document.getElementById('owner-cohort-name')?.value.trim();
    const category=document.getElementById('owner-cohort-category')?.value.trim();
    const description=document.getElementById('owner-cohort-description')?.value.trim();
    const file=document.getElementById('owner-cohort-logo-file')?.files?.[0] || null;
    const status=document.getElementById('owner-cohort-logo-status');
    if(!name){toast('Enter a cohort name');return;}
    if(!supabaseClient){toast('Supabase is not configured');return;}

    const payload={name,category:category||'',description:description||'',active:true};
    if(file){
      if(status) status.textContent='Uploading exam logo…';
      const uploaded=await qbUploadCohortLogo(file);
      if(uploaded.error){
        if(status) status.textContent=uploaded.error.message || 'Logo upload failed.';
        toast('Exam logo could not be uploaded.');
        return;
      }
      payload.logo_url=uploaded.url||'';
    }

    const {error}=await supabaseClient.from('exam_cohorts').insert(payload);
    if(error){toast(error.message);return;}
    toast('Cohort created'); qbInvalidateCohortCache?.(); await loadOwnerCohorts(); go({name:'ownerDash',tab:'cohorts'});
  };

  window.ownerEditCohort=async function(id){
    if(!supabaseClient){toast('Supabase is not configured');return;}
    const owner=await qbRequireOwner();
    if(!owner.ok){toast('Owner access required');return;}

    const cohort=(DB.__ownerCohorts||[]).find(c=>String(c.id)===String(id));
    if(!cohort){toast('Cohort not found');return;}

    document.getElementById('qb-owner-cohort-edit-overlay')?.remove();

    const overlay=document.createElement('div');
    overlay.id='qb-owner-cohort-edit-overlay';
    overlay.className='qb-edit-overlay';
    overlay.innerHTML=`
      <div class="qb-edit-sheet" role="dialog" aria-modal="true" aria-label="Edit exam cohort">
        <div class="qb-edit-sheet-head">
          <div class="qb-edit-sheet-title">Edit Exam Cohort</div>
          <button class="qb-edit-close" type="button" onclick="document.getElementById('qb-owner-cohort-edit-overlay')?.remove()">×</button>
        </div>
        <div class="field">
          <label>Cohort name</label>
          <input id="qb-edit-cohort-name" value="${qbEscape(cohort.name||'')}" maxlength="120">
        </div>
        <div class="field">
          <label>Category</label>
          <input id="qb-edit-cohort-category" value="${qbEscape(cohort.category||'')}" maxlength="80">
        </div>
        <div class="field">
          <label>Description</label>
          <textarea id="qb-edit-cohort-description" maxlength="500">${qbEscape(cohort.description||'')}</textarea>
        </div>
        <div class="field">
          <label>Exam Logo</label>
          <input id="qb-edit-cohort-logo-file" type="file" accept="image/*">
          <div id="qb-edit-cohort-logo-status" class="qb-upload-status">
            ${cohort.logo_url ? 'Choose a new logo only if you want to replace the current one.' : 'Upload a logo for this exam.'}
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
          <button class="btn btn-ghost btn-sm" type="button" onclick="document.getElementById('qb-owner-cohort-edit-overlay')?.remove()">Cancel</button>
          <button class="btn btn-solid btn-sm" type="button" id="qb-save-cohort-edit">Save Changes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('qb-save-cohort-edit').onclick=async()=>{
      const name=document.getElementById('qb-edit-cohort-name')?.value.trim();
      const category=document.getElementById('qb-edit-cohort-category')?.value.trim()||'';
      const description=document.getElementById('qb-edit-cohort-description')?.value.trim()||'';
      const file=document.getElementById('qb-edit-cohort-logo-file')?.files?.[0]||null;
      const status=document.getElementById('qb-edit-cohort-logo-status');
      const saveBtn=document.getElementById('qb-save-cohort-edit');

      if(!name){toast('Enter a cohort name');return;}
      saveBtn.disabled=true;
      if(status) status.textContent='Saving changes…';

      try{
        const payload={name,category,description};
        if(file){
          if(status) status.textContent='Uploading exam logo…';
          const uploaded=await qbUploadCohortLogo(file);
          if(uploaded.error){
            if(status) status.textContent=uploaded.error.message||'Logo upload failed.';
            toast('Exam logo could not be uploaded.');
            return;
          }
          payload.logo_url=uploaded.url||'';
        }

        const {error}=await supabaseClient
          .from('exam_cohorts')
          .update(payload)
          .eq('id',String(id));

        if(error){
          console.error('Cohort edit failed:',error);
          toast(error.message||'Could not save cohort');
          return;
        }

        qbInvalidateCohortCache?.();
        document.getElementById('qb-owner-cohort-edit-overlay')?.remove();
        await loadOwnerCohorts();
        go({name:'ownerDash',tab:'cohorts'});
        toast('Cohort updated');
      }catch(err){
        console.error('Cohort edit exception:',err);
        toast('Could not save cohort');
      }finally{
        if(document.getElementById('qb-save-cohort-edit')) {
          document.getElementById('qb-save-cohort-edit').disabled=false;
        }
      }
    };
  };

  window.ownerToggleCohort=async function(id,active){
    if(!supabaseClient){toast('Supabase is not configured');return;}
    const owner=await qbRequireOwner();
    if(!owner.ok){toast('Owner access required');return;}
    const cohortId=String(id);
    const nextActive=active === true || active === 'true';
    const {error}=await supabaseClient
      .from('exam_cohorts')
      .update({active:nextActive})
      .eq('id',cohortId);
    if(error){console.error('Cohort status update failed:',error);toast(error.message||'Could not update cohort');return;}
    qbInvalidateCohortCache?.();
    await loadOwnerCohorts();
    go({name:'ownerDash',tab:'cohorts'});
    toast(nextActive ? 'Cohort activated' : 'Cohort deactivated');
  };

  window.ownerDeleteCohort=async function(id){
    const cohort=(DB.__ownerCohorts||[]).find(c=>String(c.id)===String(id));
    if(!cohort){toast('Cohort not found');return;}
    const assigned=(DB.tests||[]).filter(t=>String(t.cohortId||'')===String(id));
    if(assigned.length){
      toast(`Move or delete ${assigned.length} test${assigned.length===1?'':'s'} from this cohort first.`);
      return;
    }
    if(!confirm(`Delete “${cohort.name}”? This cannot be undone.`)) return;
    if(!supabaseClient){toast('Supabase is not configured');return;}
    const {error}=await supabaseClient.from('exam_cohorts').delete().eq('id',id);
    if(error){toast(error.message);return;}
    await loadOwnerCohorts();
    go({name:'ownerDash',tab:'cohorts'});
    toast('Cohort deleted');
  };

  async function loadOwnerCohorts(){
    const {data,error}=await supabaseClient.from('exam_cohorts').select('*').order('created_at',{ascending:true});
    if(error){toast(error.message);DB.__ownerCohorts=[];return [];}
    DB.__ownerCohorts=data||[]; return DB.__ownerCohorts;
  }

  window.qbOwnerLogout=async function(){
    await qbSignOut();
    go({name:'home'});
  };

  window.renderOwnerDash=async function(){
    const owner=await qbRequireOwner();
    if(!owner.ok) return go({name:'account'});
    await originalLoadDB();
    if(!DB.settings) DB.settings={};
    await loadOwnerCohorts();
    if(!draft) draft=blankTest();
    const tab=VIEW.tab||'create';
    root.innerHTML=`<div class="qb-owner-header"><div><div class="brand" style="font-size:22px;">Quiz<span class="dot">BIT</span></div><div class="qb-owner-header-label">Owner Dashboard</div></div><button class="btn btn-ghost btn-sm" onclick="qbOwnerLogout()">Log out</button></div><section style="padding-top:24px;"><div class="eyebrow">Owner Dashboard</div><h1 class="hero" style="font-size:28px;">Manage QuizBIT</h1></section><div class="tabbar">${tabBtn('create','Create / Edit Test')}${tabBtn('tests','All Tests')}${tabBtn('cohorts','Exam Cohorts')}${tabBtn('notifications','Notifications')}${tabBtn('analytics','Analytics')}</div><div id="tabContent"></div>`;
    const c=document.getElementById('tabContent');
    if(tab==='create') c.innerHTML=ownerCreateHtml();
    if(tab==='tests') c.innerHTML=await ownerTestsHtml();
    if(tab==='cohorts') c.innerHTML=ownerCohortsHtml();
    if(tab==='notifications') c.innerHTML=await ownerNotificationsHtml();
    if(tab==='analytics') c.innerHTML=await ownerAnalyticsHtml();
  };

  window.ownerTestsHtml=async function(){
    if(!DB.tests.length) return `<div class="center-empty">No tests created yet. Go to "Create / Edit Test".</div>`;
    const cohorts=DB.__ownerCohorts||[];
    const groups=new Map();
    for(const t of DB.tests){
      const key=String(t.cohortId||'__none__');
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(t);
    }
    let html='<section>';
    for(const [cohortId,tests] of groups){
      const cohort=cohorts.find(c=>String(c.id)===cohortId);
      html+=`<div class="qb-v2-form"><div class="eyebrow">${esc(cohort?.name||'Unassigned Tests')}</div>`;
      for(const t of tests){
        const res=await getResults(t.id);
        html+=`<div class="test-row" style="cursor:default;">
          <div style="min-width:0"><div class="test-title">${esc(t.title)} ${t.active?'':'<span style="color:var(--text-faint);font-size:11px;"> (inactive)</span>'}</div>
          <div class="test-meta"><span>${esc(qbCategoryLabel(qbNormalizeCategory(t)))}</span><span>${qbIsFree(t)?'Free':'Paid / Premium'}</span><span>${esc(t.subject||t.section||'General')}</span><span>${esc(t.testType||'Full Test')}</span><span>${esc(t.difficulty||'Moderate')}</span><span>${t.questions?.length||0} Q</span><span>${res.length} candidates</span><span>Closes ${fmtDate(t.deadline)}</span></div></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><button class="btn btn-sm btn-ghost" onclick="editTest('${t.id}')">Edit</button><button class="btn btn-sm btn-ghost" onclick="toggleActive('${t.id}')">${t.active?'Deactivate':'Activate'}</button><button class="btn btn-sm btn-danger" onclick="deleteTest('${t.id}')">Delete</button></div>
        </div>`;
      }
      html+='</div>';
    }
    html+='</section>';
    return html;
  };

  // Ensure existing legacy tests continue to appear in the first cohort until edited.
  window.editTest=function(id){
    draft=JSON.parse(JSON.stringify(DB.tests.find(t=>t.id===id)));
    if(!draft.cohortId) draft.cohortId=DB.__ownerCohorts?.[0]?.id||'';
    go({name:'ownerDash',tab:'create'});
  };

  // ----- QuizBIT menu / theme / notifications -----
  let QB_MENU_RETURN_VIEW = null;
  window.qbOpenMenu=async function(returnView){
    const user=await qbUser().catch(()=>null);
    if(!user){go({name:'account'});return;}
    // The menu is an overlay. Its close button always returns to the
    // User Dashboard; keep the return state only for compatibility.
    const fallback = VIEW ? JSON.parse(JSON.stringify(VIEW)) : {name:'home'};
    QB_MENU_RETURN_VIEW = returnView ? JSON.parse(JSON.stringify(returnView)) : fallback;
    let el=document.getElementById('qb-menu-overlay');
    if(!el){el=document.createElement('div');el.id='qb-menu-overlay';document.body.appendChild(el);}
    const isLight=document.documentElement.getAttribute('data-theme')==='light';
    el.innerHTML=`
      <div class="qb-menu-backdrop" onclick="qbCloseMenu()"></div>
      <aside class="qb-side-menu qb-clean-menu" role="dialog" aria-label="QuizBIT menu">
        <div class="qb-menu-top"><div class="qb-menu-heading">Menu</div><button class="qb-menu-close" onclick="qbCloseMenuAndReturn()" aria-label="Close menu">×</button></div>
        <div class="qb-menu-list qb-clean-menu-list">
          <button class="qb-menu-item" onclick="qbMenuAllExams()"><span class="qb-menu-icon qb-icon-exams"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="4" width="7" height="7" rx="1.5"></rect><rect x="3.5" y="13" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="13" width="7" height="7" rx="1.5"></rect></svg></span><span>All Exams</span><span class="qb-menu-arrow">›</span></button>
          <button class="qb-menu-item" onclick="qbMenuHistory()"><span class="qb-menu-icon qb-icon-history"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7"></path><path d="M4 5v5h5"></path><path d="M12 7v5l3 2"></path></svg></span><span>Test History</span><span class="qb-menu-arrow">›</span></button>
          <button class="qb-menu-item" onclick="qbMenuPurchases()"><span class="qb-menu-icon qb-icon-cart"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 1.9-1.5L21 8H6"></path><circle cx="9.5" cy="20" r="1.3"></circle><circle cx="18" cy="20" r="1.3"></circle></svg></span><span>Purchases</span><span class="qb-menu-arrow">›</span></button>
          <button class="qb-menu-item" onclick="qbMenuNotifications()"><span class="qb-menu-icon qb-icon-bell"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg></span><span>Notifications</span><span class="qb-menu-arrow">›</span></button>
          <button class="qb-menu-item" onclick="qbMenuBookmarks()"><span class="qb-menu-icon">☆</span><span>Bookmarks</span><span class="qb-menu-arrow">›</span></button>
          <div class="qb-menu-section-label">Theme</div>
          <div class="qb-theme-row"><button class="qb-theme-choice ${!isLight?'active':''}" onclick="qbSetTheme('dark')"><span>☾</span><small>Dark</small></button><button class="qb-theme-choice ${isLight?'active':''}" onclick="qbSetTheme('light')"><span>☼</span><small>Light</small></button></div>
        </div>
      </aside>`;
    document.body.classList.add('qb-menu-open');
    requestAnimationFrame(()=>el.classList.add('open'));
  };

  window.qbMenuAllExams=function(){qbCloseMenu();go({name:'cohorts'});};
  window.qbMenuYourExams=window.qbMenuAllExams;
  window.qbMenuHistory=function(){qbCloseMenu();go({name:'history'});};
  window.qbMenuPurchases=function(){qbCloseMenu();go({name:'purchases'});};
  window.qbMenuBookmarks=function(){qbCloseMenu();go({name:'bookmarks'});};

  window.qbCloseMenu=function(){
    const el=document.getElementById('qb-menu-overlay');
    if(el) el.classList.remove('open');
    document.body.classList.remove('qb-menu-open');
    setTimeout(()=>{ const x=document.getElementById('qb-menu-overlay'); if(x&&!x.classList.contains('open')) x.remove(); },220);
  };

  // Menu × means "close menu and return to the exact page that opened it".
  window.qbCloseMenuAndReturn=function(){
    // The menu is an overlay, not a page. Its close button always returns
    // the signed-in user to the User Dashboard (Your Exams).
    qbCloseMenu();
    QB_MENU_RETURN_VIEW = null;
    go({name:'dashboard'});
  };

  window.qbMenuNotifications=function(){ qbCloseMenu(); go({name:'notifications'}); };
  window.qbSetTheme=function(mode){
    const light=mode==='light';
    if(light) document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.removeAttribute('data-theme');
    try{localStorage.setItem('qb-theme',light?'light':'dark');}catch(e){}
    qbCloseMenu();
    render();
  };

  window.renderQBPurchases=async function(){
    const user=await qbUser();
    if(!user){go({name:'account'});return;}
    root.innerHTML=`
      <div class="qb-profile-shell qb-empty-page-shell">
        <div class="qb-profile-head">
          <div class="qb-profile-head-left">
            <button class="qb-round-btn" onclick="go({name:'dashboard'})" aria-label="Back to student dashboard" title="Back to dashboard">←</button>
            <div class="qb-profile-page-title">Purchases</div>
          </div>
        </div>
        <div class="qb-empty-state">
          <div class="qb-empty-state-icon qb-cart-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 72 72" fill="none"><path d="M11 15h8l5 32h27a5 5 0 0 0 4.8-3.7L61 24H21" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="29" cy="57" r="3" fill="currentColor"/><circle cx="52" cy="57" r="3" fill="currentColor"/></svg>
          </div>
          <div class="qb-empty-state-title">Your purchases will appear here</div>
          <div class="qb-empty-state-sub">Test series and study materials you purchase will be saved here.</div>
        </div>
      </div>`;
  };

  window.renderQBBookmarks=async function(){
    const user=await qbUser();
    if(!user){go({name:'account'});return;}
    let data=[], error=null;
    if(supabaseClient){
      try{
        const r=await supabaseClient.from('quizbit_bookmarks')
          .select('id,test_id,test_title,question_number,question_text,image_url,created_at')
          .eq('user_id',user.id)
          .order('created_at',{ascending:false});
        data=r.data||[]; error=r.error;
      }catch(e){error=e;}
    }else{
      error={message:'Supabase is not configured yet.'};
    }
    root.innerHTML=`
      <div class="qb-profile-shell">
        <div class="qb-profile-head">
          <div class="qb-profile-head-left">
            <button class="qb-round-btn" onclick="go({name:'dashboard'})" aria-label="Back to student dashboard" title="Back to dashboard">←</button>
            <div class="qb-profile-page-title">Bookmarks</div>
          </div>
        </div>
        <div class="qb-page-list">
          ${error ? `<div class="qb-empty-state"><div class="qb-empty-state-icon">☆</div><div class="qb-empty-state-title">No Bookmarks</div><div class="qb-empty-state-sub">Your Saved Questions will Appear here</div></div>` :
          data.length ? data.map((b,i)=>`
            <article class="qb-bookmark-item">
              <div class="qb-bookmark-top">
                <div class="qb-bookmark-index">Q${qbEscape(String(b.question_number||i+1))}</div>
                <div class="qb-bookmark-test">${qbEscape(b.test_title||'Saved Question')}</div>
              </div>
              ${b.image_url ? `<img class="qb-bookmark-image" src="${qbEscape(b.image_url)}" alt="">` : ''}
              <div class="qb-bookmark-question">${qbEscape(b.question_text||'')}</div>
            </article>`).join('') :
          `<div class="qb-empty-state"><div class="qb-empty-state-icon">☆</div><div class="qb-empty-state-title">You’ll find your bookmarks here</div><div class="qb-empty-state-sub">Questions you bookmark during or after tests will be saved here.</div></div>`}
        </div>
      </div>`;
  };

  window.renderQBNotifications=async function(){
    let data=[], error=null;
    if(supabaseClient){
      try{
        const r=await supabaseClient.from('quizbit_notifications').select('id,title,message,created_at').eq('active',true).order('created_at',{ascending:false});
        data=r.data||[]; error=r.error;
      }catch(e){error=e;}
    }else error={message:'Supabase is not configured yet.'};
    root.innerHTML=`
      <section class="qb-notifications-page">
        <div class="qb-notifications-head">
          <button class="qb-round-btn qb-direct-back qb-notifications-back" onclick="go({name:'dashboard'})" aria-label="Back to student dashboard" title="Back to dashboard">←</button>
          <div class="qb-notifications-title">Notifications</div>
        </div>
        <div class="qb-notification-list">
          ${error ? `<div class="qb-notifications-empty">
              <div class="qb-notifications-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 72 72" fill="none">
                  <path d="M20 28a16 16 0 0 1 32 0v9c0 5 2 9 6 13H14c4-4 6-8 6-13v-9Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
                  <path d="M29 56c1.5 4 12.5 4 14 0" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                  <path d="M36 12v-4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="qb-notifications-empty-title">No Notifications</div>
              <div class="qb-notifications-empty-sub">New Updates will appear here</div>
            </div>` :
            data.length ? data.map(n=>`<article class="qb-notification-card"><div class="qb-notification-dot"></div><div style="flex:1"><div class="qb-notification-title">${qbEscape(n.title||'QuizBIT update')}</div><div class="qb-notification-date">${n.created_at?new Date(n.created_at).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):''}</div><div class="qb-notification-message">${qbEscape(n.message||'')}</div></div></article>`).join('') : `<div class="qb-notifications-empty">
              <div class="qb-notifications-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 72 72" fill="none">
                  <path d="M20 28a16 16 0 0 1 32 0v9c0 5 2 9 6 13H14c4-4 6-8 6-13v-9Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
                  <path d="M29 56c1.5 4 12.5 4 14 0" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                  <path d="M36 12v-4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="qb-notifications-empty-title">No Notifications</div>
              <div class="qb-notifications-empty-sub">New Updates will appear here</div>
            </div>`}
        </div>
      </section>`;
  };

  window.ownerNotificationsHtml=async function(){
    let data=[], error=null;
    if(supabaseClient){
      try{
        const r=await supabaseClient.from('quizbit_notifications').select('id,title,message,active,created_at').order('created_at',{ascending:false});
        data=r.data||[]; error=r.error;
      }catch(e){error=e;}
    }else error={message:'Supabase is not configured yet.'};
    return `<section style="text-align:left;">
      <div class="eyebrow">Broadcast Notifications</div>
      <p class="lede" style="margin-left:0;">Publish announcements to every QuizBIT user. Each notification is independent, so you can keep multiple updates live.</p>
      <div class="qb-v2-form" style="margin-top:20px;">
        <div class="field"><label>Title</label><input id="owner-notif-title" maxlength="100" placeholder="e.g. New SBI PO mock test is live"></div>
        <div class="field"><label>Message</label><textarea id="owner-notif-message" maxlength="1000" placeholder="Write the announcement shown to all users."></textarea></div>
        <button class="btn btn-solid btn-sm" onclick="ownerCreateNotification()">Publish Notification</button>
        <div id="owner-notif-error" class="pin-error" style="margin-top:12px;height:auto;"></div>
      </div>
      <hr class="sep-soft">
      <div class="eyebrow">Published Notifications</div>
      ${error ? `<div class="center-empty">Unable to load notifications. Create the notification table in Supabase first.</div>` :
        data.length ? data.map(n=>`<div class="qb-owner-notification-row"><div style="flex:1"><div class="test-title" style="font-size:16px;">${qbEscape(n.title)}</div><div class="test-meta">${n.created_at?new Date(n.created_at).toLocaleString():''} · ${n.active?'Live':'Hidden'}</div><div style="font-size:13px;color:var(--text-dim);margin-top:7px;white-space:pre-wrap;">${qbEscape(n.message)}</div></div><button class="btn btn-sm ${n.active?'btn-ghost':'btn-solid'}" onclick="ownerToggleNotification('${n.id}',${n.active?'false':'true'})">${n.active?'Hide':'Publish'}</button></div>`).join('') : `<div class="center-empty">No notifications published yet.</div>`}
    </section>`;
  };

  window.ownerCreateNotification=async function(){
    const title=document.getElementById('owner-notif-title')?.value.trim();
    const message=document.getElementById('owner-notif-message')?.value.trim();
    const e=document.getElementById('owner-notif-error'); if(e)e.textContent='';
    if(!title||!message){if(e)e.textContent='Add both a title and message.';return;}
    const owner=await qbRequireOwner(); if(!owner.ok){if(e)e.textContent='Owner authorization required.';return;}
    const {error}=await supabaseClient.from('quizbit_notifications').insert({title,message,active:true,created_by:(await qbUser())?.id||null});
    if(error){if(e)e.textContent=error.message;return;}
    toast('Notification published to all users.');
    go({name:'ownerDash',tab:'notifications'});
  };
  window.ownerToggleNotification=async function(id,active){
    const owner=await qbRequireOwner(); if(!owner.ok)return;
    const {error}=await supabaseClient.from('quizbit_notifications').update({active}).eq('id',id);
    if(error){toast(error.message);return;}
    go({name:'ownerDash',tab:'notifications'});
  };

  // Student navigation: branding is reserved for the public/payment surfaces.
  // The dashboard gets the personalized identity row; inner pages stay content-first.
  window.headerHtml=function(){ return ''; };
  window.studentDashboardHeaderHtml=function(name){
    const safeName=String(name||'Student').trim()||'Student';
    const initial=qbEscape(safeName.charAt(0).toUpperCase());
    return `<div class="qb-student-dashboard-topbar">
      <div class="qb-student-identity">
        <button class="qb-student-avatar" type="button" onclick="go({name:'account'})" aria-label="Open profile" title="Profile">${initial}</button>
        <div class="qb-student-greeting">👋 Hey, ${qbEscape(safeName)}</div>
      </div>
      <button class="qb-student-menu-trigger" type="button" onclick="qbOpenMenu()" aria-label="Open menu" title="Menu"><span></span><span></span><span></span></button>
    </div>`;
  };

  // If a user is already signed in, make sure their profile exists, then take
  // them straight to their exam cohort instead of dropping them on the homepage.
  setTimeout(async()=>{
    try{
      await loadDB();
      const user=await qbUser();
      if(user){
        await ensureProfile(user);
        if(VIEW.name==='home' && typeof qbContinueAfterLogin==='function'){
          await qbContinueAfterLogin();
          return;
        }
        await syncPendingCohort(user);
      }
      render();
    }catch(e){ console.warn('QuizBIT boot:',e); render(); }
  },20);
})();



