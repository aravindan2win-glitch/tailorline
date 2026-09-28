// Tailorline — fetch one Greenhouse job's full description on demand (for "Tailor to this job").
// GET /api/job?token=<board>&id=<jobId>  ->  { description, title }

module.exports = async function handler(req, res){
  try{
    var qp = req.query || {};
    var token = String(qp.token || "").replace(/[^a-z0-9_.-]/gi, "").slice(0, 60);
    var id = String(qp.id || "").replace(/[^0-9]/g, "").slice(0, 24);
    if(!token || !id){ res.status(400).json({ error: "Missing job" }); return; }

    var c = new AbortController(), t = setTimeout(function(){ c.abort(); }, 7000);
    var r = await fetch("https://boards-api.greenhouse.io/v1/boards/" + token + "/jobs/" + id, { signal:c.signal });
    clearTimeout(t);
    var j = await r.json();
    if(!r.ok || !j){ res.status(502).json({ error: "Could not load job" }); return; }

    var txt = String(j.content || "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;/g, '"').replace(/&hellip;/g, "...").replace(/&nbsp;/g, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    res.setHeader("Cache-Control", "public, s-maxage=86400");
    res.status(200).json({ description: txt, title: j.title || "" });
  }catch(e){
    res.status(500).json({ error: "Unexpected error" });
  }
};
