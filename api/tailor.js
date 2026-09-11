// Tailorline — server-side résumé tailoring endpoint (Vercel serverless function).
// POST /api/tailor  { resume, jd }  ->  { html }
// Your Gemini key lives ONLY here, in Vercel's environment variables — never in the public page.
//
// Required environment variable:  GEMINI_API_KEY
// Optional environment variable:  GEMINI_MODEL   (default: gemini-3.6-flash)

var SYS = [
  "You are an expert resume writer and ATS specialist. Rewrite the candidate's resume to match the target job description while keeping every fact strictly truthful.",
  "",
  "TRUTH:",
  "- Never invent employers, titles, dates, degrees, or metrics. Keep all dates, company names, and job titles EXACTLY as in the base resume.",
  "- Naturally weave in the skills, tools, and terminology from the job description where they genuinely apply.",
  "",
  "TONE:",
  "- No em-dashes. Never use words like spearheaded, leveraged, utilized, synergy, pivotal, testament, delved, fostered, dynamic, seamless, robust, transformative, plethora.",
  "- Start every bullet with a plain action verb (Built, Led, Managed, Grew, Ran, Designed, Cut, Launched).",
  "",
  "OUTPUT — return ONLY a flat sequence of these exact tags, nothing else:",
  "- <h1> once — the candidate's name.",
  "- <p class=\"contact\"> once — the single contact line, right after the name.",
  "- <h2> — a section title. Use ONLY for real sections: Professional Summary, Professional Experience, Skills, Education (also Certifications / Projects / Languages if present).",
  "- <p class=\"role\"> — one per job, formatted exactly 'Company | Title | Dates'. Keep it to ONE short line. Do NOT put a company description or the words 'Key Achievements' in it.",
  "- <p> — a normal paragraph, e.g. the summary text or a single one-line company description.",
  "- <ul> with <li> — bullets. Each <li> is ONE complete sentence.",
  "",
  "STRICT RULES (follow all):",
  "- Do NOT use <strong>, <b>, <h3>, <div>, <br>, markdown, code fences, <style>, inline style attributes, or <html>/<head>/<body>.",
  "- NEVER write labels like 'Key Achievements' or 'Profile Summary' as body text. A section heading is an <h2> and nothing else.",
  "- NEVER split one sentence across an <li> and a following paragraph. NEVER leave loose text outside a tag — every piece of text sits inside one tag above.",
  "- Each job block is: one <p class=\"role\">, then an optional single <p> description, then one <ul> of 3-5 <li>. Then the next job's <p class=\"role\">.",
  "- Order: name, contact, Professional Summary, Professional Experience, Skills, Education, then any remaining sections."
].join("\n");

// Best-effort per-IP rate limit. Serverless instances are short-lived, so this
// is a light guard, not airtight — set a hard spend cap in Google AI/Cloud too.
var HITS = {};
function limited(ip){
  var now = Date.now(), win = 60 * 60 * 1000, max = 20; // ~20 / hour / IP
  var arr = (HITS[ip] || []).filter(function(t){ return now - t < win; });
  arr.push(now); HITS[ip] = arr;
  return arr.length > max;
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){ res.status(405).json({ error: "Method not allowed" }); return; }

  var key = process.env.GEMINI_API_KEY;
  if(!key){ res.status(500).json({ error: "Server not configured yet" }); return; }

  try{
    var body = req.body;
    if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
    body = body || {};

    var resume = String(body.resume || "").slice(0, 20000);
    var jd = String(body.jd || "").slice(0, 20000);
    if(resume.trim().length < 40 || jd.trim().length < 40){
      res.status(400).json({ error: "Resume and job description are both required" });
      return;
    }

    var fwd = req.headers["x-forwarded-for"] || "";
    var ip = (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim() || "unknown";
    if(limited(ip)){ res.status(429).json({ error: "Too many requests — please try again in a little while" }); return; }

    var model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    var user = "--- TARGET JOB DESCRIPTION ---\n" + jd + "\n\n--- BASE RESUME TEXT ---\n" + resume;

    var r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
      })
    });
    var data = await r.json();
    if(!r.ok){
      res.status(502).json({ error: (data && data.error && data.error.message) || "AI service error" });
      return;
    }
    var c = data.candidates && data.candidates[0];
    var html = c && c.content && c.content.parts && c.content.parts.map(function(p){ return p.text || ""; }).join("");
    if(!html){ res.status(502).json({ error: "Empty response from the model" }); return; }

    html = html.replace(/```html?/gi, "").replace(/```/g, "")
               .replace(/<script[\s\S]*?<\/script>/gi, "")
               .trim();

    res.status(200).json({ html: html });
  }catch(e){
    res.status(500).json({ error: "Unexpected server error" });
  }
};
