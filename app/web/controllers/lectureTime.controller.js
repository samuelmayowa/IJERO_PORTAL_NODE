// app/web/controllers/lectureTime.controller.js

import pool from '../../core/db.js';

// Helper: get the currently logged-in staff/lecturer from session
function getCurrentStaff(req) {
  const s = req.session || {};
  return s.staff || s.user || s.account || req.user || null;
}

// ======================================================================
// GET PAGE — Set Lecture Time
// ======================================================================
export async function lectureTimePage(req, res) {
  const staff = getCurrentStaff(req);
  if (!staff) {
    req.flash && req.flash('error', 'Please log in as staff to access Lecture Time.');
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

  const [[{ lecture_set }]] = await pool.query(
    `
    SELECT COUNT(*) AS lecture_set
    FROM lecture_times lt
    JOIN course_assignments ca ON ca.id = lt.course_assignment_id
    WHERE ca.staff_id = ?
    `,
    [staffId]
  );

  const remaining = Math.max(total_assigned - lecture_set, 0);

  // --------------------------------------------------
  // Existing lecture times for this staff (table + pagination)
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
    FROM lecture_times lt
    JOIN course_assignments ca ON ca.id = lt.course_assignment_id
    JOIN courses c ON c.id = ca.course_id
    JOIN sessions s ON s.id = ca.session_id
    LEFT JOIN departments d ON d.id = lt.student_department_id
    ${where}
    `,
    params
  );

  const [lectures] = await pool.query(
    `
    SELECT
      lt.id,
      lt.lecture_date,
      lt.start_time,
      lt.end_time,
      lt.venue,
      c.code,
      c.title,
      c.level,
      s.name AS session_name,
      ca.semester,
      d.name AS student_department
    FROM lecture_times lt
    JOIN course_assignments ca ON ca.id = lt.course_assignment_id
    JOIN courses c ON c.id = ca.course_id
    JOIN sessions s ON s.id = ca.session_id
    LEFT JOIN departments d ON d.id = lt.student_department_id
    ${where}
    ORDER BY lt.lecture_date DESC, lt.start_time ASC
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

  // 🔑 Venues for the new venue dropdown
  const [lectureVenues] = await pool.query(
    `
    SELECT
      id,
      school_id,
      department_id,
      name AS venue_name
    FROM lecture_venues
    ORDER BY name
    `
  );

  // Flash messages
  const success = req.flash('success')[0] || '';
  const error = req.flash('error')[0] || '';

  res.render('courses/lecture-time', {
    title: 'Set Lecture Time',
    pageTitle: 'Set Lecture Time',
    csrfToken: res.locals.csrfToken,

    q,
    sessions,
    semesters,
    selectedSessionId,
    selectedSemester,

    summary: {
      total_assigned,
      lecture_set,
      remaining
    },

    lectures,
    departments,
    lectureVenues, // <-- used by the EJS for the venue select

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
export async function fetchMyAssignedCourses(req, res) {
  const staff = getCurrentStaff(req);
  if (!staff) {
    return res.status(401).json({ ok: false, message: 'Not logged in' });
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
      lt.id AS lecture_time_id,
      lt.lecture_date,
      lt.start_time,
      lt.end_time,
      lt.venue
    FROM course_assignments ca
    JOIN courses c   ON c.id = ca.course_id
    JOIN sessions s  ON s.id = ca.session_id
    LEFT JOIN lecture_times lt ON lt.course_assignment_id = ca.id
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
      already_set: !!r.lecture_time_id,
      lecture_date: r.lecture_time_id ? r.lecture_date : null,
      start_time: r.lecture_time_id ? r.start_time : null,
      end_time: r.lecture_time_id ? r.end_time : null,
      venue: r.lecture_time_id ? r.venue : null
    }))
  });
}

// ======================================================================
// POST — Save / Update lecture time
// ======================================================================
export async function saveLectureTime(req, res) {
  const staff = getCurrentStaff(req);
  if (!staff) {
    req.flash && req.flash('error', 'Please log in again.');
    return res.redirect('/login');
  }

  const staffId = staff.id;
  const {
    assignment_id,
    lecture_date,
    start_time,
    end_time,
    venue,
    student_department_id
  } = req.body;

  if (!assignment_id || !lecture_date || !start_time || !end_time || !venue) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/staff/lecture-time');
  }

  // Ensure this assignment belongs to this staff
  const [[assignment]] = await pool.query(
    `
    SELECT id
    FROM course_assignments
    WHERE id = ? AND staff_id = ?
    `,
    [assignment_id, staffId]
  );

  if (!assignment) {
    req.flash('error', 'You are not allowed to set lecture time for this course.');
    return res.redirect('/staff/lecture-time');
  }

  // Check if there is an existing lecture time
  const [[existing]] = await pool.query(
    `
    SELECT id
    FROM lecture_times
    WHERE course_assignment_id = ?
    `,
    [assignment_id]
  );

  if (existing) {
    // UPDATE
    await pool.query(
      `
      UPDATE lecture_times
      SET lecture_date = ?,
          start_time   = ?,
          end_time     = ?,
          venue        = ?,
          student_department_id = ?,
          updated_at   = NOW()
      WHERE id = ?
      `,
      [
        lecture_date,
        start_time,
        end_time,
        venue,
        student_department_id || null,
        existing.id
      ]
    );

    req.flash('success', 'Lecture time updated successfully.');
  } else {
    // INSERT
    await pool.query(
      `
      INSERT INTO lecture_times
        (course_assignment_id, lecture_date, start_time, end_time, venue,
         student_department_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        assignment_id,
        lecture_date,
        start_time,
        end_time,
        venue,
        student_department_id || null,
        staffId
      ]
    );

    req.flash('success', 'Lecture time set successfully.');
  }

  return res.redirect('/staff/lecture-time');
}
