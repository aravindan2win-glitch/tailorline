// Tailorline — "Find matching jobs".
// The user names a company they'd love to work at (or their current one) and their field.
// The AI reasons about that company's size, stage, funding and competitors to build a list of 20
// similar companies where that field is hiring. We then best-effort verify which of those have
// OPEN roles in that field right now by checking each company's real ATS board (Greenhouse /
// Lever / Ashby) — confirmed ones get direct role links; the rest get a careers-page link.
// POST /api/targets { company, specialization, exclude? }
//   -> { company, specialization, companies:[{name,why,size,stage,hq,careersUrl,hiring,matchCount,roles}] }
// Requires sign-in (protects the Gemini spend). Env: GEMINI_API_KEY, optional GEMINI_MODEL.

var lib = require("./_lib");

var SYS = [
  "You are a sharp career advisor with deep knowledge of companies worldwide.",
  "The user gives you ONE company they admire (or currently work at) and ONE professional field (specialization).",
  "Think carefully about that company: its industry, what it does, its size (employee count), its funding stage / maturity, its notable competitors, and companies widely seen as similar or in the same space.",
  "",
  "Then suggest EXACTLY 20 real, currently-operating companies that are STRONG PEERS of the given company — similar by industry, size, stage and the kind of work — and where hiring in the given field is plausible. Include direct competitors and well-known similar companies. Never include the given company itself. Favour companies the user would recognise and realistically want to work at. If a \"DO NOT REPEAT\" list is given, none of your 20 may appear on it — suggest 20 fresh, different peers.",
  "",
  "For EACH of the 20 companies provide:",
  "- name: the company name.",
  "- why: a short one-line reason it's a peer of the given company (industry / size / stage / why similar).",
  "- size: a rough employee-count band from your knowledge, e.g. \"~500 employees\", \"5,000-10,000\", \"10k+\". Best estimate; never say unknown.",
  "- stage: funding/maturity in a couple of words, e.g. \"Series B\", \"Late-stage private\", \"Public (NASDAQ)\", \"Bootstrapped\".",
  "- hq: headquarters city and country, e.g. \"Bengaluru, India\" or \"San Francisco, US\".",
  "- careersUrl: the company's careers / jobs page URL if you know it (best guess is fine).",
  "- gh, lever, ashby, smartrecruiters, workable, recruitee: your best guess of the company's job-board slug on each of these ATS providers (usually the lowercase company name with no spaces, e.g. \"acmecorp\"). Fill in the ones you can guess; leave a field blank only if you truly have no guess.",
  "",
  "Output ONLY valid minified JSON (no markdown, no commentary), exactly this shape:",
  '{"companies":[{"name":"","why":"","size":"","stage":"","hq":"","careersUrl":"","gh":"","lever":"","ashby":"","smartrecruiters":"","workable":"","recruitee":""}]}'
].join("\n");

function clean(s){ return String(s || "").replace(/\s+/g, " ").trim(); }

// Pull the company objects out of the model's text, even if the JSON is truncated
// (20 companies is a lot of output; a cut-off array shouldn't lose everything).
function parseCompanies(txt){
  var a = txt.indexOf("{"), b = txt.lastIndexOf("}");
  if(a >= 0 && b > a){ try{ var o = JSON.parse(txt.slice(a, b + 1)); if(o && Array.isArray(o.companies)) return o.companies; }catch(e){} }
  // salvage: grab the companies array and parse each complete {...} object we can
  var out = [], m = txt.match(/"companies"\s*:\s*\[/);
  if(m){
    var rest = txt.slice(m.index + m[0].length);
    var objRe = /\{[^{}]*\}/g, mm;           // company objects are flat (no nesting)
    while((mm = objRe.exec(rest))){ try{ out.push(JSON.parse(mm[0])); }catch(e){} }
  }
  return out;
}

async function getJSON(url){
  var c = new AbortController(), t = setTimeout(function(){ c.abort(); }, 3000);
  try{ var r = await fetch(url, { signal:c.signal, headers:{ "User-Agent":"Tailorline" } }); if(!r.ok) return null; return await r.json(); }
  catch(e){ return null; } finally{ clearTimeout(t); }
}
async function boardJobs(src, token){
  if(!token) return [];
  if(src === "gh"){ var j = await getJSON("https://boards-api.greenhouse.io/v1/boards/" + token + "/jobs"); if(!j || !j.jobs) return []; return j.jobs.map(function(x){ return { title:clean(x.title), url:x.absolute_url || "" }; }); }
  if(src === "lever"){ var l = await getJSON("https://api.lever.co/v0/postings/" + token + "?mode=json"); if(!Array.isArray(l)) return []; return l.map(function(x){ return { title:clean(x.text), url:x.hostedUrl || x.applyUrl || "" }; }); }
  if(src === "ashby"){ var a = await getJSON("https://api.ashbyhq.com/posting-api/job-board/" + token); if(!a || !a.jobs) return []; return a.jobs.map(function(x){ return { title:clean(x.title), url:x.jobUrl || x.applyUrl || "" }; }); }
  if(src === "smartrecruiters"){ var s = await getJSON("https://api.smartrecruiters.com/v1/companies/" + token + "/postings?limit=100"); if(!s || !s.content) return []; return s.content.map(function(x){ return { title:clean(x.name), url:x.id ? ("https://jobs.smartrecruiters.com/" + token + "/" + x.id) : "" }; }); }
  if(src === "workable"){ var w = await getJSON("https://apply.workable.com/api/v1/widget/accounts/" + token + "?details=true"); if(!w || !w.jobs) return []; return w.jobs.map(function(x){ return { title:clean(x.title), url:x.url || x.application_url || (x.shortcode ? ("https://apply.workable.com/" + token + "/j/" + x.shortcode + "/") : "") }; }); }
  if(src === "recruitee"){ var rc = await getJSON("https://" + token + ".recruitee.com/api/offers/"); if(!rc || !rc.offers) return []; return rc.offers.map(function(x){ return { title:clean(x.title), url:x.careers_url || x.url || "" }; }); }
  return [];
}
function slugify(name){ return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }

// Map a friendly field label to the keywords we look for in real job titles.
var SPEC_MAP = {
  "sales": ["sales","account executive","account manager","business development","revenue","sdr","bdr"],
  "marketing": ["marketing","brand","growth","demand gen","content","seo","social media","communications","pr"],
  "engineering / it": ["engineer","developer","software","sde","it ","devops","sre","platform","backend","frontend","full stack","infrastructure","security","qa"],
  "product": ["product manager","product owner","product lead","pm ","product analyst"],
  "design": ["design","designer","ux","ui","user experience","creative"],
  "data / analytics": ["data","analytics","analyst","data scientist","machine learning","ml ","bi ","business intelligence"],
  "finance / accounting": ["finance","accounting","accountant","controller","fp&a","treasury","audit","tax"],
  "operations": ["operations","ops ","program manager","project manager","process"],
  "supply chain / logistics": ["supply chain","logistics","procurement","warehouse","inventory","fulfilment","fulfillment","demand planning","sourcing"],
  "human resources": ["human resources","hr ","people","talent","recruit","recruiter","recruiting","compensation","benefits"],
  "customer success / support": ["customer success","customer support","support","customer experience","account manager","implementation","onboarding"],
  "business development": ["business development","partnerships","bd ","alliances","corporate development"],
  "consulting / strategy": ["consultant","consulting","strategy","strategic","advisory"]
};
function specTerms(spec){
  var key = clean(spec).toLowerCase();
  if(SPEC_MAP[key]) return SPEC_MAP[key];
  // fall back to the significant words of whatever they typed
  var stop = {and:1,the:1,of:1,"/":1};
  return key.split(/[\s/]+/).filter(function(w){ return w.length > 2 && !stop[w]; });
}
function roleMatches(title, terms){ if(!terms.length) return true; var t = (" "+title.toLowerCase()+" "); for(var i=0;i<terms.length;i++){ if(t.indexOf(terms[i]) !== -1) return true; } return false; }

async function verifyCompany(co, terms){
  var attempts = [];
  if(co.gh) attempts.push(["gh", co.gh]);
  if(co.lever) attempts.push(["lever", co.lever]);
  if(co.ashby) attempts.push(["ashby", co.ashby]);
  if(co.smartrecruiters) attempts.push(["smartrecruiters", co.smartrecruiters]);
  if(co.workable) attempts.push(["workable", co.workable]);
  if(co.recruitee) attempts.push(["recruitee", co.recruitee]);
  var s = slugify(co.name);
  if(s){ ["gh","lever","ashby","smartrecruiters","workable","recruitee"].forEach(function(src){ attempts.push([src, s]); }); }
  var seen = {}, uniq = [];
  attempts.forEach(function(a){ var k = a[0] + ":" + a[1]; if(a[1] && !seen[k]){ seen[k] = 1; uniq.push(a); } });
  uniq = uniq.slice(0, 8);
  var lists = await Promise.all(uniq.map(function(a){ return boardJobs(a[0], a[1]).catch(function(){ return []; }); }));
  var jobs = []; lists.forEach(function(l){ if(l.length > jobs.length) jobs = l; }); // the real board is the one with the most jobs
  var matched = jobs.filter(function(j){ return j.url && roleMatches(j.title, terms); });
  return { hiring: matched.length > 0, matchCount: matched.length, roles: matched.slice(0, 4).map(function(j){ return { title:j.title, url:j.url }; }) };
}

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// Call Gemini, retrying ONCE through a transient "high demand" spike.
async function callGemini(url, payload){
  var attempts = 2, delays = [1500];
  var last = { ok:false, data:{ error:{ message:"AI error" } } };
  for(var i=0;i<attempts;i++){
    try{
      var r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
      var data = await r.json();
      if(r.ok) return { ok:true, data:data };
      last = { ok:false, data:data, status:r.status };
      var transient = (r.status===429 || r.status>=500);
      if(!transient || i===attempts-1) return last;
    }catch(e){
      last = { ok:false, data:{ error:{ message:"Network error reaching the AI" } } };
      if(i===attempts-1) return last;
    }
    await sleep(delays[i] || 1500);
  }
  return last;
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){ res.status(405).json({ error: "Method not allowed" }); return; }
  var key = process.env.GEMINI_API_KEY;
  if(!key){ res.status(500).json({ error: "Not configured yet" }); return; }

  // sign-in required so anonymous traffic can't run up the AI bill
  var user = await lib.verifyUser(req);
  if(!user){ res.status(401).json({ error: "Please sign in to find matching jobs." }); return; }

  try{
    var body = req.body;
    if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
    body = body || {};
    var company = clean(body.company || "").slice(0, 120);
    var specialization = clean(body.specialization || "").slice(0, 80);
    if(!company){ res.status(400).json({ error: "Tell me which company to match" }); return; }
    if(!specialization){ res.status(400).json({ error: "Pick your field first" }); return; }
    var exclude = Array.isArray(body.exclude) ? body.exclude.map(clean).filter(Boolean).slice(0, 60) : [];

    var userText = "COMPANY TO MATCH: " + company + "\nFIELD / SPECIALIZATION: " + specialization;
    if(exclude.length){ userText += "\n\nDO NOT REPEAT (already shown — suggest 20 different peers): " + exclude.join(", "); }

    var model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    var out = await callGemini(url, {
      systemInstruction:{ parts:[{ text:SYS }] },
      contents:[{ role:"user", parts:[{ text:userText }] }],
      generationConfig:{ temperature:0.6, maxOutputTokens:8192 }
    });
    var data = out.data;
    if(!out.ok){
      var msg = (data && data.error && data.error.message) || "AI error";
      if(/high demand|overload|try again|unavailable|exhausted|quota|rate/i.test(msg)){
        msg = "The AI is busy right now — give it a few seconds and tap the button again.";
      }
      res.status(502).json({ error: msg }); return;
    }
    var txt = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map(function(p){ return p.text || ""; }).join("")) || "";
    txt = txt.replace(/```json?/gi, "").replace(/```/g, "").trim();
    var rawCompanies = parseCompanies(txt);
    if(!rawCompanies.length){ res.status(502).json({ error: "The AI is busy right now — give it a few seconds and tap the button again." }); return; }

    // drop anything on the exclude list or the company itself, then cap at 20
    var low = company.toLowerCase(), ex = {}; exclude.forEach(function(e){ ex[e.toLowerCase()] = 1; });
    var companies = rawCompanies.filter(function(c){
      var n = clean(c && c.name); if(!n) return false;
      var k = n.toLowerCase(); return k !== low && !ex[k];
    }).slice(0, 20);

    var terms = specTerms(specialization);
    var enriched = await Promise.all(companies.map(function(c){
      return verifyCompany(c, terms).then(function(v){
        return { name:clean(c.name), why:clean(c.why), size:clean(c.size), stage:clean(c.stage), hq:clean(c.hq), careersUrl:(c.careersUrl || ""), hiring:v.hiring, matchCount:v.matchCount, roles:v.roles };
      }).catch(function(){
        return { name:clean(c.name), why:clean(c.why), size:clean(c.size), stage:clean(c.stage), hq:clean(c.hq), careersUrl:(c.careersUrl || ""), hiring:false, matchCount:0, roles:[] };
      });
    }));
    enriched = enriched.filter(function(c){ return c.name; });
    // confirmed-hiring companies first, then by how many matching roles
    enriched.sort(function(x, y){ return (y.hiring?1:0) - (x.hiring?1:0) || (y.matchCount - x.matchCount); });

    res.status(200).json({
      company: company,
      specialization: specialization,
      companies: enriched
    });
  }catch(e){
    res.status(500).json({ error: "Unexpected error" });
  }
};
