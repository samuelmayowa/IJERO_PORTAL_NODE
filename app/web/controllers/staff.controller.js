// app/web/controllers/staff.controller.js
import { pool } from '../../core/db.js';
import bcrypt from 'bcryptjs';

/* -------------------- Dashboard -------------------- */
export const transcriptsMenu = (_req, res) => res.render('pages/staff-transcripts');
export const resultsMenu = (_req, res) => res.render('pages/staff-results');
export const recordsMenu = (_req, res) => res.render('pages/staff-records');

/**
 * Small schema helpers (so we can support slightly different DB layouts safely)
 */
const _schemaCache = {
  tables: new Map(),   // tableNameLower -> boolean
  cols: new Map(),     // tableNameLower -> Set(colLower)
};

async function tableExists(tableName) {
  const key = String(tableName).toLowerCase();
  if (_schemaCache.tables.has(key)) return _schemaCache.tables.get(key);

  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = ?`,
      [tableName]
    );
    const ok = Number(row?.cnt || 0) > 0;
    _schemaCache.tables.set(key, ok);
    return ok;
  } catch (e) {
    // If information_schema is blocked, assume it exists and let queries fail/fallback.
    _schemaCache.tables.set(key, true);
    return true;
  }
}

async function getColumns(tableName) {
  const key = String(tableName).toLowerCase();
  if (_schemaCache.cols.has(key)) return _schemaCache.cols.get(key);

  const set = new Set();
  try {
    const [rows] = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?`,
      [tableName]
    );
    (rows || []).forEach(r => set.add(String(r.column_name || '').toLowerCase()));
  } catch (e) {
    // if blocked, keep empty set and rely on try/catch fallbacks
  }
  _schemaCache.cols.set(key, set);
  return set;
}

async function pickColumn(tableName, candidates = []) {
  const cols = await getColumns(tableName);
  for (const c of candidates) {
    if (cols.has(String(c).toLowerCase())) return c;
  }
  return null;
}

/**
 * Detect if current flag is stored as 1 or 0 for a given table
 * (your message suggests some environments use 0 as "current")
 */
async function detectCurrentFlag(tableName) {
  try {
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN is_current=1 THEN 1 ELSE 0 END) AS ones,
         SUM(CASE WHEN is_current=0 THEN 1 ELSE 0 END) AS zeros
       FROM ${tableName}`
    );

    const ones = Number(row?.ones || 0);
    const zeros = Number(row?.zeros || 0);

    if (ones === 1) return 1;
    if (zeros === 1) return 0;

    return 1;
  } catch (e) {
    return 1;
  }
}

async function getCurrentSession() {
  try {
    const flag = await detectCurrentFlag('sessions');
    const [[row]] = await pool.query(
      `SELECT id, name
         FROM sessions
        WHERE is_current=?
        ORDER BY id DESC
        LIMIT 1`,
      [flag]
    );

    if (row?.id) return { id: row.id, name: row.name || 'N/A' };

    const [[fallback]] = await pool.query(`SELECT id, name FROM sessions ORDER BY id DESC LIMIT 1`);
    return { id: fallback?.id ?? null, name: fallback?.name ?? 'N/A' };
  } catch (e) {
    return { id: null, name: 'N/A' };
  }
}

async function getCurrentSemester() {
  try {
    const flag = await detectCurrentFlag('semesters');
    const [[row]] = await pool.query(
      `SELECT id, name
         FROM semesters
        WHERE is_current=?
        ORDER BY id DESC
        LIMIT 1`,
      [flag]
    );

    if (row?.id) return { id: row.id, name: row.name || 'N/A' };

    const [[fallback]] = await pool.query(`SELECT id, name FROM semesters ORDER BY id DESC LIMIT 1`);
    return { id: fallback?.id ?? null, name: fallback?.name ?? 'N/A' };
  } catch (e) {
    return { id: null, name: 'N/A' };
  }
}

function normRole(role) {
  return String(role || '').toLowerCase().trim();
}

function roleScope(user) {
  const r = normRole(user?.role);

  const deptId = user?.department_id ?? user?.departmentId ?? null;
  const schoolId = user?.school_id ?? user?.schoolId ?? null;
  const staffId = user?.id ?? user?.staff_id ?? user?.staffId ?? null;

  const isAdminLike =
    r.includes('admin') ||
    r.includes('administrator') ||
    r.includes('registry') ||
    r.includes('bursary');

  const isDean = r.includes('dean');
  const isHod = r.includes('hod');
  const isLecturer = r.includes('lecturer');

  if (isAdminLike) {
    return { scope: 'all', deptId, schoolId, staffId, recentRegMode: 'all' };
  }
  if (isDean) {
    return { scope: 'school', deptId, schoolId, staffId, recentRegMode: 'school' };
  }
  if (isHod) {
    return { scope: 'department', deptId, schoolId, staffId, recentRegMode: 'department' };
  }
  if (isLecturer) {
    // counts/attendance per department, but registrations only for assigned courses
    return { scope: 'department', deptId, schoolId, staffId, recentRegMode: 'lecturerCourses' };
  }

  // fallback: behave like admin (prevents blank dashboards for unknown roles)
  return { scope: 'all', deptId, schoolId, staffId, recentRegMode: 'all' };
}

function formatDate(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return String(val);
}

async function getStaffTotalScoped(scope) {
  try {
    if (scope.scope === 'department' && scope.deptId) {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff WHERE department_id=?`, [scope.deptId]);
      return Number(row?.cnt || 0);
    }
    if (scope.scope === 'school' && scope.schoolId) {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff WHERE school_id=?`, [scope.schoolId]);
      return Number(row?.cnt || 0);
    }
    const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff`);
    return Number(row?.cnt || 0);
  } catch (e) {
    return 0;
  }
}

async function getAttendanceRowsScoped(scope) {
  try {
    let sql = `
      SELECT
        ar.staff_id,
        s.staff_no,
        s.full_name,
        ar.status,
        ar.check_in_time,
        ar.check_out_time,
        ar.created_at
      FROM attendance_records ar
      JOIN staff s ON s.id = ar.staff_id
    `;

    const where = [];
    const params = [];

    if (scope.scope === 'department' && scope.deptId) {
      where.push(`s.department_id=?`);
      params.push(scope.deptId);
    } else if (scope.scope === 'school' && scope.schoolId) {
      where.push(`s.school_id=?`);
      params.push(scope.schoolId);
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')} `;
    sql += ` ORDER BY ar.created_at DESC LIMIT 5`;

    const [rows] = await pool.query(sql, params);

    return (rows || []).map(r => {
      const raw = String(r.status || '');
      const up = raw.toUpperCase();

      let status = raw;
      if (up.startsWith('PRESENT')) status = 'Online';
      else if (up === 'ON LEAVE') status = 'On-Leave';
      else if (up === 'ABSENT') status = 'Absent';

      return {
        staffId: r.staff_no,
        name: r.full_name,
        status,
        time: r.check_in_time || r.check_out_time || ''
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Count applicants/students from public_users, with role-based scoping.
 * Strategy:
 *  1) If public_users has department_id/school_id => filter directly
 *  2) Else, for students fallback to counting DISTINCT student_course_regs by course.department_id/school_id
 *     (because some schemas store dept/school only on course/reg side)
 */
async function countPublicUsersScoped(userRole, scope) {
  const role = String(userRole).toLowerCase();

  // direct filter on public_users if possible
  try {
    const puDeptCol = await pickColumn('public_users', ['department_id', 'dept_id']);
    const puSchoolCol = await pickColumn('public_users', ['school_id']);

    let sql = `
      SELECT COUNT(*) AS cnt
        FROM public_users pu
       WHERE LOWER(COALESCE(pu.role,'')) = ?
    `;
    const params = [role];

    if (scope.scope === 'department' && scope.deptId && puDeptCol) {
      sql += ` AND pu.\`${puDeptCol}\` = ?`;
      params.push(scope.deptId);
    } else if (scope.scope === 'school' && scope.schoolId && puSchoolCol) {
      sql += ` AND pu.\`${puSchoolCol}\` = ?`;
      params.push(scope.schoolId);
    }

    const [[row]] = await pool.query(sql, params);
    return Number(row?.cnt || 0);
  } catch (e) {
    // continue to fallback below
  }

  // fallback (best-effort) for STUDENTS only: infer by course department/school via registrations
  if (role === 'student') {
    try {
      const regsStudentCol = await pickColumn('student_course_regs', ['student_id', 'user_id', 'public_user_id']);
      const regsCourseCol = await pickColumn('student_course_regs', ['course_id']);
      const courseDeptCol = await pickColumn('courses', ['department_id', 'dept_id']);
      const courseSchoolCol = await pickColumn('courses', ['school_id']);

      if (!regsStudentCol || !regsCourseCol) throw new Error('missing reg columns');

      let sql = `
        SELECT COUNT(DISTINCT r.\`${regsStudentCol}\`) AS cnt
          FROM student_course_regs r
          JOIN public_users pu ON pu.id = r.\`${regsStudentCol}\`
          JOIN courses c ON c.id = r.\`${regsCourseCol}\`
         WHERE LOWER(COALESCE(pu.role,'')) = 'student'
      `;
      const params = [];

      if (scope.scope === 'department' && scope.deptId && courseDeptCol) {
        sql += ` AND c.\`${courseDeptCol}\` = ?`;
        params.push(scope.deptId);
      } else if (scope.scope === 'school' && scope.schoolId && courseSchoolCol) {
        sql += ` AND c.\`${courseSchoolCol}\` = ?`;
        params.push(scope.schoolId);
      }

      const [[row]] = await pool.query(sql, params);
      return Number(row?.cnt || 0);
    } catch (e) {
      // ignore
    }
  }

  // last resort: global count by role
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM public_users
        WHERE LOWER(COALESCE(role,'')) = ?`,
      [role]
    );
    return Number(row?.cnt || 0);
  } catch (e) {
    return 0;
  }
}

/**
 * Recent registrations:
 * - Admin/Registry/Bursary: last 4 overall (for current session+semester; fallback to all-time)
 * - HOD: last 4 within department
 * - Dean: last 4 within school
 * - Lecturer: last 4 for courses assigned to him
 */
async function getRecentCourseRegs(scope, currentSession, currentSemester) {
  const sessionId = currentSession?.id ?? null;
  const semesterName = currentSemester?.name ?? null;

  const regsStudentCol = await pickColumn('student_course_regs', ['student_id', 'user_id', 'public_user_id']);
  const regsCourseCol = await pickColumn('student_course_regs', ['course_id']);
  const regsSessionCol = await pickColumn('student_course_regs', ['session_id']);
  const regsSemesterCol = await pickColumn('student_course_regs', ['semester', 'semester_name']);
  const regsDateCol = await pickColumn('student_course_regs', [
    'created_at', 'createdAt', 'date_created', 'created_on', 'updated_at', 'updatedAt'
  ]);

  const puMatricCol = await pickColumn('public_users', ['matric_number', 'matric_no']);
  const puUserCol = await pickColumn('public_users', ['username', 'email']);

  const courseCodeCol = await pickColumn('courses', ['course_code', 'code', 'courseCode']);
  const courseNameCol = await pickColumn('courses', ['title', 'name', 'course_title', 'course_name']);

  const courseDeptCol = await pickColumn('courses', ['department_id', 'dept_id']);
  const courseSchoolCol = await pickColumn('courses', ['school_id']);

  // course assignment mapping for lecturers
  const caStaffCol = await pickColumn('course_assignments', ['staff_id', 'lecturer_id', 'user_id']);
  const caCourseCol = await pickColumn('course_assignments', ['course_id']);

  // If core columns are missing, return empty rather than crashing
  if (!regsStudentCol || !regsCourseCol) return [];

  const matricExpr = puMatricCol ? `pu.\`${puMatricCol}\`` : (puUserCol ? `pu.\`${puUserCol}\`` : `pu.id`);
  const courseExpr =
    courseCodeCol ? `c.\`${courseCodeCol}\`` :
    (courseNameCol ? `c.\`${courseNameCol}\`` : `c.id`);

  const dateExpr = regsDateCol ? `r.\`${regsDateCol}\`` : `r.id`;

  const buildQuery = (useCurrentFilters) => {
    let sql = `
      SELECT
        ${matricExpr} AS matric,
        ${courseExpr} AS course,
        ${dateExpr} AS date_val
      FROM student_course_regs r
      JOIN public_users pu ON pu.id = r.\`${regsStudentCol}\`
      JOIN courses c ON c.id = r.\`${regsCourseCol}\`
    `;
    const where = [];
    const params = [];

    // Lecturer: only his assigned courses
    if (scope.recentRegMode === 'lecturerCourses' && scope.staffId && caStaffCol && caCourseCol) {
      sql += `
        JOIN course_assignments ca ON ca.\`${caCourseCol}\` = r.\`${regsCourseCol}\`
      `;
      where.push(`ca.\`${caStaffCol}\` = ?`);
      params.push(scope.staffId);
    }

    // HOD: department
    if (scope.recentRegMode === 'department' && scope.deptId && courseDeptCol) {
      where.push(`c.\`${courseDeptCol}\` = ?`);
      params.push(scope.deptId);
    }

    // Dean: school
    if (scope.recentRegMode === 'school' && scope.schoolId && courseSchoolCol) {
      where.push(`c.\`${courseSchoolCol}\` = ?`);
      params.push(scope.schoolId);
    }

    // Session/Semester filter (only if requested + columns exist)
    if (useCurrentFilters && sessionId && regsSessionCol) {
      where.push(`r.\`${regsSessionCol}\` = ?`);
      params.push(sessionId);
    }
    if (useCurrentFilters && semesterName && regsSemesterCol) {
      // compare case-insensitive
      where.push(`LOWER(COALESCE(r.\`${regsSemesterCol}\`,'')) = LOWER(?)`);
      params.push(semesterName);
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')} `;

    // newest first
    if (regsDateCol) {
      sql += ` ORDER BY r.\`${regsDateCol}\` DESC, r.id DESC `;
    } else {
      sql += ` ORDER BY r.id DESC `;
    }
    sql += ` LIMIT 4`;

    return { sql, params };
  };

  // 1) Try current session+semester
  try {
    const q1 = buildQuery(true);
    const [rows1] = await pool.query(q1.sql, q1.params);
    const mapped1 = (rows1 || []).map(r => ({
      matric: r.matric || '',
      course: r.course || '',
      date: formatDate(r.date_val)
    }));
    if (mapped1.length) return mapped1;
  } catch (_) {
    // ignore and fallback
  }

  // 2) Fallback to ALL-TIME (still scoped by role)
  try {
    const q2 = buildQuery(false);
    const [rows2] = await pool.query(q2.sql, q2.params);
    return (rows2 || []).map(r => ({
      matric: r.matric || '',
      course: r.course || '',
      date: formatDate(r.date_val)
    }));
  } catch (e) {
    return [];
  }
}

export const dashboard = async (req, res) => {
  const user = req.session?.user || null;
  const scope = roleScope(user);

  // sidebar (unchanged)
  const sidebar = [
    { label: 'Dashboard', href: '/staff/dashboard', icon: 'fas fa-tachometer-alt', active: true },
    { label: 'Student Academic Records', href: '/records', icon: 'fas fa-table' },
    { label: 'Result Computation', href: '/results', icon: 'fas fa-calculator' },
    { label: 'Generate Transcript', href: '/transcripts/generate', icon: 'far fa-file-alt' },
    { label: 'View / Download Transcript', href: '/transcripts/view', icon: 'far fa-file-pdf' },
    { label: 'Send Transcript', href: '/transcripts/send', icon: 'fas fa-paper-plane' }
  ];

  try {
    // current session/semester (auto-detect is_current being 0 or 1)
    const [currentSession, currentSemester] = await Promise.all([
      getCurrentSession(),
      getCurrentSemester()
    ]);

    // totals (scoped)
    const [totalStaff, totalStudents, totalApplicants] = await Promise.all([
      getStaffTotalScoped(scope),
      countPublicUsersScoped('student', scope),
      countPublicUsersScoped('applicant', scope),
    ]);

    // attendance + regs (scoped)
    const [attendance, recentCourseRegs] = await Promise.all([
      getAttendanceRowsScoped(scope),
      getRecentCourseRegs(scope, currentSession, currentSemester),
    ]);

    return res.render('pages/staff-dashboard', {
      title: 'Staff Dashboard',
      pageTitle: 'Dashboard',
      role: user?.role,
      user,
      sidebar,

      stats: {
        sessionName: currentSession?.name || 'N/A',
        totalApplicants,
        totalStudents,
        totalStaff
      },

      attendance,
      recentCourseRegs,

      // keep existing demo chart payload as-is
      performanceData: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
        area: [28, 48, 40, 19, 86, 27, 90],
        donut: [40, 30, 30],
        line: [10, 20, 30, 40, 50, 60, 70]
      }
    });
  } catch (err) {
    console.error('dashboard error:', err);

    return res.render('pages/staff-dashboard', {
      title: 'Staff Dashboard',
      pageTitle: 'Dashboard',
      role: user?.role,
      user,
      sidebar,
      stats: { sessionName: 'N/A', totalApplicants: 0, totalStudents: 0, totalStaff: 0 },
      attendance: [],
      recentCourseRegs: [],
      performanceData: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
        area: [28, 48, 40, 19, 86, 27, 90],
        donut: [40, 30, 30],
        line: [10, 20, 30, 40, 50, 60, 70]
      }
    });
  }
};

/* -------------------- Password Reset page + APIs -------------------- */
export async function passwordResetPage(_req, res) {
  try {
    res.render('staff/password-reset', { title: 'Password Reset' });
  } catch (e) {
    console.error(e);
    res.status(500).send('Failed to load page');
  }
}

// GET /staff/api/password/users
export async function listUsersForPasswordReset(req, res) {
  try {
    const {
      page = 1,
      pageSize = 10,
      staffNumber = '',
      department = '',
      school = '',
      email = '',
      name = ''
    } = req.query;

    const limit = Math.max(1, Number(pageSize));
    const offset = Math.max(0, (Number(page) - 1) * limit);

    const filters = [];
    const params = [];

    if (staffNumber) {
      filters.push('s.staff_no LIKE ?');
      params.push(`%${staffNumber}%`);
    }
    if (department) {
      filters.push('d.name LIKE ?');
      params.push(`%${department}%`);
    }
    if (school) {
      filters.push('sc.name LIKE ?');
      params.push(`%${school}%`);
    }
    if (email) {
      filters.push('s.email LIKE ?');
      params.push(`%${email}%`);
    }
    if (name) {
      filters.push('(s.full_name LIKE ? OR s.username LIKE ?)');
      params.push(`%${name}%`, `%${name}%`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const dataSql = `
      SELECT
        s.id, s.staff_no, s.username, s.email, s.status, s.full_name AS name,
        COALESCE(d.name,'')  AS department_name,
        COALESCE(sc.name,'') AS school_name
      FROM staff s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN schools     sc ON sc.id = s.school_id
      ${where}
      ORDER BY s.full_name ASC, s.id ASC
      LIMIT ? OFFSET ?`;

    const countSql = `
      SELECT COUNT(*) AS cnt
      FROM staff s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN schools     sc ON sc.id = s.school_id
      ${where}`;

    const [rows] = await pool.query(dataSql, [...params, limit, offset]);
    const [[{ cnt }]] = await pool.query(countSql, params);

    return res.json({
      ok: true,
      rows,
      page: Number(page),
      pageSize: limit,
      total: Number(cnt) || 0,
      totalPages: Math.max(1, Math.ceil((Number(cnt) || 0) / limit))
    });
  } catch (err) {
    console.error('listUsersForPasswordReset', err);
    return res.status(500).json({ ok: false, error: 'Failed to load users.' });
  }
}

export async function resetPasswordToCollege1(req, res) {
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });

    const hash = await bcrypt.hash('College1', 10);
    await pool.query('UPDATE staff SET password_hash=? WHERE id=? LIMIT 1', [hash, id]);

    res.json({ success: true });
  } catch (e) {
    console.error('resetPasswordToCollege1', e);
    res.status(500).json({ success: false, message: 'Reset failed' });
  }
}

export async function changePasswordByAdmin(req, res) {
  try {
    const { staff_id, password } = req.body || {};
    if (!staff_id || !password)
      return res.status(400).json({ success: false, message: 'Missing fields' });

    const hash = await bcrypt.hash(String(password), 10);
    await pool.query('UPDATE staff SET password_hash=? WHERE id=? LIMIT 1', [
      hash,
      Number(staff_id)
    ]);

    res.json({ success: true });
  } catch (e) {
    console.error('changePasswordByAdmin', e);
    res.status(500).json({ success: false, message: 'Change failed' });
  }
}
