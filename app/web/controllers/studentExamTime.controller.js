// app/web/controllers/studentExamTime.controller.js

import pool from '../../core/db.js';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// helpers
// --------------------------------------------------
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
    semesters.find((x) => Number(x.is_current) === 1) || semesters[0] || null;

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
  return String(d).slice(0, 10);
}

function formatTime(t) {
  if (!t) return '';
  return t.toString().slice(0, 5);
}

// --------------------------------------------------
// Common filter builder (HTML + PDF)
// --------------------------------------------------
async function buildFilterState(req, res) {
  const student = getStudentFromRequest(req, res) || {};

  // Base info coming from session/user
  let baseDepartmentId = student.department_id || null;
  let baseLevel = student.level || null;
  let baseSchoolId = student.school_id || null;

  // Try to enrich from uniform_measurements (latest row for this student)
  if ((!baseDepartmentId || !baseLevel || !baseSchoolId) && student.id) {
    try {
      const [rows] = await pool.query(
        `
        SELECT school_id, department_id, level
        FROM uniform_measurements
        WHERE person_role = 'STUDENT' AND person_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
        [student.id]
      );
      if (rows.length) {
        const um = rows[0];
        if (!baseSchoolId) baseSchoolId = um.school_id || null;
        if (!baseDepartmentId) baseDepartmentId = um.department_id || null;
        if (!baseLevel) baseLevel = um.level || null;
      }
    } catch (e) {
      console.error(
        '[buildFilterState] uniform_measurements lookup failed:',
        e.message || e
      );
    }
  }

  // Sessions + semesters
  const [sessions] = await pool.query(
    'SELECT id, name, is_current FROM sessions ORDER BY id DESC'
  );
  const [semesters] = await pool.query(
    'SELECT id, name, is_current FROM semesters ORDER BY id'
  );

  const currentSession =
    sessions.find((x) => Number(x.is_current) === 1) || sessions[0] || null;

  const selectedSessionId =
    req.query.session_id || (currentSession ? currentSession.id : null);

  const selectedSemester = normalizeSemester(req.query.semester, semesters);

  // Schools
  const [schools] = await pool.query(
    'SELECT id, name FROM schools ORDER BY name'
  );

  const selectedSchoolId =
    req.query.school_id ||
    baseSchoolId ||
    (schools.length ? schools[0].id : null);

  // Departments depend on selected school
  let departments = [];
  if (selectedSchoolId) {
    [departments] = await pool.query(
      `
      SELECT id, name
      FROM departments
      WHERE school_id = ?
      ORDER BY name
      `,
      [selectedSchoolId]
    );
  } else {
    [departments] = await pool.query(
      'SELECT id, name FROM departments ORDER BY name'
    );
  }

  const selectedDepartmentId =
    req.query.department_id || baseDepartmentId || '';

  // This is the department that will actually be used in WHERE clauses
  const effectiveDepartmentId = selectedDepartmentId || baseDepartmentId || null;

  return {
    student,
    level: baseLevel,
    baseDepartmentId,
    baseSchoolId,
    effectiveDepartmentId,

    sessions,
    semesters,
    selectedSessionId,
    selectedSemester,

    schools,
    departments,
    selectedSchoolId,
    selectedDepartmentId
  };
}

// --------------------------------------------------
// PAGE: /student/exam-time-table
// --------------------------------------------------
export async function studentExamTimePage(req, res) {
  try {
    const {
      student,
      level,
      effectiveDepartmentId,
      sessions,
      semesters,
      selectedSessionId,
      selectedSemester,
      schools,
      departments,
      selectedSchoolId,
      selectedDepartmentId
    } = await buildFilterState(req, res);

    // Pagination + search
    const page = parseInt(req.query.page || '1', 10) || 1;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;
    const q = (req.query.q || '').trim();

    // --------------------------------------------------
    // Summary cards – scoped to student's dept/level/school
    // --------------------------------------------------
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

    if (selectedSchoolId) {
      whereAssign += ' AND c.school_id = ?';
      assignParams.push(selectedSchoolId);
    }

    if (effectiveDepartmentId) {
      // For counts we only need the course's department
      whereAssign += ' AND c.department_id = ?';
      assignParams.push(effectiveDepartmentId);
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

    if (selectedSchoolId) {
      whereExams += ' AND c.school_id = ?';
      examParams.push(selectedSchoolId);
    }

    if (effectiveDepartmentId) {
      whereExams +=
        ' AND (c.department_id = ? OR et.student_department_id = ?)';
      examParams.push(effectiveDepartmentId, effectiveDepartmentId);
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

      schools,
      departments,
      selectedSchoolId,
      selectedDepartmentId,

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

// --------------------------------------------------
// PDF: /student/exam-time-table/print
// --------------------------------------------------
export async function studentExamTimePdf(req, res) {
  try {
    const {
      student,
      level,
      effectiveDepartmentId,
      sessions,
      semesters,
      selectedSessionId,
      selectedSemester,
      selectedSchoolId
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

    if (selectedSchoolId) {
      whereExams += ' AND c.school_id = ?';
      examParams.push(selectedSchoolId);
    }

    if (effectiveDepartmentId) {
      whereExams +=
        ' AND (c.department_id = ? OR et.student_department_id = ?)';
      examParams.push(effectiveDepartmentId, effectiveDepartmentId);
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
      `,
      examParams
    );

    // ------------- build header info for student -----------------
    const nameParts = [];

    // DB uses first_name / middle_name / last_name
    if (student.last_name || student.surname) {
      nameParts.push(student.last_name || student.surname);
    }
    if (student.first_name || student.firstname) {
      nameParts.push(student.first_name || student.firstname);
    }
    if (student.middle_name || student.middlename) {
      nameParts.push(student.middle_name || student.middlename);
    }

    const fullName =
      nameParts.filter(Boolean).join(' ') ||
      student.fullname ||
      student.name ||
      'User';

    const matricNo =
      student.matric_no ||
      student.matric ||
      student.matric_number ||
      student.reg_no ||
      student.username ||
      '';

    const levelLabel =
      student.level ||
      student.level_name ||
      student.current_level ||
      level ||
      '';

    const sessionLabel =
      sessions.find((s) => String(s.id) === String(selectedSessionId))?.name ||
      'N/A';

    const semesterLabel =
      selectedSemester === 'FIRST'
        ? 'First Semester'
        : selectedSemester === 'SECOND'
        ? 'Second Semester'
        : selectedSemester || 'N/A';

    // ------------- start PDF response ----------------------------
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="exam-timetable.pdf"'
    );
    doc.pipe(res);

    // Logo (if present)
    const logoPath = path.join(
      __dirname,
      '../public/img/logo.png' // app/web/public/img/logo.png
    );
    try {
      doc.image(logoPath, 40, 35, { width: 60 });
    } catch (e) {
      // If logo missing, silently ignore
    }

    // Title
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .text('STUDENT EXAMINATION TIME TABLE', 0, 40, {
        align: 'center'
      });

    doc
      .font('Helvetica')
      .fontSize(10)
      .text('Generated by College Portal', 0, 60, { align: 'center' });

    doc.moveDown(2);

    // Student / session info block
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`Student: ${fullName}`, 40, 110)
      .text(`Matric No: ${matricNo || 'N/A'}`, 40, 125)
      .text(`Level: ${levelLabel || 'N/A'}`, 40, 140);

    doc
      .text(`Session: ${sessionLabel}`, 320, 110)
      .text(`Semester: ${semesterLabel}`, 320, 125)
      .text(
        `Printed On: ${new Date().toLocaleString()}`,
        320,
        140
      );

    doc.moveDown(2);

    // ------------- table header ----------------------------------
    const tableTop = 175;
    const col = {
      idx: 40,
      code: 70,
      title: 120,
      level: 280,
      session: 320,
      semester: 380,
      date: 440,
      time: 500,
      venue: 560
    };

    doc
      .rect(40, tableTop - 15, 515, 18)
      .fill('#f3f3f3')
      .stroke();

    doc
      .fillColor('#000')
      .font('Helvetica-Bold')
      .fontSize(9);

    doc.text('#', col.idx, tableTop - 12, { width: 20 });
    doc.text('Course Code', col.code, tableTop - 12, { width: 60 });
    doc.text('Title', col.title, tableTop - 12, { width: 150 });
    doc.text('Level', col.level, tableTop - 12, { width: 40 });
    doc.text('Session', col.session, tableTop - 12, { width: 50 });
    doc.text('Semester', col.semester, tableTop - 12, { width: 60 });
    doc.text('Date', col.date, tableTop - 12, { width: 55 });
    doc.text('Time', col.time, tableTop - 12, { width: 55 });
    doc.text('Venue', col.venue, tableTop - 12, { width: 80 });

    doc.moveTo(40, tableTop + 3).lineTo(555, tableTop + 3).stroke();

    // ------------- table rows ------------------------------------
    doc.font('Helvetica').fontSize(9);

    if (!exams.length) {
      doc
        .moveDown(2)
        .font('Helvetica-Oblique')
        .text('No exam dates found for the selected filters.', {
          align: 'center'
        });
    } else {
      let rowY = tableTop + 8;
      const rowHeight = 16;

      exams.forEach((row, idx) => {
        // Simple page break handling
        if (rowY > 780) {
          doc.addPage();
          rowY = 60;
        }

        const dateStr = formatDate(row.exam_date);
        const timeStr = `${formatTime(row.start_time)} - ${formatTime(
          row.end_time
        )}`;

        doc.text(String(idx + 1), col.idx, rowY, { width: 20 });
        doc.text(row.code || '', col.code, rowY, { width: 60 });
        doc.text(row.title || '', col.title, rowY, { width: 150 });
        doc.text(row.level || '', col.level, rowY, { width: 40 });
        doc.text(row.session_name || '', col.session, rowY, { width: 50 });
        doc.text(row.semester || '', col.semester, rowY, { width: 60 });
        doc.text(dateStr, col.date, rowY, { width: 55 });
        doc.text(timeStr, col.time, rowY, { width: 55 });
        doc.text(row.venue || '', col.venue, rowY, { width: 80 });

        rowY += rowHeight;
      });
    }

    doc.end();
  } catch (err) {
    console.error('Error in studentExamTimePdf:', err);
    res.status(500).send('Unable to generate exam timetable PDF.');
  }
}
