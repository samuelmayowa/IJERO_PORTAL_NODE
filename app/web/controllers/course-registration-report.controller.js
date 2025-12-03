// app/web/controllers/course-registration-report.controller.js

import pool from '../../core/db.js';

/**
 * Utility loaders (same style as your other controllers)
 */
async function getSessions() {
  const [rows] = await pool.query(
    'SELECT id, name, is_current FROM sessions ORDER BY id DESC'
  );
  return rows;
}

async function getSchools() {
  const [rows] = await pool.query(
    'SELECT id, name FROM schools ORDER BY name'
  );
  return rows;
}

async function getDepartments() {
  const [rows] = await pool.query(
    'SELECT id, name, school_id FROM departments ORDER BY name'
  );
  return rows;
}

/**
 * GET /staff/registration/report
 * Main page (filters + table shell)
 */
export async function listPage(req, res) {
  res.locals.layout = 'layouts/adminlte';

  let sessions = [];
  let schools = [];
  let departments = [];

  try {
    sessions = await getSessions();
  } catch (e) {
    console.error('regReport sessions', e);
  }
  try {
    schools = await getSchools();
  } catch (e) {
    console.error('regReport schools', e);
  }
  try {
    departments = await getDepartments();
  } catch (e) {
    console.error('regReport departments', e);
  }

  const staff = req.session?.staff || req.session?.user || {};
  const hodDeptId = staff?.department_id ?? null;

  res.render('registration/report', {
    title: 'Course Registration Report',
    pageTitle: 'Course Registration Report',
    sessions,
    schools,
    departments,
    hodDeptId,
  });
}

/**
 * Helper: build WHERE clause from querystring
 * Filters are aligned with your existing schema:
 * - student_course_regs: id, student_id, session_id, semester, course_id, reg_type, status, units
 * - student_profiles: school_id, department_id, level
 * - courses: code, title, level
 */
function buildBaseWhere(req) {
  const q = req.query || {};
  const where = [];
  const params = [];

  // Session filter
  if (q.session_id) {
    where.push('r.session_id = ?');
    params.push(q.session_id);
  }

  // Semester (FIRST / SECOND)
  if (q.semester) {
    where.push('r.semester = ?');
    params.push(String(q.semester).toUpperCase());
  }

  // School / Department via student_profiles
  if (q.school_id) {
    where.push('sp.school_id = ?');
    params.push(q.school_id);
  }

  if (q.department_id) {
    where.push('sp.department_id = ?');
    params.push(q.department_id);
  }

  // Level (from student_profiles.level)
  if (q.level) {
    where.push('sp.level = ?');
    params.push(q.level);
  }

  // NOTE: we DO NOT apply status filter here – it's applied after grouping.

  // Registration type (MAIN / ELECTIVE)
  if (q.reg_type) {
    where.push('r.reg_type = ?');
    params.push(String(q.reg_type).toUpperCase());
  }

  // Course code filter
  if (q.course_code) {
    where.push('c.code = ?');
    params.push(String(q.course_code).toUpperCase());
  }

  // Restrict HOD to their own department (same style as uniform report)
  const role = (req.session?.user?.role || req.session?.staff?.role || '').toLowerCase();
  if (role === 'hod') {
    const hodDeptId = req.session?.user?.department_id || req.session?.staff?.department_id;
    if (hodDeptId) {
      where.push('sp.department_id = ?');
      params.push(hodDeptId);
    }
  }

  // Free-text search: username + names + course code/title
  if (q.q) {
    const like = `%${q.q}%`;
    where.push(`
      (
        pu.username LIKE ?
        OR pu.first_name LIKE ?
        OR pu.middle_name LIKE ?
        OR pu.last_name LIKE ?
        OR c.code LIKE ?
        OR c.title LIKE ?
      )
    `);
    params.push(like, like, like, like, like, like);
  }

  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { clause, params };
}

/**
 * GET /staff/registration/report/data
 * JSON list + summary counts (AJAX) grouped per student/session/semester.
 *
 * Summary numbers:
 *  - draftRegistrations: number of registration groups (student+session+semester) with NO submitted course
 *  - registeredCourses: total number of submitted course rows (status = SUBMITTED)
 *  - registeredStudents: number of registration groups with at least one submitted course
 *  - deptAverage: average number of registered students per department
 *  - total: total number of groups (used for pagination)
 */
export async function fetchData(req, res) {
  const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize ?? '20', 10)));
  const offset = (page - 1) * pageSize;

  const { clause, params } = buildBaseWhere(req);

  // Status filter applied after grouping
  const statusFilter = String(req.query.status || '').toUpperCase();

  const groupBaseSql = `
    FROM student_course_regs r
    JOIN courses c
      ON c.id = r.course_id
    LEFT JOIN public_users pu
      ON pu.id = r.student_id
    LEFT JOIN student_profiles sp
      ON sp.user_id = r.student_id
    LEFT JOIN schools sc
      ON sc.id = sp.school_id
    LEFT JOIN departments d
      ON d.id = sp.department_id
    LEFT JOIN programmes p
      ON p.id = sp.programme_id
  `;

  const groupByClause = `
    GROUP BY
      r.student_id,
      r.session_id,
      r.semester,
      sp.department_id,
      sp.school_id,
      sp.programme_id,
      sp.level,
      pu.username,
      pu.first_name,
      pu.middle_name,
      pu.last_name,
      sc.name,
      d.name,
      p.name
  `;

  // Core grouped subquery: one row per student/session/semester
  const groupedSubquery = `
    SELECT
      r.student_id,
      r.session_id,
      r.semester,
      sp.department_id,
      sp.school_id,
      sp.programme_id,
      sp.level AS student_level,
      pu.username AS student_username,
      CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS student_name,
      sc.name AS school_name,
      d.name AS department_name,
      p.name AS programme_name,
      COUNT(*) AS course_cnt,
      SUM(
        CASE WHEN UPPER(r.status) = 'SUBMITTED' THEN 1 ELSE 0 END
      ) AS submitted_cnt,
      -- total units for SUBMITTED courses only (i.e. actually registered)
      SUM(
        CASE WHEN UPPER(r.status) = 'SUBMITTED'
             THEN COALESCE(r.units, c.unit, 0)
             ELSE 0
        END
      ) AS total_units
    ${groupBaseSql}
    ${clause}
    ${groupByClause}
  `;

  let statusWhereClause = '';
  if (statusFilter === 'SUBMITTED') {
    statusWhereClause = 'WHERE g.submitted_cnt > 0';
  } else if (statusFilter === 'PENDING') {
    // "PENDING" = completely draft / nothing submitted
    statusWhereClause = 'WHERE g.submitted_cnt = 0';
  }

  // Summary over grouped rows
  const summarySql = `
    SELECT
      COUNT(*) AS total_groups,
      SUM(g.submitted_cnt) AS registered_courses,
      SUM(CASE WHEN g.submitted_cnt = 0 THEN 1 ELSE 0 END) AS draft_groups,
      SUM(CASE WHEN g.submitted_cnt > 0 THEN 1 ELSE 0 END) AS registered_students
    FROM (
      ${groupedSubquery}
    ) AS g
    ${statusWhereClause}
  `;

  // Average registered students per department
  const avgDeptSql = `
    SELECT
      AVG(registered_student_cnt) AS avg_per_department
    FROM (
      SELECT
        g.department_id,
        COUNT(*) AS registered_student_cnt
      FROM (
        ${groupedSubquery}
      ) AS g
      ${statusWhereClause}
      WHERE g.submitted_cnt > 0 AND g.department_id IS NOT NULL
      GROUP BY g.department_id
    ) AS t
  `;

  // Paged list for table
  const selectSql = `
    SELECT
      g.student_id,
      g.session_id,
      g.semester,
      g.student_level,
      g.department_id,
      g.school_id,
      g.programme_id,
      g.student_username,
      g.student_name,
      g.school_name,
      g.department_name,
      g.programme_name,
      g.course_cnt,
      g.submitted_cnt,
      g.total_units,
      CASE
        WHEN g.submitted_cnt > 0 THEN 'REGISTERED'
        ELSE 'DRAFT'
      END AS registration_status
    FROM (
      ${groupedSubquery}
    ) AS g
    ${statusWhereClause}
    ORDER BY g.session_id DESC, g.semester, g.student_username
    LIMIT ? OFFSET ?
  `;

  let rows = [];
  let totals = {
    total_groups: 0,
    registered_courses: 0,
    draft_groups: 0,
    registered_students: 0,
    avg_per_department: 0,
  };

  try {
    const [sumRows] = await pool.query(summarySql, params);
    if (sumRows && sumRows[0]) {
      totals.total_groups = Number(sumRows[0].total_groups || 0);
      totals.registered_courses = Number(sumRows[0].registered_courses || 0);
      totals.draft_groups = Number(sumRows[0].draft_groups || 0);
      totals.registered_students = Number(sumRows[0].registered_students || 0);
    }

    const [avgRows] = await pool.query(avgDeptSql, params);
    if (avgRows && avgRows[0] && avgRows[0].avg_per_department != null) {
      totals.avg_per_department = Number(avgRows[0].avg_per_department || 0);
    }

    const [dataRows] = await pool.query(selectSql, [...params, pageSize, offset]);
    rows = dataRows;
  } catch (e) {
    console.error('course-registration-report fetchData error:', e);
  }

  res.json({
    ok: true,
    page,
    pageSize,
    total: totals.total_groups,
    draftRegistrations: totals.draft_groups,
    registeredCourses: totals.registered_courses,
    registeredStudents: totals.registered_students,
    deptAverage: totals.avg_per_department,
    items: rows,
  });
}

/**
 * GET /staff/registration/report/export.csv
 * CSV export (max 5000 grouped rows) using same filters
 */
export async function exportCsv(req, res) {
  const { clause, params } = buildBaseWhere(req);
  const statusFilter = String(req.query.status || '').toUpperCase();

  const groupBaseSql = `
    FROM student_course_regs r
    JOIN courses c
      ON c.id = r.course_id
    LEFT JOIN public_users pu
      ON pu.id = r.student_id
    LEFT JOIN student_profiles sp
      ON sp.user_id = r.student_id
    LEFT JOIN schools sc
      ON sc.id = sp.school_id
    LEFT JOIN departments d
      ON d.id = sp.department_id
    LEFT JOIN programmes p
      ON p.id = sp.programme_id
  `;

  const groupByClause = `
    GROUP BY
      r.student_id,
      r.session_id,
      r.semester,
      sp.department_id,
      sp.school_id,
      sp.programme_id,
      sp.level,
      pu.username,
      pu.first_name,
      pu.middle_name,
      pu.last_name,
      sc.name,
      d.name,
      p.name
  `;

  const groupedSubquery = `
    SELECT
      r.student_id,
      r.session_id,
      r.semester,
      sp.department_id,
      sp.school_id,
      sp.programme_id,
      sp.level AS student_level,
      pu.username AS student_username,
      CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS student_name,
      sc.name AS school_name,
      d.name AS department_name,
      p.name AS programme_name,
      COUNT(*) AS course_cnt,
      SUM(
        CASE WHEN UPPER(r.status) = 'SUBMITTED' THEN 1 ELSE 0 END
      ) AS submitted_cnt,
      SUM(
        CASE WHEN UPPER(r.status) = 'SUBMITTED'
             THEN COALESCE(r.units, c.unit, 0)
             ELSE 0
        END
      ) AS total_units
    ${groupBaseSql}
    ${clause}
    ${groupByClause}
  `;

  let statusWhereClause = '';
  if (statusFilter === 'SUBMITTED') {
    statusWhereClause = 'WHERE g.submitted_cnt > 0';
  } else if (statusFilter === 'PENDING') {
    statusWhereClause = 'WHERE g.submitted_cnt = 0';
  }

  const sql = `
    SELECT
      g.student_username AS student_id,
      g.student_name,
      g.session_id,
      g.semester,
      g.school_name AS school,
      g.department_name AS department,
      g.programme_name AS programme,
      g.student_level AS level,
      g.course_cnt AS registered_courses,
      g.submitted_cnt AS submitted_courses,
      g.total_units AS total_units,
      CASE
        WHEN g.submitted_cnt > 0 THEN 'REGISTERED'
        ELSE 'DRAFT'
      END AS registration_status
    FROM (
      ${groupedSubquery}
    ) AS g
    ${statusWhereClause}
    ORDER BY g.session_id DESC, g.semester, g.student_username
    LIMIT 5000
  `;

  let rows = [];
  try {
    const [r] = await pool.query(sql, params);
    rows = r;
  } catch (e) {
    console.error('course-registration-report exportCsv error:', e);
  }

  const headers = Object.keys(
    rows[0] || {
      student_id: '',
      student_name: '',
      session_id: '',
      semester: '',
      school: '',
      department: '',
      programme: '',
      level: '',
      registered_courses: '',
      submitted_courses: '',
      total_units: '',
      registration_status: '',
    }
  );

  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="course-registration-report.csv"'
  );
  res.send(lines.join('\r\n'));
}
