// POST /api/checkout { plan:'week'|'month', currency:'INR'|'USD' }
// Creates a Razorpay Order and returns what the browser needs to open Checkout.
// Env (Vercel): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET.
var lib = require("./_lib");

// Amounts are in the smallest unit (paise for INR, cents for USD).
// >>> EDIT THESE to set your prices. <<<
var PLANS = {
  week:  { inr: 79900,  usd: 999,  label: "1-Week Pass"  },   // ₹799   / $9.99
  month: { inr: 249900, usd: 2999, label: "1-Month Pass" }    // ₹2,499 / $29.99
};

module.exports = async function handler(req, res){
  var kid = process.env.RAZORPAY_KEY_ID, ksec = process.env.RAZORPAY_KEY_SECRET;
  if(!kid || !ksec){ res.status(500).json({ error:"Payments not configured yet" }); return; }

  var user = await lib.verifyUser(req);
  if(!user){ res.status(401).json({ error:"Please sign in first" }); return; }

  var body = req.body;
  if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
  body = body || {};
  var plan = (body.plan === "month") ? "month" : "week";
  var cur  = (body.currency === "USD") ? "USD" : "INR";
  var amount = (cur === "USD") ? PLANS[plan].usd : PLANS[plan].inr;

  var auth = "Basic " + Buffer.from(kid + ":" + ksec).toString("base64");
  try{
    var r = await fetch("https://api.razorpay.com/v1/orders", {
      method:"POST",
      headers:{ Authorization:auth, "Content-Type":"application/json" },
      body: JSON.stringify({
        amount: amount, currency: cur,
        receipt: "tl_" + Date.now(),
        notes: { email: user.email, plan: plan }
      })
    });
    var order = await r.json();
    if(!r.ok){ res.status(502).json({ error:(order && order.error && order.error.description) || "Could not start checkout" }); return; }
    res.status(200).json({
      orderId: order.id, amount: amount, currency: cur,
      keyId: kid, email: user.email, plan: plan, label: PLANS[plan].label
    });
  }catch(e){
    res.status(500).json({ error:"Checkout error — please try again" });
  }
};
