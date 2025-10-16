export const notFound=(req,res)=>res.status(404).render('pages/404');
export const errorHandler=(err,req,res,next)=>{console.error(err);res.status(err.status||500).render('pages/error');};
