
import { fetchRegistrations, fetchResults } from '../../services/results.service.js';

export const index=(req,res)=>res.render('pages/records-index');
export const studentRecord=async (req,res)=>{
  const matric = (req.query.matric || '').trim();
  const regs = matric ? await fetchRegistrations(matric) : [];
  const results = matric ? await fetchResults(matric) : [];
  res.render('pages/records-student', { regs, results, matric });
};
