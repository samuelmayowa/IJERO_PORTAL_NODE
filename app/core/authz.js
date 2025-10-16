// app/core/authz.js
export function ensureAuth(req, res, next) {
  if (req.session?.user) return next();
  // remember where user wanted to go
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

export function ensureRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.role === role) return next();
    return res.status(403).send('Forbidden');
  };
}
