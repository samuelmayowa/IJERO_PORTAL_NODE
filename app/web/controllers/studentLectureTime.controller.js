// app/web/controllers/studentLectureTime.controller.js

import pool from '../../core/db.js';

// View lecture time for logged-in student (read-only)
export async function studentLectureTimePage(req, res) {
  const s = req.session || {};

  // Try to get a real student object from session/request
  let student = s.user || s.account || s.staff || req.user || null;

  // Fall back to whatever the views are already using (ensureUserForViews)
  if (!student && res.locals && res.locals.user) {
    student = res.locals.user;
  }

  // Basic student info used for default scoping
  const studentDeptId   = student && student.department_id ? student.department_id : null;
  const studentSchoolId = student && student.school_id ? student.school_id : null;
  const studentLevel    = student && student.level ? student.level : null;

  const page     = parseInt(req.query.page || '1', 10) || 1;
  const pageSize = 10;
  const offset   = (page - 1) * pageSize;

  const q = (req.query.q || '').trim();

  // --------------------------------------------------
  // Load sessions + semesters (same pattern as staff)
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
  // Schools + Departments (for filters)
  // --------------------------------------------------
  const [schools] = await pool.query(
    'SELECT id, name FROM schools ORDER BY name'
  );

  // include school_id so we can filter client-side
  const [departments] = await pool.query(
    'SELECT id, name, school_id FROM departments ORDER BY name'
  );

  let selectedSchoolId = req.query.school_id || studentSchoolId || '';
  if (selectedSchoolId === '0') selectedSchoolId = '';

  let selectedDepartmentId = req.query.department_id || studentDeptId || '';
  if (selectedDepartmentId === '0') selectedDepartmentId = '';

  const effectiveSchoolId = selectedSchoolId || studentSchoolId || null;
  const effectiveDeptId   = selectedDepartmentId || studentDeptId || null;
  const effectiveLevel    = studentLevel || null;

  // --------------------------------------------------
  // Summary cards – scoped to student's school/department/level
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

  if (effectiveSchoolId) {
    whereAssign += ' AND c.school_id = ?';
    assignParams.push(effectiveSchoolId);
  }

  if (effectiveDeptId) {
    whereAssign += ' AND c.department_id = ?';
    assignParams.push(effectiveDeptId);
  }

  if (effectiveLevel) {
    whereAssign += ' AND c.level = ?';
    assignParams.push(effectiveLevel);
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

  const [[{ lecture_set }]] = await pool.query(
    `
      SELECT COUNT(DISTINCT lt.course_assignment_id) AS lecture_set
      FROM lecture_times lt
      JOIN course_assignments ca ON ca.id = lt.course_assignment_id
      JOIN courses c ON c.id = ca.course_id
      ${whereAssign}
    `,
    assignParams
  );

  const remaining = Math.max(total_assigned - lecture_set, 0);

  // --------------------------------------------------
  // Lecture list for the table (read-only)
  // --------------------------------------------------
  let whereLectures = 'WHERE 1';
  const lectureParams = [];

  if (selectedSessionId) {
    whereLectures += ' AND ca.session_id = ?';
    lectureParams.push(selectedSessionId);
  }

  if (selectedSemester === 'FIRST' || selectedSemester === 'SECOND') {
    whereLectures += ' AND ca.semester = ?';
    lectureParams.push(selectedSemester);
  }

  if (effectiveSchoolId) {
    whereLectures += ' AND c.school_id = ?';
    lectureParams.push(effectiveSchoolId);
  }

  if (effectiveDeptId) {
    // student should only see lectures mapped to their department
    // either via the course dept OR explicit student_department_id
    whereLectures += ' AND (c.department_id = ? OR lt.student_department_id = ?)';
    lectureParams.push(effectiveDeptId, effectiveDeptId);
  }

  if (effectiveLevel) {
    whereLectures += ' AND c.level = ?';
    lectureParams.push(effectiveLevel);
  }

  // Text search (code, title, session, venue)
  if (q) {
    whereLectures += `
      AND (
        c.code       LIKE ?
        OR c.title   LIKE ?
        OR s.name    LIKE ?
        OR lt.venue  LIKE ?
      )`;
    lectureParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  // Total for pagination
  const [[{ total }]] = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM lecture_times lt
      JOIN course_assignments ca ON ca.id = lt.course_assignment_id
      JOIN courses c ON c.id = ca.course_id
      JOIN sessions s ON s.id = ca.session_id
      LEFT JOIN departments d ON d.id = lt.student_department_id
      ${whereLectures}
    `,
    lectureParams
  );

  // Paged lecture rows
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
      ${whereLectures}
      ORDER BY lt.lecture_date ASC, lt.start_time ASC
      LIMIT ? OFFSET ?
    `,
    [...lectureParams, pageSize, offset]
  );

  // --------------------------------------------------
  // UPCOMING LECTURES (next 2 by nearest start time)
  // --------------------------------------------------
  const [upcomingLectures] = await pool.query(
    `
      SELECT
        lt.id,
        lt.lecture_date,
        lt.start_time,
        lt.end_time,
        lt.venue,
        c.code,
        c.title
      FROM lecture_times lt
      JOIN course_assignments ca ON ca.id = lt.course_assignment_id
      JOIN courses c ON c.id = ca.course_id
      JOIN sessions s ON s.id = ca.session_id
      LEFT JOIN departments d ON d.id = lt.student_department_id
      ${whereLectures}
      AND CONCAT(lt.lecture_date, ' ', lt.start_time) >= NOW()
      ORDER BY lt.lecture_date ASC, lt.start_time ASC
      LIMIT 2
    `,
    lectureParams
  );

  // --------------------------------------------------
  // Render student view
  // --------------------------------------------------
  res.render('student/lecture-time', {
    title: 'View Lecture Time',
    pageTitle: 'View Lecture Time',

    sessions,
    semesters,
    schools,
    departments,

    selectedSessionId,
    selectedSemester,
    selectedSchoolId,
    selectedDepartmentId,
    q,

    summary: {
      total_assigned,
      lecture_set,
      remaining
    },

    lectures,
    upcomingLectures,

    total,
    page,
    pageSize
  });
}
