import pool from '../core/db.js';

// Role detector (align with your session)
export function isAdminUser(user) {
  return !!user?.is_admin ||
         String(user?.role || '').toLowerCase() === 'admin' ||
         String(user?.role_name || '').toLowerCase() === 'admin';
}

// For UI filter mapping
export function normalizeStatusFilter(s) {
  const v = String(s || '').toLowerCase();
  if (!v) return '';
  if (v.startsWith('present')) return 'present';
  if (v.includes('leave')) return 'leave';
  if (v.includes('absent')) return 'absent';
  return '';
}

// Lists for dropdowns
export async function listSchools() {
  const [rows] = await pool.query('SELECT id, name FROM schools ORDER BY name ASC');
  return rows;
}
export async function listDepartments(schoolId = null) {
  if (!schoolId) {
    const [rows] = await pool.query('SELECT id, name, school_id FROM departments ORDER BY name ASC');
    return rows;
  }
  const [rows] = await pool.query('SELECT id, name, school_id FROM departments WHERE school_id = ? ORDER BY name ASC', [schoolId]);
  return rows;
}

/**
 * Build WHERE and params for the base query.
 * status: '', 'present', 'leave', 'absent'
 */
function buildWhere({ from, to, schoolId, departmentId, staffId, status }) {
  const where = ['ar.date BETWEEN ? AND ?'];
  const params = [from, to];

  if (schoolId) { where.push('s.school_id = ?'); params.push(schoolId); }
  if (departmentId) { where.push('s.department_id = ?'); params.push(departmentId); }
  if (staffId) { where.push('s.id = ?'); params.push(staffId); }

  if (status === 'present') {
    where.push("ar.status LIKE 'PRESENT%'");
  } else if (status === 'leave') {
    where.push("ar.status = 'ON LEAVE'");
  } else if (status === 'absent') {
    // Only works if you persist ABSENT; if not, this returns 0
    where.push("ar.status = 'ABSENT'");
  }

  return { where: where.join(' AND '), params };
}

/**
 * Query attendance with pagination.
 * Returns { rows, total, totalPages, page, pageSize }
 */
export async function queryAttendance({ from, to, schoolId, departmentId, staffId, status, page = 1, pageSize = 10 }) {
  const limit = Math.max(1, Number(pageSize));
  const offset = Math.max(0, (Number(page) - 1) * limit);

  const { where, params } = buildWhere({ from, to, schoolId, departmentId, staffId, status });

  const sql =
    `SELECT SQL_CALC_FOUND_ROWS
            ar.date, ar.check_in_time, ar.check_out_time, ar.status, ar.leave_reason, ar.marked_by_system,
            s.id AS staff_id, s.staff_no, s.full_name, s.school_id, s.department_id,
            sch.name AS school_name, d.name AS department_name
       FROM attendance_records ar
       JOIN staff s   ON s.id = ar.staff_id
  LEFT JOIN schools sch ON sch.id = s.school_id
  LEFT JOIN departments d ON d.id = s.department_id
      WHERE ${where}
   ORDER BY ar.date DESC, ar.id DESC
      LIMIT ? OFFSET ?`;

  const [rows] = await pool.query(sql, [...params, limit, offset]);
  const [[{ 'FOUND_ROWS()': total }]] = await pool.query('SELECT FOUND_ROWS()');

  return {
    rows,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    page: Number(page),
    pageSize: limit,
  };
}

/**
 * Summary counts for the current filter set (present / leave / absent / matched)
 */
export async function summarizeCounts({ from, to, schoolId, departmentId, staffId, status }) {
  const { where, params } = buildWhere({ from, to, schoolId, departmentId, staffId, status: '' }); // base where without status

  const sqlBase =
    `FROM attendance_records ar
      JOIN staff s ON s.id = ar.staff_id
 LEFT JOIN schools sch ON sch.id = s.school_id
 LEFT JOIN departments d ON d.id = s.department_id
     WHERE ${where}`;

  const [[{ total }]]  = await pool.query(`SELECT COUNT(*) total ${sqlBase}`, params);
  const [[{ present }]] = await pool.query(`SELECT COUNT(*) present ${sqlBase} AND ar.status LIKE 'PRESENT%'`, params);
  const [[{ onleave }]] = await pool.query(`SELECT COUNT(*) onleave ${sqlBase} AND ar.status = 'ON LEAVE'`, params);

  // If you don't store ABSENT rows, this will be zero; we still return it.
  const [[{ absent }]]  = await pool.query(`SELECT COUNT(*) absent ${sqlBase} AND ar.status = 'ABSENT'`, params);

  return {
    total: total || 0,
    present: present || 0,
    onleave: onleave || 0,
    absent: absent || 0,
  };
}
