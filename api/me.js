// GET /api/me  — returns the signed-in user's entitlement (pass + weekly tailor allowance).
// Sends Authorization: Bearer <supabase access token>.
var lib = require("./_lib");

module.exports = async function handler(req, res){
  var user = await lib.verifyUser(req);
  if(!user){ res.status(200).json({ signedIn:false }); return; }
  try{
    var pass  = await lib.getPass(user.email);
    var usage = await lib.getTailorUsage(user.email);
    var remaining = pass.active ? null : Math.max(0, lib.TAILOR_FREE_PER_WEEK - usage.count);
    res.status(200).json({
      signedIn: true,
      email: user.email,
      pass: pass,
      tailorLimit: lib.TAILOR_FREE_PER_WEEK,
      tailorsUsed: usage.count,
      tailorsRemaining: remaining
    });
  }catch(e){
    res.status(200).json({ signedIn:true, email:user.email, pass:{ active:false }, error:"lookup failed" });
  }
};
