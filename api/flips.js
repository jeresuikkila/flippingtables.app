// Worldwide table-flip counter. Uses Upstash Redis / Vercel KV over REST when configured;
// without credentials it answers { total: null } and the game simply hides the counter.
module.exports = async (req, res) => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  res.setHeader('Cache-Control', 'no-store');
  if (!url || !token) return res.status(200).json({ total: null });
  try {
    let n = 0;
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body || '{}');
      n = Math.max(0, Math.min(500, Math.floor(Number(body && body.n) || 0))); // cap per request to blunt abuse
    }
    const r = await fetch(`${url}/${n ? `incrby/flips_total/${n}` : 'get/flips_total'}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    res.status(200).json({ total: Number(j.result) || 0 });
  } catch (e) {
    res.status(200).json({ total: null });
  }
};
