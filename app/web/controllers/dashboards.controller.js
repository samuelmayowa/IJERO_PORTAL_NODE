// app/web/controllers/dashboards.controller.js
import { pool } from '../../core/db.js';

/**
 * FIXED dashboards controller:
 * - Keeps your existing staff-dashboard.ejs working by passing the SAME variable names it expects.
 * - Adds role scoping:
 *   Admin/Registry/Bursary => all
 *   HOD => department
 *   Dean => school
 *   Lecturer => totals by dept, but recent regs only for assigned courses
 */

function toLower(v) {
  return String(v || '').toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

async function getCols(table) {
  try {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?`,
      [table]
    );
    return new Set((rows || []).map(r => r.COLUMN_NAME));
  } catch {
    return new Set();
  }
}

async function getCurrentRow(table) {
  // robust: try is_current=1, then is_current=0, then latest
  try {
    const [r1] = await pool.query(`SELECT id, name FROM \`${table}\` WHERE is_current=1 ORDER BY id DESC LIMIT 1`);
    if (r1?.length) return r1[0];

    const [r0] = await pool.query(`SELECT id, name FROM \`${table}\` WHERE is_current=0 ORDER BY id DESC LIMIT 1`);
    if (r0?.length) return r0[0];

    const [rx] = await pool.query(`SELECT id, name FROM \`${table}\` ORDER BY id DESC LIMIT 1`);
    if (rx?.length) return rx[0];

    return { id: null, name: 'N/A' };
  } catch (e) {
    console.error(`getCurrentRow(${table}) error:`, e);
    return { id: null, name: 'N/A' };
  }
}

async function resolveStaff(req) {
  const s = req.session || {};
  const raw = s.user || s.staff || s.account || null;
  if (!raw) return null;

  const role = toLower(raw.role || raw.user_role || raw.position);
  const staffId = num(pick(raw, ['id', 'staff_id', 'staffId']));
  const username = pick(raw, ['username']);
  const email = pick(raw, ['email']);

  // if session already has these, keep them
  const sessionDept = num(pick(raw, ['department_id', 'departmentId', 'dept_id', 'deptId']));
  const sessionSchool = num(pick(raw, ['school_id', 'schoolId']));

  try {
    let row = null;

    if (staffId) {
      const [r] = await pool.query(`SELECT * FROM staff WHERE id=? LIMIT 1`, [staffId]);
      row = r?.[0] || null;
    } else if (username) {
      const [r] = await pool.query(`SELECT * FROM staff WHERE username=? LIMIT 1`, [username]);
      row = r?.[0] || null;
    } else if (email) {
      const [r] = await pool.query(`SELECT * FROM staff WHERE email=? LIMIT 1`, [email]);
      row = r?.[0] || null;
    }

    const merged = row
      ? {
          ...row,
          role: role || toLower(row.role),
          department_id: row.department_id ?? sessionDept ?? null,
          school_id: row.school_id ?? sessionSchool ?? null,
        }
      : {
          ...raw,
          role,
          department_id: sessionDept || null,
          school_id: sessionSchool || null,
        };

    // keep session updated
    if (s.user) s.user = { ...s.user, ...merged };
    if (s.staff) s.staff = { ...s.staff, ...merged };
    if (s.account) s.account = { ...s.account, ...merged };

    return merged;
  } catch (e) {
    console.error('resolveStaff error:', e);
    return {
      ...raw,
      role,
      department_id: sessionDept || null,
      school_id: sessionSchool || null,
    };
  }
}

function scopeForRole(role) {
  const r = toLower(role);
  if (['admin', 'registry', 'bursary'].includes(r)) return { totals: 'all', regs: 'all' };
  if (r === 'hod') return { totals: 'department', regs: 'department' };
  if (r === 'dean') return { totals: 'school', regs: 'school' };
  if (r === 'lecturer') return { totals: 'department', regs: 'lecturerCourses' };
  return { totals: 'all', regs: 'all' };
}

async function studentProfilesJoinInfo() {
  // we only have student_profiles in your DB list, so we use it for both student/applicant scoping
  const cols = await getCols('student_profiles');
  if (!cols.size) return null;

  const fk =
    cols.has('user_id') ? 'user_id' :
    cols.has('public_user_id') ? 'public_user_id' :
    cols.has('student_id') ? 'student_id' :
    null;

  if (!fk) return null;

  return {
    fk,
    hasDept: cols.has('department_id'),
    hasSchool: cols.has('school_id'),
  };
}

async function countPublicUsers(role, totalsScope, deptId, schoolId) {
  try {
    // IMPORTANT: for ALL scope, do not join student_profiles (otherwise you can accidentally count 0)
    if (totalsScope === 'all') {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM public_users WHERE role=?`, [role]);
      return num(row?.cnt);
    }

    const sp = await studentProfilesJoinInfo();
    if (!sp) {
      // fallback if profiles table not usable
      const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM public_users WHERE role=?`, [role]);
      return num(row?.cnt);
    }

    if (totalsScope === 'department') {
      if (!sp.hasDept || !deptId) return 0;
      const [[row]] = await pool.query(
        `
        SELECT COUNT(DISTINCT pu.id) AS cnt
        FROM public_users pu
        JOIN student_profiles sp ON sp.\`${sp.fk}\` = pu.id
        WHERE pu.role=? AND sp.department_id=?
        `,
        [role, deptId]
      );
      return num(row?.cnt);
    }

    if (totalsScope === 'school') {
      if (!sp.hasSchool || !schoolId) return 0;
      const [[row]] = await pool.query(
        `
        SELECT COUNT(DISTINCT pu.id) AS cnt
        FROM public_users pu
        JOIN student_profiles sp ON sp.\`${sp.fk}\` = pu.id
        WHERE pu.role=? AND sp.school_id=?
        `,
        [role, schoolId]
      );
      return num(row?.cnt);
    }

    // fallback
    const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM public_users WHERE role=?`, [role]);
    return num(row?.cnt);
  } catch (e) {
    console.error('countPublicUsers error:', e);
    return 0;
  }
}

async function countStaff(totalsScope, deptId, schoolId) {
  try {
    const staffCols = await getCols('staff');

    const where = [];
    const params = [];

    if (staffCols.has('status')) where.push(`status='ACTIVE'`);

    if (totalsScope === 'department' && deptId && staffCols.has('department_id')) {
      where.push(`department_id=?`);
      params.push(deptId);
    } else if (totalsScope === 'school' && schoolId && staffCols.has('school_id')) {
      where.push(`school_id=?`);
      params.push(schoolId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[row]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff ${whereSql}`, params);
    return num(row?.cnt);
  } catch (e) {
    console.error('countStaff error:', e);
    return 0;
  }
}

async function getAttendanceRows(totalsScope, deptId, schoolId) {
  try {
    const arCols = await getCols('attendance_records');
    const staffCols = await getCols('staff');

    const statusCol = arCols.has('status') ? 'status' : 'status';
    const timeCol =
      arCols.has('time_in') ? 'time_in' :
      arCols.has('check_in_time') ? 'check_in_time' :
      arCols.has('time') ? 'time' :
      null;

    const where = [];
    const params = [];

    if (totalsScope === 'department' && deptId && staffCols.has('department_id')) {
      where.push(`s.department_id=?`);
      params.push(deptId);
    } else if (totalsScope === 'school' && schoolId && staffCols.has('school_id')) {
      where.push(`s.school_id=?`);
      params.push(schoolId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const timeSelect = timeCol ? `ar.\`${timeCol}\` AS time_val` : `'' AS time_val`;

    const [rows] = await pool.query(
      `
      SELECT
        s.staff_no AS staff_no,
        COALESCE(s.full_name, CONCAT_WS(' ', s.first_name, s.middle_name, s.last_name), s.username) AS name,
        ar.\`${statusCol}\` AS status_val,
        ${timeSelect}
      FROM attendance_records ar
      JOIN staff s ON s.id = ar.staff_id
      ${whereSql}
      ORDER BY ar.id DESC
      LIMIT 5
      `,
      params
    );

    return (rows || []).map(r => ({
      staffId: r.staff_no || '',
      name: r.name || '',
      status: r.status_val || '',
      time: r.time_val || '',
    }));
  } catch (e) {
    console.error('getAttendanceRows error:', e);
    return [];
  }
}

async function getLecturerCourseIds(staffRow) {
  try {
    const exists = await getCols('course_assignments');
    if (!exists.size) return [];

    const caCols = exists;

    const staffKey =
      caCols.has('staff_id') ? 'staff_id' :
      caCols.has('lecturer_id') ? 'lecturer_id' :
      caCols.has('staff_no') ? 'staff_no' :
      caCols.has('username') ? 'username' :
      null;

    const courseKey =
      caCols.has('course_id') ? 'course_id' :
      null;

    if (!staffKey || !courseKey) return [];

    const staffVal =
      staffKey === 'staff_no' ? (staffRow?.staff_no || '') :
      staffKey === 'username' ? (staffRow?.username || '') :
      (staffRow?.id || null);

    if (!staffVal) return [];

    const [rows] = await pool.query(
      `SELECT DISTINCT \`${courseKey}\` AS course_id FROM course_assignments WHERE \`${staffKey}\`=?`,
      [staffVal]
    );
    return (rows || []).map(x => num(x.course_id)).filter(Boolean);
  } catch (e) {
    console.error('getLecturerCourseIds error:', e);
    return [];
  }
}

async function getRecentRegs(regsScope, staffRow, deptId, schoolId) {
  try {
    const regCols = await getCols('student_course_regs');
    const createdCol =
      regCols.has('created_at') ? 'created_at' :
      regCols.has('date_created') ? 'date_created' :
      null;

    const orderBy = createdCol ? `r.\`${createdCol}\` DESC, r.id DESC` : `r.id DESC`;
    const dateSelect = createdCol ? `DATE(r.\`${createdCol}\`) AS reg_date` : `'' AS reg_date`;

    const sp = await studentProfilesJoinInfo();

    const params = [];
    let joinSp = '';
    let where = '';

    if (regsScope === 'department') {
      if (!sp || !sp.hasDept || !deptId) return [];
      joinSp = `JOIN student_profiles sp ON sp.\`${sp.fk}\` = pu.id`;
      where = `WHERE sp.department_id=?`;
      params.push(deptId);
    } else if (regsScope === 'school') {
      if (!sp || !sp.hasSchool || !schoolId) return [];
      joinSp = `JOIN student_profiles sp ON sp.\`${sp.fk}\` = pu.id`;
      where = `WHERE sp.school_id=?`;
      params.push(schoolId);
    } else if (regsScope === 'lecturerCourses') {
      const courseIds = await getLecturerCourseIds(staffRow);
      if (!courseIds.length) return [];
      where = `WHERE r.course_id IN (?)`;
      params.push(courseIds);
    }

    const [rows] = await pool.query(
      `
      SELECT
        r.id,
        pu.matric_number,
        c.code AS course_code,
        ${dateSelect}
      FROM student_course_regs r
      JOIN public_users pu ON pu.id = r.student_id
      JOIN courses c ON c.id = r.course_id
      ${joinSp}
      ${where}
      ORDER BY ${orderBy}
      LIMIT 4
      `,
      params
    );

    return (rows || []).map((r) => ({
      regId: r.id,
      matric: r.matric_number || '',
      course: r.course_code || '',
      date: r.reg_date || '',
    }));
  } catch (e) {
    console.error('getRecentRegs error:', e);
    return [];
  }
}

async function render(req, res) {
  const staffRow = await resolveStaff(req);
  const role = toLower(staffRow?.role);

  const deptId = num(staffRow?.department_id);
  const schoolId = num(staffRow?.school_id);

  const scope = scopeForRole(role);

  const [session, semester] = await Promise.all([
    getCurrentRow('sessions'),
    getCurrentRow('semesters'),
  ]);

  // totals
  const [totalApplicants, totalStudents, totalStaff] = await Promise.all([
    countPublicUsers('applicant', scope.totals, deptId, schoolId),
    countPublicUsers('student', scope.totals, deptId, schoolId),
    countStaff(scope.totals, deptId, schoolId),
  ]);

  // tables
  const [att, regs] = await Promise.all([
    getAttendanceRows(scope.totals, deptId, schoolId),
    getRecentRegs(scope.regs, staffRow, deptId, schoolId),
  ]);

  const recentlyLogin = att.length;
  const onlineCount = att.filter(x => toLower(x.status) === 'online' || toLower(x.status) === 'present').length;
  const onLeaveCount = att.filter(x => toLower(x.status) === 'on-leave' || toLower(x.status) === 'on leave').length;

  /**
   * IMPORTANT: pass BOTH:
   * 1) The direct variables your staff-dashboard.ejs already expects
   * 2) The nested objects (in case other parts use them)
   */
  return res.render('pages/staff-dashboard', {
    title: 'Dashboard',
    pageTitle: 'Dashboard',

    // ✅ original variables used by staff-dashboard.ejs
    sessionName: session?.name || 'N/A',
    semesterName: semester?.name || 'N/A',
    totalApplicants,
    totalStudents,
    totalStaff,
    att,
    regs,
    recentlyLogin,
    onlineCount,
    onLeaveCount,

    // ✅ compatibility extras
    user: staffRow || res.locals.user || null,
    role,
    stats: {
      sessionName: session?.name || 'N/A',
      semesterName: semester?.name || 'N/A',
      totalApplicants,
      totalStudents,
      totalStaff,
    },
    attendance: att,
    recentCourseRegs: regs,
    recentRegistrations: regs,
    attendanceRows: att,
  });
}

/**
 * Export the names your roles.routes.js expects.
 * All point to the same renderer (scoping comes from logged-in staff role).
 */
export const adminDashboard = render;
export const staffDashboard = render;
export const registryDashboard = render;
export const bursaryDashboard = render;
export const hodDashboard = render;
export const deanDashboard = render;
export const lecturerDashboard = render;
export const ictDashboard = render;
export const admissionOfficerDashboard = render;
