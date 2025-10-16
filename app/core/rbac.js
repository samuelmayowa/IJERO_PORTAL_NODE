export const can = (perm)=>(req,res,next)=>req.user?.permissions?.includes(perm)?next():res.status(403).render('pages/403');
export const requireRole=(...roles)=>(req,res,next)=>req.user&&roles.includes(req.user.role)?next():res.status(403).render('pages/403');
