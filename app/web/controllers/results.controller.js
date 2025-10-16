
import { fetchResults } from '../../services/results.service.js';

export const index=async (req,res)=>{
  const matric = (req.query.matric || '').trim();
  const rows = matric ? await fetchResults(matric) : [];
  res.render('pages/results-index', { rows, matric });
};
export const computeForm=(req,res)=>res.render('pages/results-compute');
export const computeSubmit=(req,res)=>res.redirect('/results');
