let QB_SESSION_CACHE=null;
let QB_SESSION_CACHE_READY=false;
let QB_SESSION_PROMISE=null;
let QB_OWNER_CACHE=null;
let QB_OWNER_CACHE_READY=false;
let QB_OWNER_PROMISE=null;

async function qbSession(){
  if(!supabaseClient) return null;
  if(QB_SESSION_CACHE_READY) return QB_SESSION_CACHE;
  if(QB_SESSION_PROMISE) return QB_SESSION_PROMISE;
  QB_SESSION_PROMISE=supabaseClient.auth.getSession()
    .then(({data})=>{QB_SESSION_CACHE=data?.session||null;QB_SESSION_CACHE_READY=true;return QB_SESSION_CACHE;})
    .catch(()=>{QB_SESSION_CACHE=null;QB_SESSION_CACHE_READY=true;return null;})
    .finally(()=>{QB_SESSION_PROMISE=null;});
  return QB_SESSION_PROMISE;
}

if(supabaseClient?.auth?.onAuthStateChange){
  supabaseClient.auth.onAuthStateChange((_event,session)=>{
    QB_SESSION_CACHE=session||null;
    QB_SESSION_CACHE_READY=true;
    // Owner status can change with the signed-in user (or on sign-out), so
    // any cached owner check is stale as soon as the session changes.
    QB_OWNER_CACHE=null;
    QB_OWNER_CACHE_READY=false;
    QB_OWNER_PROMISE=null;
  });
}

async function qbUser(){
  const session=await qbSession();
  return session?.user || null;
}

function qbValidPassword(password){
  return /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(password||'');
}

async function qbSignIn(email,password){
  if(!supabaseClient) return {data:null,error:{message:'Supabase is not configured yet.'}};
  const result=await supabaseClient.auth.signInWithPassword({
    email:String(email||'').trim(),
    password
  });
  if(!result.error && result.data?.user){
    await ensureProfile(result.data.user);
    await syncPendingCohort(result.data.user);
  }
  return result;
}

async function qbSignUp(email,password,fullName){
  if(!supabaseClient) return {data:null,error:{message:'Supabase is not configured yet.'}};
  email=String(email||'').trim();
  fullName=String(fullName||'').trim();
  if(fullName.length < 2){
    return {data:null,error:{message:'Please enter your full name.'}};
  }
  if(!qbValidPassword(password)){
    return {data:null,error:{message:'Password must be at least 8 characters and include a letter, a number and a special character.'}};
  }
  if(!email) return {data:null,error:{message:'Enter your email address.'}};

  const {data,error}=await supabaseClient.auth.signUp({
    email,
    password,
    options:{data:{full_name:fullName}}
  });
  if(error) return {data,error};

  if(data?.user){
    const {error:profileError}=await supabaseClient.from('profiles').upsert({
      id:data.user.id,
      full_name:fullName,
      display_name:fullName
    },{onConflict:'id'});
    if(profileError) console.warn('QuizBIT profile create failed:',profileError.message);
  }
  return {data,error:null};
}
window.qbSignIn=qbSignIn;
window.qbSignUp=qbSignUp;
async function qbSignOut(){
  if(!supabaseClient) return;
  try{ localStorage.removeItem('qb-active-test-id'); }catch(e){}
  return supabaseClient.auth.signOut();
}
async function qbTrack(eventName, extra={}){
  if(!supabaseClient) return;
  try{
    const user = await qbUser();
    await supabaseClient.from('analytics_events').insert({
      user_id:user?.id || null,
      event_name:eventName,
      cohort_id:extra.cohort_id || null,
      test_id:extra.test_id || null,
      campaign_id:extra.campaign_id || null,
      source:QB.source || extra.source || null,
      device_type:/Mobi|Android/i.test(navigator.userAgent)?'mobile':'desktop',
      metadata:extra.metadata || {}
    });
  }catch(e){ console.warn('analytics event failed',e); }
}

async function qbRequireOwner(){
  if(!supabaseClient) return {ok:false,reason:'supabase_not_configured'};
  // The owner check needs up to 3 sequential network round-trips
  // (auth.getUser, the quizbit_is_owner RPC, and a profile fallback), and
  // it's called on nearly every navigation for a logged-in user. Cache the
  // result for the life of the session instead of re-checking from scratch
  // each time; the cache is cleared on any auth state change (login/logout).
  if(QB_OWNER_CACHE_READY) return QB_OWNER_CACHE;
  if(QB_OWNER_PROMISE) return QB_OWNER_PROMISE;
  QB_OWNER_PROMISE=qbRequireOwnerUncached()
    .then(result=>{QB_OWNER_CACHE=result;QB_OWNER_CACHE_READY=true;return result;})
    .finally(()=>{QB_OWNER_PROMISE=null;});
  return QB_OWNER_PROMISE;
}

async function qbRequireOwnerUncached(){
  // Get the authenticated user directly from Supabase Auth.
  // The user ID is the authoritative identity; the role is still checked
  // server-side before any owner operation is allowed.
  let user=null;
  try{
    const {data,error}=await supabaseClient.auth.getUser();
    if(!error) user=data?.user || null;
  }catch(e){ console.warn('QuizBIT auth user check failed:',e); }

  if(!user){
    try{
      const {data}=await supabaseClient.auth.getSession();
      user=data?.session?.user || null;
    }catch(e){ console.warn('QuizBIT session check failed:',e); }
  }
  if(!user) return {ok:false,reason:'not_authenticated'};

  // Primary authorization check: SECURITY DEFINER RPC.
  // Explicitly use a fresh auth request so the access token is attached.
  try{
    const {data,error}=await supabaseClient.rpc('quizbit_is_owner');
    if(!error && (data===true || data==='true')) return {ok:true,user};
    if(error) console.warn('QuizBIT owner RPC failed:',error.message);
  }catch(e){ console.warn('QuizBIT owner RPC exception:',e); }

  // Fallback for the current user's own profile row. This is NOT the
  // security boundary; the owner dashboard performs the same server-side
  // owner check before loading owner data.
  try{
    const {data,error}=await supabaseClient
      .from('profiles')
      .select('role')
      .eq('id',user.id)
      .maybeSingle();
    if(!error && data?.role==='owner') return {ok:true,user};
    if(error) console.warn('QuizBIT profile owner check failed:',error.message);
  }catch(e){ console.warn('QuizBIT profile owner check exception:',e); }

  return {ok:false,reason:'not_owner',user};
}
async function qbAdminGate(){
  // If /admin is opened while the student menu is still visible, remove the
  // overlay before rendering the account/owner flow. Otherwise the menu can
  // sit above the login form and intercept taps.
  if(typeof qbCloseMenu==='function') qbCloseMenu();
  const owner=await qbRequireOwner();
  if(owner.ok){
    if(typeof renderOwnerDash==='function') return renderOwnerDash();
    return;
  }
  // No separate admin login page exists: the normal QuizBIT account login
  // is the only entry point, and owner status is decided server-side.
  go({name:'account'});
}

async function qbUploadQuestionImage(file){
  if(!supabaseClient) return {url:null,error:{message:'Supabase is not configured yet.'}};
  if(!file) return {url:null,error:null};
  if(!file.type || !file.type.startsWith('image/')) return {url:null,error:{message:'Please choose a valid image file.'}};
  if(file.size > 8 * 1024 * 1024) return {url:null,error:{message:'Question image must be 8 MB or smaller.'}};
  const ext=(file.name.split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'');
  const path=`${crypto.randomUUID()}.${ext || 'png'}`;
  const {error}=await supabaseClient.storage.from('question-images').upload(path,file,{
    upsert:false,contentType:file.type || undefined
  });
  if(error) return {url:null,error};
  const {data}=supabaseClient.storage.from('question-images').getPublicUrl(path);
  return {url:data?.publicUrl || null,error:null};
}

async function qbUploadCohortLogo(file){
  if(!supabaseClient) return {url:null,error:{message:'Supabase is not configured yet.'}};
  if(!file) return {url:null,error:null};
  if(file.size > 5 * 1024 * 1024) return {url:null,error:{message:'Exam logo must be 5 MB or smaller.'}};
  if(!file.type || !file.type.startsWith('image/')) return {url:null,error:{message:'Please choose a valid image file.'}};
  const ext=(file.name.split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'');
  const path=`${crypto.randomUUID()}.${ext || 'png'}`;
  const {error}=await supabaseClient.storage.from('cohort-logos').upload(path,file,{upsert:false,contentType:file.type || undefined});
  if(error) return {url:null,error};
  const {data}=supabaseClient.storage.from('cohort-logos').getPublicUrl(path);
  return {url:data?.publicUrl || null,error:null};
}
