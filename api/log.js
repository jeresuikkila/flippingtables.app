// Client error sink: browsers POST uncaught errors here and they show up in Vercel runtime logs.
module.exports = (req, res) => {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { raw: body.slice(0, 500) }; } }
  console.error('[client-error]', JSON.stringify(body || {}).slice(0, 2000));
  res.status(204).end();
};
