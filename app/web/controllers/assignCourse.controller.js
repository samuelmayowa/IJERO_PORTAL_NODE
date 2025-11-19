// ======================================================================
//  ASSIGN COURSE CONTROLLER — CLEAN, ADD-COURSE STYLE (FIXED SESSION)
// ======================================================================
import pool from '../../core/db.js';

// -------------------------------------------------------------
// Assign Page
// -------------------------------------------------------------
export async function assignPage(req, res) {
  const q = (req.query.q || '').trim();
  const page = parseInt(req.query.page || '1', 10) || 1;
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  // Use same session pattern as other working controllers
  const sessionUser = req.session?.user || req.session?.staff || {};
  const role = (sessionUser.role || '').toLowerCase();
  const userId = sessionUser.id;

  // Load sessions + semesters
  const [sessions]  = await pool.query(`SELECT id, name FROM sessions ORDER BY id DESC`);
  const [semesters] = await pool.query(`SELECT id, name FROM semesters ORDER BY id`);

  // WHERE for assignment listing
  let where = 'WHERE 1';
  const params = [];

  if (q) {
    where += ` AND (c.code LIKE ? OR c.title LIKE ? OR st.full_name LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  if (role === 'hod' && userId) {
    where += ` AND c.department_id = (SELECT department_id FROM staff WHERE id = ?)`;
    params.push(userId);
  }

  if (role === 'dean' && userId) {
    where += ` AND c.school_id = (SELECT school_id FROM staff WHERE id = ?)`;
    params.push(userId);
  }

  // Count
  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM course_assignments ca
    JOIN courses c ON ca.course_id = c.id
    JOIN staff   st ON ca.staff_id = st.id
    ${where}
    `,
    params
  );

  // Assignment list
  const [assignments] = await pool.query(
    `
    SELECT 
      ca.id,
      ca.session_id,
      ca.semester,
      s.name AS session_name,
      c.code,
      c.title,
      st.full_name AS lecturer_name,
      d.name AS department,
      sc.name AS school
    FROM course_assignments ca
    JOIN courses c ON ca.course_id = c.id
    JOIN staff   st ON ca.staff_id = st.id
    JOIN sessions s ON s.id = ca.session_id
    LEFT JOIN departments d ON c.department_id = d.id
    LEFT JOIN schools     sc ON c.school_id = sc.id
    ${where}
    ORDER BY ca.assigned_at DESC
    LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset]
  );

  // Summary section
  let summaryWhere = 'WHERE 1';
  const summaryParams = [];

  if (role === 'hod' && userId) {
    summaryWhere += ` AND department_id = (SELECT department_id FROM staff WHERE id = ?)`;
    summaryParams.push(userId);
  }
  if (role === 'dean' && userId) {
    summaryWhere += ` AND school_id = (SELECT school_id FROM staff WHERE id = ?)`;
    summaryParams.push(userId);
  }

  const [[{ total_courses }]] = await pool.query(
    `SELECT COUNT(*) AS total_courses FROM courses ${summaryWhere}`,
    summaryParams
  );

  const [[{ total_assigned }]] = await pool.query(
    `
    SELECT COUNT(*) AS total_assigned
    FROM course_assignments ca
    JOIN courses c ON ca.course_id = c.id
    ${summaryWhere
      .replace(/department_id/g, 'c.department_id')
      .replace(/school_id/g, 'c.school_id')}
    `,
    summaryParams
  );

  const total_unassigned = total_courses - total_assigned;

  const [[{ total_lecturers }]] = await pool.query(`
    SELECT COUNT(*) AS total_lecturers
    FROM staff
    WHERE id IN (
      SELECT staff_id FROM staff_roles 
      WHERE role_id = (SELECT id FROM roles WHERE name='lecturer' LIMIT 1)
    )
  `);

  // Flash
  const success = req.flash('success')[0] || '';
  const error   = req.flash('error')[0] || '';
  let confirm = null;
  try {
    const d = req.flash('confirmData')[0];
    confirm = d ? JSON.parse(d) : null;
  } catch {}

  res.render('courses/assign', {
    title: 'Assign Course',
    pageTitle: 'Assign Course to Lecturer',
    csrfToken: res.locals.csrfToken,
    q,
    sessions,
    semesters,
    assignments,
    summary: {
      total_courses,
      total_assigned,
      total_unassigned,
      total_lecturers
    },
    success,
    error,
    confirm,
    total,
    page,
    pageSize
  });
}

// -------------------------------------------------------------
// Fetch course by code
// -------------------------------------------------------------
export async function fetchCourseByCode(req, res) {
  const code = (req.query.code || '').trim();
  if (!code) return res.json({ ok: false });

  const [rows] = await pool.query(
    `SELECT id, code, title, unit FROM courses WHERE code = ? LIMIT 1`,
    [code]
  );
  if (!rows.length) return res.json({ ok: false });

  return res.json({ ok: true, course: rows[0] });
}

// -------------------------------------------------------------
// Staff autocomplete
// -------------------------------------------------------------
export async function fetchStaffList(req, res) {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, items: [] });

  const [rows] = await pool.query(
    `
    SELECT st.id, st.full_name, d.name AS dept
    FROM staff st
    LEFT JOIN departments d ON d.id = st.department_id
    WHERE st.full_name LIKE ?
    ORDER BY st.full_name
    LIMIT 10
    `,
    [`%${q}%`]
  );

  return res.json({
    ok: true,
    items: rows.map(r => ({
      id: r.id,
      full_name: r.full_name,
      dept: r.dept || 'Unknown'
    }))
  });
}

// -------------------------------------------------------------
// Submit Assignment
// -------------------------------------------------------------
export async function assignCourse(req, res) {
  let { course_id, staff_id, session_id, semester } = req.body || {};

  // Coerce and validate input like other controllers
  course_id  = parseInt(course_id, 10)  || 0;
  staff_id   = parseInt(staff_id, 10)   || 0;
  session_id = parseInt(session_id, 10) || 0;
  semester   = String(semester || '').trim().toUpperCase();

  if (!course_id || !staff_id || !session_id || !semester) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/staff/courses/assign');
  }

  // Use same session pattern as uniform/report: user OR staff
  const user = req.session?.user || req.session?.staff || null;
  if (!user || !user.id) {
    req.flash('error', 'Session expired or not logged in.');
    return res.redirect('/staff/courses/assign');
  }

  const role     = (user.role || '').toLowerCase();
  const override = req.query.override === '1';

  // Lookup course
  const [[course]] = await pool.query(
    `SELECT id, department_id, school_id FROM courses WHERE id = ?`,
    [course_id]
  );
  if (!course) {
    req.flash('error', 'Course not found.');
    return res.redirect('/staff/courses/assign');
  }

  // Role restrictions (HOD / Dean)
  if (role === 'hod') {
    const [[me]] = await pool.query(
      `SELECT department_id FROM staff WHERE id = ?`,
      [user.id]
    );
    if (!me || me.department_id !== course.department_id) {
      req.flash('error', 'This course does not belong to your department.');
      return res.redirect('/staff/courses/assign');
    }
  }

  if (role === 'dean') {
    const [[me]] = await pool.query(
      `SELECT school_id FROM staff WHERE id = ?`,
      [user.id]
    );
    if (!me || me.school_id !== course.school_id) {
      req.flash('error', 'This course does not belong to your school.');
      return res.redirect('/staff/courses/assign');
    }
  }

  // Duplicate check
  const [exists] = await pool.query(
    `
    SELECT ca.id, st.full_name AS existing_name
    FROM course_assignments ca
    JOIN staff st ON st.id = ca.staff_id
    WHERE ca.course_id = ?
      AND ca.session_id = ?
      AND ca.semester = ?
    `,
    [course_id, session_id, semester]
  );

  if (exists.length && !override) {
    const [[newLecturer]] = await pool.query(
      `SELECT full_name FROM staff WHERE id = ?`,
      [staff_id]
    );

    req.flash('confirmData', JSON.stringify({
      needConfirm: true,
      course_id,
      staff_id_new: staff_id,
      session_id,
      semester,
      existingLecturerName: exists[0].existing_name,
      newLecturerName: newLecturer?.full_name || ''
    }));

    return res.redirect('/staff/courses/assign');
  }

  // If override → delete previous
  if (override) {
    await pool.query(
      `DELETE FROM course_assignments WHERE course_id = ? AND session_id = ? AND semester = ?`,
      [course_id, session_id, semester]
    );
  }

  // Insert new assignment
  await pool.query(
    `
    INSERT INTO course_assignments
      (course_id, staff_id, session_id, semester, assigned_at)
    VALUES (?, ?, ?, ?, NOW())
    `,
    [course_id, staff_id, session_id, semester]
  );


  req.flash('success', override ? 'Course reassigned.' : 'Course assigned.');
  return res.redirect('/staff/courses/assign');
}

// -------------------------------------------------------------
// Unassign
// -------------------------------------------------------------
export async function unassignCourse(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  if (!id) {
    req.flash('error', 'Invalid assignment.');
    return res.redirect('/staff/courses/assign');
  }

  await pool.query(`DELETE FROM course_assignments WHERE id = ?`, [id]);

  req.flash('success', 'Course unassigned.');
  res.redirect('/staff/courses/assign');
}
