
import { fetchStudentByMatric, fetchResults, computePerTermGPA, computeCGPA } from '../../services/results.service.js';

export function dashboard(req, res) {
  res.send('Student Dashboard');
}


export const requestTranscript=async (req,res)=>{
  res.render('pages/student-request-transcript');
};

export const checkResult=async (req,res)=>{
  // expects ?matric=...
  const matric = (req.query.matric || req.user?.matricNumber || '').trim();
  const rows = matric ? await fetchResults(matric) : [];
  res.render('pages/student-check-result', { rows, matric });
};

export const academicRecord=async (req,res)=>{
  const matric = (req.query.matric || req.user?.matricNumber || '').trim();
  const perTerm = matric ? await computePerTermGPA(matric) : [];
  res.render('pages/student-academic-record', { perTerm, matric });
};

export const currentGCPA=async (req,res)=>{
  const matric = (req.query.matric || req.user?.matricNumber || '').trim();
  const cgpa = matric ? await computeCGPA(matric) : 0;
  res.render('pages/student-current-gcpa', { cgpa, matric });
};
