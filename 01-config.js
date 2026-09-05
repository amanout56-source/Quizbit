
/*
 * QuizBIT — Supabase configuration
 * Replace ONLY these two placeholders with values from:
 * Supabase → Project Settings → API
 */
const SUPABASE_URL = "https://tjvlnxfhptcubnohvaxn.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_a-swOzsSKiBKxubugHJvJg_011pXG4B";
let supabaseClient = null;

function initSupabase(){
  const ready = SUPABASE_URL && !SUPABASE_URL.startsWith('YOUR_') &&
                SUPABASE_PUBLISHABLE_KEY && !SUPABASE_PUBLISHABLE_KEY.startsWith('YOUR_');
  if(!ready || !window.supabase) return false;
  try{
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    return true;
  }catch(e){
    console.error('QuizBIT: Supabase init failed', e);
    supabaseClient = null;
    return false;
  }
}
initSupabase();


  (function(){
    try{
      var saved = localStorage.getItem('qb-theme');
      if(saved==='light') document.documentElement.setAttribute('data-theme','light');
    }catch(e){}
  })();


/*
===================== QUIZBIT PRODUCTION DATA CONTRACT =====================
The live Supabase schema is created by the canonical migration supplied with
this production build. This file intentionally does not contain a second,
outdated migration copy: duplicate schema versions were a source of drift.

Canonical persisted contracts:
- profiles: id, full_name, role, exam_cohort_id, exam_cohort_ids
- exam_cohorts: id, name, description, category, active, logo_url
- quizbit_store: JSON test/settings/leaderboard store
- quizbit_user_attempts: completed authenticated-user attempts/history
- quizbit_test_attempts + quizbit_attempt_answers: resumable test state
- quizbit_bookmarks: authenticated-user bookmarks
- quizbit_notifications: active user announcements
- analytics_events: canonical event analytics
- storage: question-images and cohort-logos

Security contract:
- Browser uses only the Supabase publishable/anon key.
- Owner writes are protected by the server-side owner role/RLS.
- Authenticated test attempts are persisted server-side; guest attempts remain
  browser-only by design.

IMPORTANT: Run the canonical Supabase migration once before production use.
============================================================================
*/

