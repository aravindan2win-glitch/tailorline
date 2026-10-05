// Tailorline — "Target companies".
// From the candidate's resume, the AI finds peer companies of their most recent employer (same
// country, similar industry/size/stage), then we best-effort verify which are hiring that function
// by checking each company's real ATS board (Greenhouse / Lever / Ashby).
// POST /api/targets { resume }  ->  { lastCompany, targetFunction, region, companies:[...] }
// Env: GEMINI_API_KEY (same key as /api/tailor), optional GEMINI_MODEL.

var SYS = [
  "You are a sharp career advisor. Read the candidate's resume and do three things:",
  "1. Identify their MOST RECENT employer, and the FUNCTION/role they are targeting next (infer from their latest title and strongest skills).",
  "2. Determine the candidate's country from the resume (locations, phone code). Use \"US\" or \"India\" when clear, otherwise your best guess.",
  "3. Suggest EXACTLY 8 real, currently-operating companies the candidate should target next: peers of their most recent employer by industry, size, and stage, where hiring for that function is plausible. Strongly prefer companies based in the candidate's OWN country. Never include the candidate's current or most-recent employer. Favour well-known companies.",
  "",
  "For each company give: a one-line reason it fits (industry / size / stage), the company's careers page URL if you know it, and your best guess of its job-board slug on Greenhouse, Lever and Ashby (usually the lowercase company name with no spaces; leave blank if unsure).",
  "",
  "Output ONLY valid minified JSON (no markdown, no commentary), exactly this shape:",
  '{"lastCompany":"","targetFunction":"","region":"","companies":[{"name":"","why":"","careersUrl":"","gh":"","lever":"","ashby":""}]}'
].join("\n");

function clean(s){ return String(s || "").replace(/\s+/g, " ").trim(); }

async function getJSON(url){
  var c = new AbortController(), t = setTimeout(function(){ c.abort(); }, 4500);
  try{ var r = await fetch(url, { signal:c.signal, headers:{ "User-Agent":"Tailorline" } }); if(!r.ok) return null; return await r.json(); }
  catch(e){ return null; } finally{ clearTimeout(t); }
}
async function boardJobs(src, token){
  if(!token) return [];
  if(src === "gh"){ var j = await getJSON("https://boards-api.greenhouse.io/v1/boards/" + token + "/jobs"); if(!j || !j.jobs) return []; return j.jobs.map(function(x){ return { title:clean(x.title), url:x.absolute_url || "" }; }); }
  if(src === "lever"){ var l = await getJSON("https://api.lever.co/v0/postings/" + token + "?mode=json"); if(!Array.isArray(l)) return []; return l.map(function(x){ return { title:clean(x.text), url:x.hostedUrl || x.applyUrl || "" }; }); }
  if(src === "ashby"){ var a = await getJSON("https://api.ashbyhq.com/posting-api/job-board/" + token); if(!a || !a.jobs) return []; return a.jobs.map(function(x){ return { title:clean(x.title), url:x.jobUrl || x.applyUrl || "" }; }); }
  return [];
}
function slugify(name){ return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function funcTerms(func){
  var stop = {manager:1,senior:1,lead:1,director:1,specialist:1,head:1,associate:1,executive:1,principal:1,staff:1,vp:1,chief:1,officer:1,sr:1,jr:1,junior:1,of:1,and:1,the:1};
  return clean(func).toLowerCase().split(/\s+/).filter(function(w){ return w.length > 2 && !stop[w]; });
}
function roleMatches(title, terms){ if(!terms.length) return true; var t = title.toLowerCase(); for(var i=0;i<terms.length;i++){ if(t.indexOf(terms[i]) !== -1) return true; } return false; }

async function verifyCompany(co, terms){
  var attempts = [];
  if(co.gh) attempts.push(["gh", co.gh]);
  if(co.lever) attempts.push(["lever", co.lever]);
  if(co.ashby) attempts.push(["ashby", co.ashby]);
  var s = slugify(co.name);
  if(s){ attempts.push(["gh", s]); attempts.push(["lever", s]); }
  var seen = {}, uniq = [];
  attempts.forEach(function(a){ var k = a[0] + ":" + a[1]; if(a[1] && !seen[k]){ seen[k] = 1; uniq.push(a); } });
  uniq = uniq.slice(0, 4);
  var lists = await Promise.all(uniq.map(function(a){ return boardJobs(a[0], a[1]).catch(function(){ return []; }); }));
  var jobs = []; lists.forEach(function(l){ if(l.length > jobs.length) jobs = l; }); // the real board is the one with the most jobs
  var matched = jobs.filter(function(j){ return j.url && roleMatches(j.title, terms); });
  return { hiring: matched.length > 0, matchCount: matched.length, roles: matched.slice(0, 3).map(function(j){ return { title:j.title, url:j.url }; }) };
}

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// Call Gemini, retrying through transient "model overloaded / high demand" spikes (429 / 500 / 502 / 503).
async function callGemini(url, payload){
  var attempts = 4, delays = [1200, 2500, 4500]; // ~8s worst case, well inside the 60s budget
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
    await sleep(delays[i] || 4500);
  }
  return last;
}

module.exports = async function handler(req, res){
  var key = process.env.GEMINI_API_KEY;
  if(!key){ res.status(500).json({ error: "Not configured yet" }); return; }
  try{
    var body = req.body;
    if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
    body = body || {};
    var resume = String(body.resume || "").slice(0, 16000);
    if(resume.trim().length < 60){ res.status(400).json({ error: "Add your resume first" }); return; }

    var model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    var out = await callGemini(url, {
      systemInstruction:{ parts:[{ text:SYS }] },
      contents:[{ role:"user", parts:[{ text:"RESUME:\n" + resume }] }],
      generationConfig:{ temperature:0.5, maxOutputTokens:2048 }
    });
    var data = out.data;
    if(!out.ok){
      var msg = (data && data.error && data.error.message) || "AI error";
      // friendlier wording for the common overload case
      if(/high demand|overload|try again|unavailable|exhausted|quota|rate/i.test(msg)){
        msg = "The AI is busy right now — give it a few seconds and tap the button again.";
      }
      res.status(502).json({ error: msg }); return;
    }
    var txt = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map(function(p){ return p.text || ""; }).join("")) || "";
    txt = txt.replace(/```json?/gi, "").replace(/```/g, "").trim();
    var a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    var parsed; try{ parsed = JSON.parse(txt.slice(a, b + 1)); }catch(e){ res.status(502).json({ error: "Could not parse suggestions" }); return; }

    var companies = (parsed.companies || []).slice(0, 8);
    var terms = funcTerms(parsed.targetFunction || "");
    var enriched = await Promise.all(companies.map(function(c){
      return verifyCompany(c, terms).then(function(v){
        return { name:clean(c.name), why:clean(c.why), careersUrl:(c.careersUrl || ""), hiring:v.hiring, matchCount:v.matchCount, roles:v.roles };
      }).catch(function(){
        return { name:clean(c.name), why:clean(c.why), careersUrl:(c.careersUrl || ""), hiring:false, matchCount:0, roles:[] };
      });
    }));
    enriched = enriched.filter(function(c){ return c.name; });
    enriched.sort(function(x, y){ return (y.hiring?1:0) - (x.hiring?1:0) || (y.matchCount - x.matchCount); });

    res.status(200).json({
      lastCompany: clean(parsed.lastCompany),
      targetFunction: clean(parsed.targetFunction),
      region: clean(parsed.region),
      companies: enriched
    });
  }catch(e){
    res.status(500).json({ error: "Unexpected error" });
  }
};
