import pool from '../core/db.js';

// --------- Role / dropdown helpers ----------
export function isAdminUser(user) {
  return !!user?.is_admin ||
         String(user?.role || '').toLowerCase() === 'admin' ||
         String(user?.role_name || '').toLowerCase() === 'admin';
}

export async function listSchools() {
  const [rows] = await pool.query('SELECT id, name FROM schools ORDER BY name ASC');
  return rows;
}

export async function listDepartments(schoolId = null) {
  if (!schoolId) {
    const [rows] = await pool.query('SELECT id, name, school_id FROM departments ORDER BY name ASC');
    return rows;
  }
  const [rows] = await pool.query(
    'SELECT id, name, school_id FROM departments WHERE school_id = ? ORDER BY name ASC',
    [schoolId]
  );
  return rows;
}

// --------- Manual watch list ----------
export async function getWatchlistManual() {
  const [rows] = await pool.query('SELECT * FROM attendance_watchlist');
  // Filter expired on read (you can also purge via cron)
  const today = new Date().toISOString().slice(0, 10);
  const map = new Map();
  rows.forEach(r => {
    if (r.expires_on && r.expires_on < today) return; // expired
    map.set(r.staff_id, r);
  });
  return map;
}

export async function upsertManual({ staff_id, reason, created_by, expires_on }) {
  await pool.query(
    `INSERT INTO attendance_watchlist (staff_id, reason, created_by, expires_on)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       reason = VALUES(reason),
       created_by = VALUES(created_by),
       expires_on = VALUES(expires_on)`,
    [staff_id, reason, created_by, expires_on]
  );
}

export async function removeManualEntry(staff_id) {
  await pool.query('DELETE FROM attendance_watchlist WHERE staff_id = ?', [staff_id]);
}

// --------- Core stats (windowed) ----------
/**
 * Returns staff rows that meet any of the thresholds within [from..to]
 * thresholds: { lateN, veryLateN, absentN, geoFailN }
 */
export async function windowedStats({ from, to, schoolId, departmentId, thresholds }) {
  const { lateN = 3, veryLateN = 2, absentN = 2, geoFailN = 2 } = thresholds || {};
  const where = ['s.status = "ACTIVE"'];
  const params = [];

  if (schoolId) { where.push('s.school_id = ?'); params.push(schoolId); }
  if (departmentId) { where.push('s.department_id = ?'); params.push(departmentId); }

  // NOTE: Corrected "late_cnt" expression (no AND inside SUM result)
  const sql = `
SELECT
  s.id AS staff_id, s.staff_no, s.full_name, s.school_id, s.department_id,
  sch.name AS school_name, d.name AS department_name,
  SUM(CASE
        WHEN (ar.status LIKE 'PRESENT/Slightly Late' OR ar.status = 'PRESENT/Very Late')
        THEN 1 ELSE 0
      END) AS late_cnt,
  SUM(CASE WHEN ar.status = 'PRESENT/Very Late' THEN 1 ELSE 0 END) AS very_late_cnt,
  SUM(CASE WHEN ar.status = 'ON LEAVE' THEN 1 ELSE 0 END) AS leave_cnt,
  SUM(CASE WHEN ar.status = 'ABSENT'   THEN 1 ELSE 0 END) AS absent_cnt,
  SUM(CASE
        WHEN ar.status LIKE 'PRESENT%' AND (ar.latitude IS NULL OR ar.longitude IS NULL)
        THEN 1 ELSE 0
      END) AS geo_fail_cnt,
  MAX(CONCAT(ar.date, ' ', COALESCE(ar.check_in_time, '00:00:00'))) AS last_seen
FROM staff s
LEFT JOIN attendance_records ar
       ON ar.staff_id = s.id
      AND ar.date BETWEEN ? AND ?
LEFT JOIN schools sch     ON sch.id = s.school_id
LEFT JOIN departments d   ON d.id = s.department_id
WHERE ${where.join(' AND ')}
GROUP BY s.id
HAVING (late_cnt      >= ?)
    OR (absent_cnt    >= ?)
    OR (very_late_cnt >= ?)
    OR (geo_fail_cnt  >= ?)
ORDER BY very_late_cnt DESC, late_cnt DESC, geo_fail_cnt DESC, absent_cnt DESC, last_seen DESC
LIMIT 5000
`;

  const [rows] = await pool.query(sql, [from, to, ...params, lateN, absentN, veryLateN, geoFailN]);
  return { rows };
}

// --------- History for a staff ----------
export async function getStaffHistory(staffId, from, to) {
  const [rows] = await pool.query(
    `SELECT ar.date, ar.check_in_time, ar.check_out_time, ar.status, ar.leave_reason, ar.marked_by_system
       FROM attendance_records ar
      WHERE ar.staff_id = ?
        AND ar.date BETWEEN ? AND ?
      ORDER BY ar.date DESC, ar.id DESC
      LIMIT 200`,
    [staffId, from, to]
  );
  return rows;
}
