/* ===================== STORAGE ===================== */
/* Owner access is handled by Supabase Auth; no PIN is stored in frontend code. */
let DB = { tests: [], settings: {}, analytics:{ retention:[] } };
let sessionStart = Date.now();

// Keep every in-memory test compatible with both legacy and canonical records.
// Storage itself is normalized by saveTests(), so there is only one persisted shape.
function qbNormalizeLoadedTests(){
  if(Array.isArray(DB.tests)) DB.tests=DB.tests.map(qbRuntimeTest);
}

/* Supabase-backed key/value storage. A localStorage fallback keeps the static site usable
   before Supabase credentials are entered, but production data lives in Supabase. */
async function sget(key){
  try{
    if(supabaseClient){
      const {data,error}=await supabaseClient.from('quizbit_store').select('value').eq('key',key).maybeSingle();
      if(!error) return data?.value ?? null;
      console.warn('Supabase read failed:', error.message);
      return null;
    }
  }catch(e){
    console.warn('Supabase read failed:', e);
    if(supabaseClient) return null;
  }
  try{ const raw=localStorage.getItem('quizbit:'+key); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
async function sset(key,val){
  try{
    if(supabaseClient){
      const {error}=await supabaseClient.from('quizbit_store').upsert({key,value:val,updated_at:new Date().toISOString()});
      if(!error) return true;
      console.warn('Supabase write failed:', error.message);
      return false;
    }
  }catch(e){
    console.warn('Supabase write failed:', e);
    if(supabaseClient) return false;
  }
  try{ localStorage.setItem('quizbit:'+key, JSON.stringify(val)); return true; }catch(e){ console.error('storage set failed',e); return false; }
}

let QB_DB_LOAD_PROMISE = null;
let QB_DB_LOADED = false;

/*
 * Canonical test persistence boundary.
 * The UI may use the historical camelCase field names internally, but tests are
 * stored with one stable snake_case contract. This prevents old/new versions of
 * the builder from silently creating incompatible test records.
 */
function qbRuntimeTest(t){
  if(!t || typeof t!=='object') return t;
  const x={...t};
  x.cohortId = x.cohortId ?? x.cohort_id ?? null;
  x.testType = x.testType ?? x.test_type ?? '';
  x.testSize = x.testSize ?? x.test_size ?? '';
  x.category = x.category ?? x.test_category ?? '';
  x.isFree = x.isFree ?? x.is_free ?? (String(x.access||'').toLowerCase()==='free');
  x.durationMins = Number(x.durationMins ?? x.duration_mins ?? 0);
  x.startTime = x.startTime ?? x.start_time ?? '';
  x.createdAt = x.createdAt ?? x.created_at ?? '';
  x.updatedAt = x.updatedAt ?? x.updated_at ?? '';
  return x;
}
function qbStoredTest(t){
  if(!t || typeof t!=='object') return t;
  const x={...t};
  x.cohort_id = x.cohortId ?? x.cohort_id ?? null;
  x.test_type = x.testType ?? x.test_type ?? '';
  x.test_size = x.testSize ?? x.test_size ?? '';
  x.category = x.category ?? x.test_category ?? '';
  x.is_free = x.isFree===true || x.is_free===true || String(x.access||'').toLowerCase()==='free';
  x.duration_mins = Number(x.durationMins ?? x.duration_mins ?? 0);
  x.start_time = x.startTime ?? x.start_time ?? '';
  x.created_at = x.createdAt ?? x.created_at ?? '';
  x.updated_at = x.updatedAt ?? x.updated_at ?? '';
  delete x.cohortId; delete x.testType; delete x.testSize; delete x.durationMins;
  delete x.startTime; delete x.createdAt; delete x.updatedAt;
  return x;
}

async function loadDB(force=false){
  // Share the same in-flight request across boot/render/test code and fetch
  // independent store keys concurrently.
  if(QB_DB_LOADED && !force) return;
  if(QB_DB_LOAD_PROMISE && !force) return QB_DB_LOAD_PROMISE;

  QB_DB_LOAD_PROMISE = Promise.all([
    sget('qb-tests'),
    sget('qb-settings'),
    sget('qb-analytics')
  ]).then(([tests,settings,analytics])=>{
    if(Array.isArray(tests)) DB.tests=tests.map(qbRuntimeTest);
    if(settings) DB.settings=settings;
    if(analytics) DB.analytics=analytics;
    QB_DB_LOADED=true;
  }).catch(err=>{
    QB_DB_LOADED=false;
    throw err;
  }).finally(()=>{QB_DB_LOAD_PROMISE=null;});

  return QB_DB_LOAD_PROMISE;
}
async function saveTests(){ qbNormalizeLoadedTests(); await sset('qb-tests', DB.tests.map(qbStoredTest)); }
async function saveSettings(){ await sset('qb-settings', DB.settings); }
async function saveAnalytics(){ await sset('qb-analytics', DB.analytics); }
async function getResults(testId){ const r = await sget('qb-results:'+testId); return r || []; }
async function saveResults(testId, arr){
  const key='qb-results:'+testId;
  if(supabaseClient){
    const item=arr[arr.length-1];
    const {error}=await supabaseClient.rpc('quizbit_save_result',{p_test_key:key,p_result:item});
    if(!error) return true;
    console.warn('Result RPC failed:',error.message);
  }
  return sset(key,arr);
}

window.addEventListener('beforeunload', ()=>{
  const mins = (Date.now()-sessionStart)/60000;
  if(mins > 0.05){
    DB.analytics.retention = DB.analytics.retention || [];
    DB.analytics.retention.push(Number(mins.toFixed(2)));
    if(DB.analytics.retention.length>500) DB.analytics.retention.shift();
    if(supabaseClient){
      sset('qb-analytics', DB.analytics).catch(()=>{});
    }else{
      try{localStorage.setItem('quizbit:qb-analytics',JSON.stringify(DB.analytics));}catch(e){}
    }
  }
});

