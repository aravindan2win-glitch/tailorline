// api/_lib.js — shared helpers for accounts, entitlement (passes) and weekly usage.
// Underscore-prefixed so Vercel does NOT treat it as a route.
// Reads/writes Supabase via its REST API using the SECRET service key (server-only).

var SUPABASE_URL  = process.env.SUPABASE_URL  || "https://raxaqgoggonufwkiysvx.supabase.co";
var SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_xf0yZ_qasjCFStY-_7MUGg_oopHUcHX";
var SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || "";   // sb_secret_...  (set in Vercel)

var TAILOR_FREE_PER_WEEK = 5;

// Monday (UTC) of the current week as YYYY-MM-DD — the weekly reset anchor.
function weekStart(d){
  d = d || new Date();
  var dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  var m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return m.toISOString().slice(0, 10);
}

// Verify the caller's Supabase access token -> { email, id } or null.
async function verifyUser(req){
  var h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  var token = h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
  if(!token) return null;
  try{
    var r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers:{ apikey:SUPABASE_ANON, Authorization:"Bearer " + token } });
    if(!r.ok) return null;
    var u = await r.json();
    return (u && u.email) ? { email:String(u.email).toLowerCase(), id:u.id } : null;
  }catch(e){ return null; }
}

// Supabase REST (PostgREST) call with the service key (bypasses row-level security).
async function supa(path, opts){
  opts = opts || {};
  var headers = Object.assign({
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json"
  }, opts.headers || {});
  var r = await fetch(SUPABASE_URL + "/rest/v1/" + path, { method:opts.method || "GET", headers:headers, body:opts.body });
  var text = await r.text(), data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){}
  return { ok:r.ok, status:r.status, data:data };
}

async function getPass(email){
  var r = await supa("passes?email=eq." + encodeURIComponent(email) + "&select=plan,expires_at", {});
  var row = r.data && r.data[0];
  if(!row || !row.expires_at) return { active:false };
  return { active: new Date(row.expires_at).getTime() > Date.now(), plan:row.plan, expires_at:row.expires_at };
}

// Grant/extend a pass. Extends from the later of (now, current expiry) so stacking is fair.
async function grantPass(email, plan){
  var days = (plan === "month") ? 30 : 7;
  var cur = await getPass(email);
  var base = (cur.active && cur.expires_at) ? new Date(cur.expires_at).getTime() : Date.now();
  var exp = new Date(base + days * 86400000).toISOString();
  await supa("passes", {
    method:"POST",
    headers:{ Prefer:"resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ email:email, plan:plan, expires_at:exp, updated_at:new Date().toISOString() })
  });
  return { active:true, plan:plan, expires_at:exp };
}

async function getTailorUsage(email){
  var wk = weekStart();
  var r = await supa("usage?email=eq." + encodeURIComponent(email) + "&action=eq.tailor&week_start=eq." + wk + "&select=count", {});
  var row = r.data && r.data[0];
  return { week_start:wk, count: row ? (row.count || 0) : 0 };
}

async function incTailorUsage(email){
  var wk = weekStart();
  var u = await getTailorUsage(email);               // small read-then-write; fine at per-user volume
  var next = u.count + 1;
  await supa("usage", {
    method:"POST",
    headers:{ Prefer:"resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ email:email, action:"tailor", week_start:wk, count:next, updated_at:new Date().toISOString() })
  });
  return next;
}

module.exports = {
  SUPABASE_URL: SUPABASE_URL,
  TAILOR_FREE_PER_WEEK: TAILOR_FREE_PER_WEEK,
  weekStart: weekStart,
  verifyUser: verifyUser,
  supa: supa,
  getPass: getPass,
  grantPass: grantPass,
  getTailorUsage: getTailorUsage,
  incTailorUsage: incTailorUsage
};
