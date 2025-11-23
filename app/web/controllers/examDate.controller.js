// app/web/controllers/examDate.controller.js

import pool from '../../core/db.js';

// ======================================================================
// GET PAGE — Set Exam Date
// ======================================================================
export async function examDatePage(req, res) {
  const s = req.session || {};
  const staff = s.staff || s.user || s.account || req.user || null;
  if (!staff) {
    return res.redirect('/login');
  }

  const staffId = staff.id;
  const q = (req.query.q || '').trim();
  const page = parseInt(req.query.page || '1', 10) || 1;
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  // --------------------------------------------------
  // Load sessions + semesters
  // --------------------------------------------------
  const [sessions] = await pool.query(
    'SELECT id, name, is_current FROM sessions ORDER BY id DESC'
  );

  const [semesters] = await pool.query(
    'SELECT id, name, is_current FROM semesters ORDER BY id'
  );

  const currentSession =
    sessions.find(s => Number(s.is_current) === 1) || sessions[0] || null;

  const selectedSessionId =
    req.query.session_id || (currentSession ? currentSession.id : null);

  const currentSemester =
    semesters.find(s => Number(s.is_current) === 1) || semesters[0] || null;

  // We only care about FIRST / SECOND for actual assignment
  let selectedSemester = (req.query.semester || '').toUpperCase();
  if (!selectedSemester) {
    if (currentSemester && currentSemester.name.toLowerCase().startsWith('first')) {
      selectedSemester = 'FIRST';
    } else if (currentSemester && currentSemester.name.toLowerCase().startsWith('second')) {
      selectedSemester = 'SECOND';
    } else {
      selectedSemester = 'FIRST';
    }
  }

  // --------------------------------------------------
  // Summary cards for this staff
  // --------------------------------------------------
  const [[{ total_assigned }]] = await pool.query(
    `
    SELECT COUNT(*) AS total_assigned
    FROM course_assignments
    WHERE staff_id = ?
    `,
    [staffId]
  );

  const [[{ exam_set }]] = await pool.query(
    `
    SELECT COUNT(*) AS exam_set
    FROM exam_times et
    JOIN course_assignments ca ON ca.id = et.course_assignment_id
    WHERE ca.staff_id = ?
    `,
    [staffId]
  );

  const remaining = Math.max(total_assigned - exam_set, 0);

  // --------------------------------------------------
  // Existing exam dates for this staff (table + pagination)
  // --------------------------------------------------
  let where = 'WHERE ca.staff_id = ?';
  const params = [staffId];

  if (q) {
    where += ' AND (c.code LIKE ? OR c.title LIKE ? OR s.name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM exam_times et
    JOIN course_assignments ca ON ca.id = et.course_assignment_id
    JOIN courses c ON c.id = ca.course_id
    JOIN sessions s ON s.id = ca.session_id
    LEFT JOIN departments d ON d.id = et.student_department_id
    ${where}
    `,
    params
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
    ${where}
    ORDER BY et.exam_date DESC, et.start_time ASC
    LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset]
  );

  // Departments for "student department" select
  const [departments] = await pool.query(
    `
    SELECT id, name
    FROM departments
    ORDER BY name
    `
  );

  // Flash messages
  const success = req.flash('success')[0] || '';
  const error = req.flash('error')[0] || '';

  res.render('courses/exam-date', {
    title: 'Set Exam Date',
    pageTitle: 'Set Exam Date',
    csrfToken: res.locals.csrfToken,

    q,
    sessions,
    semesters,
    selectedSessionId,
    selectedSemester,

    summary: {
      total_assigned,
      exam_set,
      remaining
    },

    exams,
    departments,

    total,
    page,
    pageSize,

    success,
    error
  });
}

// ======================================================================
// API — Fetch courses assigned to CURRENT staff (for autocomplete)
// ======================================================================
export async function fetchMyExamCourses(req, res) {
  const s = req.session || {};
  const staff = s.staff || s.user || s.account || req.user || null;
  if (!staff) {
    return res.json({ ok: false, message: 'Not logged in' });
  }


  const staffId = staff.id;
  const sessionId = parseInt(req.query.session_id || '0', 10) || 0;
  const semester = (req.query.semester || '').toUpperCase();
  const q = (req.query.q || '').trim();

  let where = 'WHERE ca.staff_id = ?';
  const params = [staffId];

  if (sessionId) {
    where += ' AND ca.session_id = ?';
    params.push(sessionId);
  }

  if (semester === 'FIRST' || semester === 'SECOND') {
    where += ' AND ca.semester = ?';
    params.push(semester);
  }

  if (q) {
    where += ' AND (c.code LIKE ? OR c.title LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `
    SELECT
      ca.id AS assignment_id,
      c.code,
      c.title,
      c.level,
      s.name AS session_name,
      ca.semester,
      et.id AS exam_time_id,
      et.exam_date,
      et.start_time,
      et.end_time,
      et.venue
    FROM course_assignments ca
    JOIN courses c   ON c.id = ca.course_id
    JOIN sessions s  ON s.id = ca.session_id
    LEFT JOIN exam_times et ON et.course_assignment_id = ca.id
    ${where}
    ORDER BY c.code ASC
    LIMIT 50
    `,
    params
  );

  return res.json({
    ok: true,
    items: rows.map(r => ({
      assignment_id: r.assignment_id,
      code: r.code,
      title: r.title,
      level: r.level,
      session_name: r.session_name,
      semester: r.semester,
      already_set: !!r.exam_time_id,
      exam_date: r.exam_time_id ? r.exam_date : null,
      start_time: r.exam_time_id ? r.start_time : null,
      end_time: r.exam_time_id ? r.end_time : null,
      venue: r.exam_time_id ? r.venue : null
    }))
  });
}

// ======================================================================
// POST — Save / Update exam date
// ======================================================================
export async function saveExamDate(req, res) {
  const s = req.session || {};
  const staff = s.staff || s.user || s.account || req.user || null;
  if (!staff) {
    req.flash('error', 'Please log in again.');
    return res.redirect('/login');
  }

  const staffId = staff.id;

  const {
    assignment_id,
    exam_date,
    start_time,
    end_time,
    venue,
    student_department_id
  } = req.body;

  if (!assignment_id || !exam_date || !start_time || !end_time || !venue) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/staff/exams/date');
  }

  // Ensure this assignment belongs to this staff (same logic as lecture time)
  const [[assignment]] = await pool.query(
    `
    SELECT id
    FROM course_assignments
    WHERE id = ? AND staff_id = ?
    `,
    [assignment_id, staffId]
  );

  if (!assignment) {
    req.flash('error', 'You are not allowed to set exam date for this course.');
    return res.redirect('/staff/exams/date');
  }

  // Check if there is an existing exam time
  const [[existing]] = await pool.query(
    `
    SELECT id
    FROM exam_times
    WHERE course_assignment_id = ?
    `,
    [assignment_id]
  );

  if (existing) {
    // UPDATE
    await pool.query(
      `
      UPDATE exam_times
      SET exam_date = ?,
          start_time   = ?,
          end_time     = ?,
          venue        = ?,
          student_department_id = ?,
          updated_at   = NOW()
      WHERE id = ?
      `,
      [
        exam_date,
        start_time,
        end_time,
        venue,
        student_department_id || null,
        existing.id
      ]
    );

    req.flash('success', 'Exam date updated successfully.');
  } else {
    // INSERT
    await pool.query(
      `
      INSERT INTO exam_times
        (course_assignment_id, exam_date, start_time, end_time, venue,
         student_department_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        assignment_id,
        exam_date,
        start_time,
        end_time,
        venue,
        student_department_id || null,
        staffId
      ]
    );

    req.flash('success', 'Exam date set successfully.');
  }

  return res.redirect('/staff/exams/date');
}
