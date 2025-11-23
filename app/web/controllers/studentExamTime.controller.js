// app/web/controllers/studentExamTime.controller.js

import pool from '../../core/db.js';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- helpers -------------------------------------------------

function getStudentFromRequest(req, res) {
  const s = req.session || {};
  let student = s.user || s.account || s.staff || req.user || null;

  if (!student && res.locals && res.locals.user) {
    student = res.locals.user;
  }
  return student || {};
}

function resolveSemesterFromDb(semesters, fallback = 'FIRST') {
  const current =
    semesters.find(x => Number(x.is_current) === 1) || semesters[0] || null;

  if (!current) return fallback;

  const name = String(current.name || '').toLowerCase();
  if (name.startsWith('first')) return 'FIRST';
  if (name.startsWith('second')) return 'SECOND';
  return fallback;
}

function normalizeSemester(value, semesters) {
  const s = String(value || '').toUpperCase();
  if (s === 'FIRST' || s === 'SECOND') return s;
  return resolveSemesterFromDb(semesters);
}

function formatDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  // MySQL returns string already
  return String(d).slice(0, 10);
}

function formatTime(t) {
  if (!t) return '';
  return t.toString().slice(0, 5);
}

// Build common filters used by both HTML + PDF endpoints
async function buildFilterState(req, res) {
  const student = getStudentFromRequest(req, res);
  const departmentId = student.department_id || null;
  const level = student.level || null;

  const [sessions] = await pool.query(
    'SELECT id, name, is_current FROM sessions ORDER BY id DESC'
  );

  const [semesters] = await pool.query(
    'SELECT id, name, is_current FROM semesters ORDER BY id'
  );

  const currentSession =
    sessions.find(x => Number(x.is_current) === 1) || sessions[0] || null;

  const selectedSessionId =
    req.query.session_id || (currentSession ? currentSession.id : null);

  const selectedSemester = normalizeSemester(
    req.query.semester,
    semesters
  );

  return {
    student,
    departmentId,
    level,
    sessions,
    semesters,
    selectedSessionId,
    selectedSemester
  };
}

// -------------------------------------------------------------------
// PAGE: /student/exam-time-table
// -------------------------------------------------------------------
export async function studentExamTimePage(req, res) {
  try {
    const {
      student,
      departmentId,
      level,
      sessions,
      semesters,
      selectedSessionId,
      selectedSemester
    } = await buildFilterState(req, res);

    // Pagination + search
    const page = parseInt(req.query.page || '1', 10) || 1;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const q = (req.query.q || '').trim();

    // --------------------------------------------------
    // Summary cards – scoped to student's dept/level
    // --------------------------------------------------
    // Total assigned courses (for this dept/level/session/semester)
    let whereAssign = 'WHERE 1';
    const assignParams = [];

    if (selectedSessionId) {
      whereAssign += ' AND ca.session_id = ?';
      assignParams.push(selectedSessionId);
    }

    if (selectedSemester === 'FIRST' || selectedSemester === 'SECOND') {
      whereAssign += ' AND ca.semester = ?';
      assignParams.push(selectedSemester);
    }

    if (departmentId) {
      whereAssign += ' AND c.department_id = ?';
      assignParams.push(departmentId);
    }

    if (level) {
      whereAssign += ' AND c.level = ?';
      assignParams.push(level);
    }

    const [[{ total_assigned }]] = await pool.query(
      `
        SELECT COUNT(*) AS total_assigned
        FROM course_assignments ca
        JOIN courses c ON c.id = ca.course_id
        ${whereAssign}
      `,
      assignParams
    );

    // How many of those have exam dates set?
    const [[{ exam_set }]] = await pool.query(
      `
        SELECT COUNT(DISTINCT et.course_assignment_id) AS exam_set
        FROM exam_times et
        JOIN course_assignments ca ON ca.id = et.course_assignment_id
        JOIN courses c ON c.id = ca.course_id
        ${whereAssign}
      `,
      assignParams
    );

    const remaining = Math.max((total_assigned || 0) - (exam_set || 0), 0);

    // --------------------------------------------------
    // Main exam timetable (with search + pagination)
    // --------------------------------------------------
    let whereExams = 'WHERE 1';
    const examParams = [];

    if (selectedSessionId) {
      whereExams += ' AND ca.session_id = ?';
      examParams.push(selectedSessionId);
    }

    if (selectedSemester === 'FIRST' || selectedSemester === 'SECOND') {
      whereExams += ' AND ca.semester = ?';
      examParams.push(selectedSemester);
    }

    if (departmentId) {
      // Either course dept matches student dept OR lecturer targeted this dept
      whereExams +=
        ' AND (c.department_id = ? OR et.student_department_id = ?)';
      examParams.push(departmentId, departmentId);
    }

    if (level) {
      whereExams += ' AND c.level = ?';
      examParams.push(level);
    }

    if (q) {
      const like = `%${q}%`;
      whereExams +=
        ' AND (c.code LIKE ? OR c.title LIKE ? OR s.name LIKE ? OR et.venue LIKE ?)';
      examParams.push(like, like, like, like);
    }

    const [[{ total }]] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM exam_times et
        JOIN course_assignments ca ON ca.id = et.course_assignment_id
        JOIN courses c ON c.id = ca.course_id
        JOIN sessions s ON s.id = ca.session_id
        LEFT JOIN departments d ON d.id = et.student_department_id
        ${whereExams}
      `,
      examParams
    );

    const [exams] = await pool.query(
      `
        SELECT
          et.id,
          et.exam_date,
          et.start_time,
          et.end_time,
          et.venue,
          c.code,
          c.title,
          c.level,
          s.name AS session_name,
          ca.semester,
          d.name AS student_department
        FROM exam_times et
        JOIN course_assignments ca ON ca.id = et.course_assignment_id
        JOIN courses c ON c.id = ca.course_id
        JOIN sessions s ON s.id = ca.session_id
        LEFT JOIN departments d ON d.id = et.student_department_id
        ${whereExams}
        ORDER BY et.exam_date ASC, et.start_time ASC
        LIMIT ? OFFSET ?
      `,
      [...examParams, pageSize, offset]
    );

    const totalPages = Math.max(Math.ceil((total || 0) / pageSize), 1);

    res.render('student/exam-time', {
      pageTitle: 'Exam Time Table',
      student,
      summary: {
        total_assigned: total_assigned || 0,
        exam_set: exam_set || 0,
        remaining
      },
      sessions,
      semesters,
      selectedSessionId,
      selectedSemester,
      exams,
      page,
      totalPages,
      pageSize,
      total: total || 0,
      q
    });
  } catch (err) {
    console.error('Error in studentExamTimePage:', err);
    res.status(500).render('pages/error', {
      title: 'Server error',
      message: 'Unable to load exam timetable.'
    });
  }
}

// -------------------------------------------------------------------
// PDF: /student/exam-time-table/print
// -------------------------------------------------------------------
export async function studentExamTimePdf(req, res) {
  try {
    const {
      student,
      departmentId,
      level,
      sessions,
      semesters,
      selectedSessionId,
      selectedSemester
    } = await buildFilterState(req, res);

    const q = (req.query.q || '').trim();

    let whereExams = 'WHERE 1';
    const examParams = [];

    if (selectedSessionId) {
      whereExams += ' AND ca.session_id = ?';
      examParams.push(selectedSessionId);
    }

    if (selectedSemester === 'FIRST' || selectedSemester === 'SECOND') {
      whereExams += ' AND ca.semester = ?';
      examParams.push(selectedSemester);
    }

    if (departmentId) {
      whereExams +=
        ' AND (c.department_id = ? OR et.student_department_id = ?)';
      examParams.push(departmentId, departmentId);
    }

    if (level) {
      whereExams += ' AND c.level = ?';
      examParams.push(level);
    }

    if (q) {
      const like = `%${q}%`;
      whereExams +=
        ' AND (c.code LIKE ? OR c.title LIKE ? OR s.name LIKE ? OR et.venue LIKE ?)';
      examParams.push(like, like, like, like);
    }

    const [exams] = await pool.query(
      `
        SELECT
          et.exam_date,
          et.start_time,
          et.end_time,
          et.venue,
          c.code,
          c.title,
          c.level,
          s.name AS session_name,
          ca.semester
        FROM exam_times et
        JOIN course_assignments ca ON ca.id = et.course_assignment_id
        JOIN courses c ON c.id = ca.course_id
        JOIN sessions s ON s.id = ca.session_id
        ${whereExams}
        ORDER BY et.exam_date ASC, et.start_time ASC
      `,
      examParams
    );

    // --------- build PDF ------------------------------------------
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="exam-timetable.pdf"'
    );

    doc.pipe(res);

    // Logo
    try {
      const logoPath = path.join(
        __dirname,
        '../../web/public/img/logo.png'
      );
      doc.image(logoPath, 40, 30, { width: 60 });
    } catch (e) {
      // logo is optional – ignore if missing
    }

    doc.fontSize(16).text('Exam Time Table', { align: 'center' });
    doc.moveDown(0.5);

    const sessionLabel =
      sessions.find(x => String(x.id) === String(selectedSessionId))?.name ||
      '';
    const semesterLabel =
      selectedSemester === 'FIRST'
        ? 'First Semester'
        : selectedSemester === 'SECOND'
        ? 'Second Semester'
        : selectedSemester;

    doc
      .fontSize(10)
      .text(`Student: ${student.name || ''}`, { align: 'left' });
    doc.text(`Session: ${sessionLabel}`, { align: 'left' });
    doc.text(`Semester: ${semesterLabel}`, { align: 'left' });
    doc.moveDown();

    if (!exams.length) {
      doc.text('No exam dates found for the selected filters.', {
        align: 'left'
      });
      doc.end();
      return;
    }

    doc.fontSize(10);
    exams.forEach((row, index) => {
      doc
        .font('Helvetica-Bold')
        .text(
          `${index + 1}. ${row.code} - ${row.title} (${row.level})`,
          { align: 'left' }
        );
      doc.font('Helvetica');
      doc.text(
        `Date: ${formatDate(row.exam_date)}   Time: ${formatTime(
          row.start_time
        )} - ${formatTime(row.end_time)}   Venue: ${row.venue || ''}`
      );
      doc.text(
        `Session: ${row.session_name || ''}   Semester: ${
          row.semester || ''
        }`
      );
      doc.moveDown(0.75);
    });

    doc.end();
  } catch (err) {
    console.error('Error in studentExamTimePdf:', err);
    res.status(500).send('Failed to generate exam timetable PDF.');
  }
}
