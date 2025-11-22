// app/web/controllers/viewAssignedCourses.controller.js

import pool from '../../core/db.js';

/**
 * VIEW ASSIGNED COURSES (no role gate, but scoped by role)
 *
 * - admin / registry  => see ALL assignments
 * - hod               => only courses in their department
 * - dean              => only courses in their school
 * - lecturer / others => only courses assigned to them
 */
export async function viewAssignedCoursesPage(req, res) {
  const user = req.session?.staff || null;
  const role = (user?.role || '').toLowerCase();
  const userId = user?.id || null;

  const q = (req.query.q || '').trim();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  // ----------------------------------------------------
  // Build WHERE clause based on search + role
  // ----------------------------------------------------
  let where = 'WHERE 1';
  const params = [];

  // Text search
  if (q) {
    where += ` AND (
      c.code       LIKE ?
      OR c.title   LIKE ?
      OR st.full_name LIKE ?
    )`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  // Role-based scoping (NO access denied, just filters)
  if (role === 'hod') {
    // only courses in my department
    where += `
      AND c.department_id = (
        SELECT department_id FROM staff WHERE id = ?
      )`;
    params.push(userId);
  } else if (role === 'dean') {
    // only courses in my school
    where += `
      AND c.school_id = (
        SELECT school_id FROM staff WHERE id = ?
      )`;
    params.push(userId);
  } else if (role === 'lecturer') {
    // only my assigned courses
    where += ' AND ca.staff_id = ?';
    params.push(userId);
  } else if (role === 'admin' || role === 'registry') {
    // see everything — no extra filter
  } else if (userId) {
    // default: behave like lecturer (only my assignments)
    where += ' AND ca.staff_id = ?';
    params.push(userId);
  }

  // ----------------------------------------------------
  // Total count (for pagination)
  // ----------------------------------------------------
  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM course_assignments ca
    JOIN courses c   ON ca.course_id = c.id
    JOIN staff   st  ON ca.staff_id  = st.id
    JOIN sessions s  ON ca.session_id = s.id
    LEFT JOIN departments d ON c.department_id = d.id
    LEFT JOIN schools     sc ON c.school_id     = sc.id
    ${where}
    `,
    params
  );

  // ----------------------------------------------------
  // Fetch paged rows
  // ----------------------------------------------------
  const [assignments] = await pool.query(
    `
    SELECT
      ca.id,
      ca.semester,
      ca.assigned_at,
      s.name AS session_name,
      c.code,
      c.title,
      c.level,
      st.full_name AS lecturer_name,
      d.name  AS department,
      sc.name AS school
    FROM course_assignments ca
    JOIN courses c   ON ca.course_id = c.id
    JOIN staff   st  ON ca.staff_id  = st.id
    JOIN sessions s  ON ca.session_id = s.id
    LEFT JOIN departments d ON c.department_id = d.id
    LEFT JOIN schools     sc ON c.school_id     = sc.id
    ${where}
    ORDER BY s.id DESC, c.code ASC
    LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset]
  );

  // ----------------------------------------------------
  // Summary cards (scoped in same way)
  // ----------------------------------------------------
  const [[{ total_assignments }]] = await pool.query(
    `
    SELECT COUNT(*) AS total_assignments
    FROM course_assignments ca
    JOIN courses c   ON ca.course_id = c.id
    JOIN staff   st  ON ca.staff_id  = st.id
    ${where}
    `,
    params
  );

  const [[{ distinct_courses }]] = await pool.query(
    `
    SELECT COUNT(DISTINCT ca.course_id) AS distinct_courses
    FROM course_assignments ca
    JOIN courses c   ON ca.course_id = c.id
    JOIN staff   st  ON ca.staff_id  = st.id
    ${where}
    `,
    params
  );

  const [[{ distinct_lecturers }]] = await pool.query(
    `
    SELECT COUNT(DISTINCT ca.staff_id) AS distinct_lecturers
    FROM course_assignments ca
    JOIN courses c   ON ca.course_id = c.id
    JOIN staff   st  ON ca.staff_id  = st.id
    ${where}
    `,
    params
  );

  // ----------------------------------------------------
  // Render
  // ----------------------------------------------------
  res.render('courses/assigned', {
    title: 'Assigned Courses',
    pageTitle: 'View Assigned Course(s)',
    q,
    assignments,

    summary: {
      total_assignments,
      distinct_courses,
      distinct_lecturers
    },

    total,
    page,
    pageSize
  });
}
