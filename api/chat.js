// POST /api/chat { resume, jd?, message } -> { reply, updatedResumeHtml? }
// Résumé assistant: answers questions from the résumé and can edit it on request.
// Env: GEMINI_API_KEY, optional GEMINI_MODEL. Requires sign-in (via ./_lib).
var lib = require("./_lib");

var SYS = [
  "You are Tailorline's résumé assistant. You help the candidate with the résumé shown below (an HTML fragment).",
  "Decide what the user wants:",
  "- If they ask a QUESTION — about their résumé, or to draft an answer to a job-application / questionnaire question using facts from the résumé — answer concisely and helpfully in \"reply\". Leave \"updatedResumeHtml\" as an empty string.",
  "- If they ask to CHANGE the résumé (add skills or keywords, reword, shorten, add or trim a bullet, fix wording), return the FULL updated résumé as an HTML fragment in \"updatedResumeHtml\", and a one-line summary of what you changed in \"reply\".",
  "",
  "When editing, keep every fact truthful: never invent employers, titles, dates, degrees or metrics. Only add skills/keywords the user asked for or that the résumé genuinely supports.",
  "Keep the SAME HTML format as the résumé: <h1> for the name, <p class=\"contact\"> for the contact line, <h2> for section titles, <p class=\"role\"> for role lines ('Company | Title | Dates'), <p> for paragraphs, <ul><li> for bullets. No markdown, no code fences, no <style>, no inline styles, no <html>/<head>/<body>. Each <li> is one complete sentence; never split a sentence across tags.",
  "Fix any obvious typos or dropped-ligature artifacts (e.g. 'Markeng'->'Marketing').",
  "",
  "Output ONLY valid minified JSON, exactly this shape: {\"reply\":\"\",\"updatedResumeHtml\":\"\"}  — use an empty string for updatedResumeHtml when you are only answering a question."
].join("\n");

var HITS = {};
function limited(ip){
  var now = Date.now(), win = 60*60*1000, max = 40; // ~40 messages / hour / IP
  var a = (HITS[ip] || []).filter(function(t){ return now - t < win; });
  a.push(now); HITS[ip] = a;
  return a.length > max;
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){ res.status(405).json({ error: "Method not allowed" }); return; }
  var key = process.env.GEMINI_API_KEY;
  if(!key){ res.status(500).json({ error: "Server not configured yet" }); return; }

  var user = await lib.verifyUser(req);
  if(!user){ res.status(401).json({ error: "Please sign in to use the assistant." }); return; }

  try{
    var body = req.body;
    if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
    body = body || {};
    var resume = String(body.resume || "").slice(0, 20000);
    var jd = String(body.jd || "").slice(0, 8000);
    var msg = String(body.message || "").slice(0, 2000).trim();
    if(!msg){ res.status(400).json({ error: "Type a message first" }); return; }
    if(resume.trim().length < 30){ res.status(400).json({ error: "Tailor or add your résumé first" }); return; }

    var fwd = req.headers["x-forwarded-for"] || "";
    var ip = (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim() || "unknown";
    if(limited(ip)){ res.status(429).json({ error: "Too many messages — try again in a little while" }); return; }

    var model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    var userText = "CURRENT RESUME (HTML):\n" + resume + (jd ? ("\n\nTARGET JOB DESCRIPTION:\n" + jd) : "") + "\n\nUSER MESSAGE:\n" + msg;

    var r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
      systemInstruction:{ parts:[{ text:SYS }] },
      contents:[{ role:"user", parts:[{ text:userText }] }],
      generationConfig:{ temperature:0.5, maxOutputTokens:4096 }
    })});
    var data = await r.json();
    if(!r.ok){ res.status(502).json({ error:(data && data.error && data.error.message) || "AI error" }); return; }
    var txt = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map(function(p){ return p.text || ""; }).join("")) || "";
    txt = txt.replace(/```json?/gi, "").replace(/```/g, "").trim();
    var a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    var parsed; try{ parsed = JSON.parse(txt.slice(a, b + 1)); }catch(e){ parsed = { reply: txt, updatedResumeHtml: "" }; }

    var upd = String(parsed.updatedResumeHtml || "")
      .replace(/```html?/gi, "").replace(/```/g, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/ on\w+\s*=\s*"[^"]*"/gi, "").trim();

    res.status(200).json({ reply: String(parsed.reply || "").slice(0, 4000), updatedResumeHtml: upd });
  }catch(e){
    res.status(500).json({ error: "Unexpected server error" });
  }
};
