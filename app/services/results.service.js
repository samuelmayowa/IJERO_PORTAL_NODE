
import { pool } from '../core/db.js';
import { computeGPA } from './grading.service.js';

export async function fetchStudentByMatric(matric){
  const [rows] = await pool.query(
    `SELECT ID, matricNumber, firstName, middleName, lastName, department, faculty, studentLevel
     FROM students WHERE TRIM(LOWER(matricNumber))=TRIM(LOWER(?)) LIMIT 1`, [matric]);
  return rows[0] || null;
}

export async function fetchRegistrations(matric){
  const [rows] = await pool.query(
    `SELECT CourseCode AS course_code, CourseUnits AS units, CourseName AS course_name,
            AcademicSession AS session, Semester AS semester, StdLevel AS level
     FROM studentCourseReg
     WHERE TRIM(LOWER(MatricNumber))=TRIM(LOWER(?))
     ORDER BY session, semester`, [matric]);
  return rows;
}

export async function fetchResults(matric){
  // Prefer ScoreSheet if populated; fallback to results_sheets
  const [rows1] = await pool.query(
    `SELECT CourseCode AS course_code, CourseUnits AS units, CumTotalScore AS score,
            Grade AS grade, Remark AS remark, AcademicSession AS session,
            Semester AS semester, Level AS level
     FROM ScoreSheet
     WHERE TRIM(LOWER(MatricNO))=TRIM(LOWER(?))`, [matric]);
  if (rows1.length) return rows1;

  const [rows2] = await pool.query(
    `SELECT course_code, units, score, grade, remark, academic_session AS session,
            semester, level
     FROM results_sheets
     WHERE TRIM(LOWER(MatricNumber))=TRIM(LOWER(?))`, [matric]);
  return rows2;
}

export async function computePerTermGPA(matric){
  const rows = await fetchResults(matric);
  const key = (r)=>`${r.session}::${r.semester}`;
  const groups = {};
  for(const r of rows){ (groups[key(r)] ||= []).push(r); }
  const out = [];
  for(const k of Object.keys(groups).sort()){
    const [session, semester] = k.split("::");
    const g = computeGPA(groups[k]);
    out.push({ session, semester, ...g });
  }
  return out;
}

export async function computeCGPA(matric){
  const rows = await fetchResults(matric);
  const g = computeGPA(rows);
  return g.gpa;
}
