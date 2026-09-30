// Tailorline — free "ingest" job board.
// Pulls live from real companies' own ATS boards (Greenhouse + Ashby). No API key, no cost.
// Apply links go straight to each employer's own careers page.
// GET /api/jobs?q=<keywords>&where=<city/state>&page=<n>  ->  { jobs:[...], total }

// Curated, verified company career boards. To add a company, add one line here.
var COMPANIES = [
  // ---- United States (Greenhouse) ----
  { src:"gh", token:"stripe",     name:"Stripe" },
  { src:"gh", token:"coinbase",   name:"Coinbase" },
  { src:"gh", token:"robinhood",  name:"Robinhood" },
  { src:"gh", token:"brex",       name:"Brex" },
  { src:"gh", token:"asana",      name:"Asana" },
  { src:"gh", token:"twilio",     name:"Twilio" },
  { src:"gh", token:"cloudflare", name:"Cloudflare" },
  { src:"gh", token:"pinterest",  name:"Pinterest" },
  { src:"gh", token:"reddit",     name:"Reddit" },
  { src:"gh", token:"discord",    name:"Discord" },
  { src:"gh", token:"instacart",  name:"Instacart" },
  { src:"gh", token:"gitlab",     name:"GitLab" },
  { src:"gh", token:"databricks", name:"Databricks" },
  { src:"gh", token:"samsara",    name:"Samsara" },
  { src:"gh", token:"flexport",   name:"Flexport" },
  { src:"gh", token:"dropbox",    name:"Dropbox" },
  { src:"gh", token:"lyft",       name:"Lyft" },
  { src:"gh", token:"airbnb",     name:"Airbnb" },
  { src:"gh", token:"affirm",     name:"Affirm" },
  { src:"gh", token:"datadog",    name:"Datadog" },
  { src:"gh", token:"gusto",      name:"Gusto" },
  { src:"gh", token:"lattice",    name:"Lattice" },
  { src:"gh", token:"checkr",     name:"Checkr" },
  // ---- United States (Ashby) ----
  { src:"ashby", token:"openai",  name:"OpenAI" },
  { src:"ashby", token:"notion",  name:"Notion" },
  // ---- India (Greenhouse) ----
  { src:"gh", token:"razorpaysoftwareprivatelimited", name:"Razorpay" },
  { src:"gh", token:"groww",      name:"Groww" },
  // ---- India (Lever) ----
  { src:"lever", token:"cred",       name:"CRED" },
  { src:"lever", token:"mindtickle", name:"Mindtickle" },
  { src:"lever", token:"porter",     name:"Porter" },
  { src:"lever", token:"meesho",     name:"Meesho" }
];

var CACHE = { at: 0, jobs: [] };
var TTL = 30 * 60 * 1000; // 30 min in-memory cache (per warm instance)

function clean(s){ return String(s || "").replace(/\s+/g, " ").trim(); }

async function getJSON(url){
  var c = new AbortController(), t = setTimeout(function(){ c.abort(); }, 7000);
  try{ var r = await fetch(url, { signal:c.signal, headers:{ "User-Agent":"Tailorline" } });
       if(!r.ok) return null; return await r.json(); }
  catch(e){ return null; }
  finally{ clearTimeout(t); }
}

async function fetchCompany(co){
  if(co.src === "gh"){
    var j = await getJSON("https://boards-api.greenhouse.io/v1/boards/" + co.token + "/jobs");
    if(!j || !j.jobs) return [];
    return j.jobs.map(function(x){
      return { id:String(x.id), title:clean(x.title), company:co.name,
        location:clean(x.location && x.location.name), created:x.updated_at || "",
        url:x.absolute_url || "", gh:co.token, description:"" };
    });
  }
  if(co.src === "lever"){
    var l = await getJSON("https://api.lever.co/v0/postings/" + co.token + "?mode=json");
    if(!Array.isArray(l)) return [];
    return l.map(function(x){
      var loc = (x.categories && x.categories.location) || "";
      return { id:String(x.id || ""), title:clean(x.text), company:co.name,
        location:clean(loc), created: x.createdAt ? new Date(x.createdAt).toISOString() : "",
        url:x.hostedUrl || x.applyUrl || "", gh:"", description:clean(x.descriptionPlain || "") };
    });
  }
  if(co.src === "ashby"){
    var a = await getJSON("https://api.ashbyhq.com/posting-api/job-board/" + co.token);
    if(!a || !a.jobs) return [];
    return a.jobs.map(function(x){
      return { id:String(x.id||x.uuid||""), title:clean(x.title), company:co.name,
        location:clean(x.location || (x.isRemote ? "Remote" : "")),
        created:x.publishedDate || x.publishedAt || "",
        url:x.jobUrl || x.applyUrl || "", gh:"", description:clean(x.descriptionPlain || "") };
    });
  }
  return [];
}

async function loadAll(){
  if(Date.now() - CACHE.at < TTL && CACHE.jobs.length) return CACHE.jobs;
  var results = await Promise.all(COMPANIES.map(function(co){
    return fetchCompany(co).catch(function(){ return []; });
  }));
  var all = [];
  results.forEach(function(list){ list.forEach(function(j){ if(j.title && j.url) all.push(j); }); });
  if(all.length){ CACHE = { at: Date.now(), jobs: all }; }
  return all.length ? all : CACHE.jobs;
}

module.exports = async function handler(req, res){
  try{
    var qp = req.query || {};
    var what = clean(qp.q).toLowerCase().slice(0, 120);
    var where = clean(qp.where).toLowerCase().slice(0, 80);
    var page = parseInt(qp.page, 10); if(!(page >= 1)) page = 1; if(page > 50) page = 50;
    if(!what){ res.status(400).json({ error: "Enter a job title or keyword" }); return; }

    var all = await loadAll();
    var terms = what.split(/\s+/).filter(Boolean);
    var matched = all.filter(function(j){
      var hay = (j.title + " " + j.company + " " + j.location + " " + j.description).toLowerCase();
      for(var i=0;i<terms.length;i++){ if(hay.indexOf(terms[i]) === -1) return false; }
      if(where){ var loc=(j.location||"").toLowerCase(); if(loc.indexOf(where)===-1 && loc.indexOf("remote")===-1) return false; }
      return true;
    });
    // newest first when we have dates
    matched.sort(function(a,b){ return (Date.parse(b.created)||0) - (Date.parse(a.created)||0); });

    var per = 10, start = (page-1)*per;
    var pageJobs = matched.slice(start, start+per).map(function(j){
      return { id:j.id, title:j.title, company:j.company, location:j.location,
        created:j.created, salary:"", description:j.description, url:j.url, source:"", gh:j.gh };
    });

    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ jobs: pageJobs, total: matched.length });
  }catch(e){
    res.status(500).json({ error: "Unexpected error" });
  }
};
