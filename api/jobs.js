// Tailorline — live job search via Adzuna, redirect-to-source model.
// GET /api/jobs?q=<keywords>&where=<US city/state>&page=<n>  ->  { jobs:[...], count }
// Required env vars (free at developer.adzuna.com):  ADZUNA_APP_ID, ADZUNA_APP_KEY

function clean(s){
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&hellip;/g, "...").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
function salaryText(j){
  if(j.salary_min && j.salary_max){
    var a = Math.round(j.salary_min), b = Math.round(j.salary_max);
    return a === b ? ("$" + a.toLocaleString()) : ("$" + a.toLocaleString() + " - $" + b.toLocaleString());
  }
  return "";
}

module.exports = async function handler(req, res){
  var id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if(!id || !key){ res.status(500).json({ error: "Job search is not configured yet" }); return; }
  try{
    var qp = req.query || {};
    var what = String(qp.q || "").slice(0, 120).trim();
    var where = String(qp.where || "").slice(0, 80).trim();
    var page = parseInt(qp.page, 10); if(!(page >= 1)) page = 1; if(page > 20) page = 20;
    if(!what){ res.status(400).json({ error: "Enter a job title or keyword" }); return; }

    var url = "https://api.adzuna.com/v1/api/jobs/us/search/" + page +
      "?app_id=" + encodeURIComponent(id) + "&app_key=" + encodeURIComponent(key) +
      "&results_per_page=10&what=" + encodeURIComponent(what) +
      (where ? ("&where=" + encodeURIComponent(where)) : "") +
      "&content-type=application/json";

    var r = await fetch(url);
    var data = await r.json();
    if(!r.ok){ res.status(502).json({ error: (data && (data.exception || data.error)) || "Job service error" }); return; }

    var jobs = (data.results || []).map(function(j){
      return {
        id: j.id,
        title: clean(j.title),
        company: clean(j.company && j.company.display_name),
        location: clean(j.location && j.location.display_name),
        created: j.created || "",
        salary: salaryText(j),
        description: clean(j.description),
        url: j.redirect_url || ""
      };
    });

    // let Vercel's CDN cache identical searches for 10 min — keeps us well under Adzuna's free limits
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1200");
    res.status(200).json({ jobs: jobs, count: data.count || jobs.length });
  }catch(e){
    res.status(500).json({ error: "Unexpected error" });
  }
};
