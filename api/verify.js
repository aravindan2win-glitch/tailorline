// POST /api/verify { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Verifies the Razorpay payment signature, then grants the pass to the signed-in user.
// Env (Vercel): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET.
var crypto = require("crypto");
var lib = require("./_lib");

module.exports = async function handler(req, res){
  var kid = process.env.RAZORPAY_KEY_ID, ksec = process.env.RAZORPAY_KEY_SECRET;
  if(!ksec){ res.status(500).json({ error:"Payments not configured yet" }); return; }

  var user = await lib.verifyUser(req);
  if(!user){ res.status(401).json({ error:"Please sign in first" }); return; }

  var body = req.body;
  if(typeof body === "string"){ try{ body = JSON.parse(body || "{}"); }catch(e){ body = {}; } }
  body = body || {};
  var oid = body.razorpay_order_id, pid = body.razorpay_payment_id, sig = body.razorpay_signature;
  if(!oid || !pid || !sig){ res.status(400).json({ error:"Missing payment details" }); return; }

  // Razorpay signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
  var expected = crypto.createHmac("sha256", ksec).update(oid + "|" + pid).digest("hex");
  if(expected !== sig){ res.status(400).json({ error:"Payment could not be verified" }); return; }

  try{
    // Read the order to learn which plan was bought (from the notes we set at checkout).
    var auth = "Basic " + Buffer.from(kid + ":" + ksec).toString("base64");
    var r = await fetch("https://api.razorpay.com/v1/orders/" + encodeURIComponent(oid), { headers:{ Authorization:auth } });
    var order = await r.json();
    var plan = (order && order.notes && order.notes.plan === "month") ? "month" : "week";
    var granted = await lib.grantPass(user.email, plan);
    res.status(200).json({ ok:true, pass:granted });
  }catch(e){
    res.status(500).json({ error:"Payment verified but activation failed — contact support" });
  }
};
