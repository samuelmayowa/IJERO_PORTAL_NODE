import pool from '../core/db.js'; // from app/services -> app/core/db.js

// 1 mile ≈ 1609.34 m; allow env override if you need to tweak
// export const CHECKIN_RADIUS_METERS = Number(process.env.ATTENDANCE_RADIUS_METERS || 1609.34);
export const CHECKIN_RADIUS_METERS = Number(process.env.ATTENDANCE_RADIUS_METERS || 160.934);

// --- utils ---
function distanceMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null || v === '')) return Infinity;
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ===== basic queries =====
export async function getStaffById(id) {
  const [r] = await pool.query('SELECT * FROM staff WHERE id = ?', [id]);
  return r[0] || null;
}

export async function getOfficeLocationForDept(deptId) {
  const [r] = await pool.query(
    'SELECT * FROM office_locations WHERE department_id = ? ORDER BY id DESC LIMIT 1',
    [deptId]
  );
  return r[0] || null;
}

/**
 * Get today's record for a staff. Uses MySQL CURDATE() to avoid timezone drift.
 * If dateStr is provided, uses it instead.
 */
export async function getTodayRecord(staffId, dateStr) {
  if (dateStr) {
    const [r] = await pool.query(
      'SELECT * FROM attendance_records WHERE staff_id = ? AND date = ?',
      [staffId, dateStr]
    );
    return r[0] || null;
  }
  const [r] = await pool.query(
    'SELECT * FROM attendance_records WHERE staff_id = ? AND date = CURDATE()',
    [staffId]
  );
  return r[0] || null;
}

// paginated list of recent records
export async function getRecentRecords(staffId, page = 1, pageSize = 10) {
  const limit = Math.max(1, Number(pageSize));
  const offset = Math.max(0, (Number(page) - 1) * limit);

  const [rows] = await pool.query(
    `SELECT SQL_CALC_FOUND_ROWS *
       FROM attendance_records
      WHERE staff_id = ?
      ORDER BY date DESC, id DESC
      LIMIT ? OFFSET ?`,
    [staffId, limit, offset]
  );
  const [[{ 'FOUND_ROWS()': total }]] = await pool.query('SELECT FOUND_ROWS()');
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { rows, total, totalPages, page: Number(page), pageSize: limit };
}

// ===== write ops =====
export async function insertCheckIn({
  staff_id, school_id, department_id,
  latitude, longitude, status, leave_reason
}) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toTimeString().slice(0, 8);

  // Coerce '' -> null; numbers -> Number
  const lat =
    latitude === '' || latitude === undefined || latitude === null
      ? null
      : Number(latitude);
  const lng =
    longitude === '' || longitude === undefined || longitude === null
      ? null
      : Number(longitude);

  await pool.query(
    `INSERT INTO attendance_records
      (staff_id, school_id, department_id, date, check_in_time, status, leave_reason, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      staff_id,
      school_id,
      department_id,
      today,
      now,
      status || null,
      leave_reason || null,
      lat,
      lng
    ]
  );
}

export async function updateCheckout(staff_id) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toTimeString().slice(0, 8);
  const [rows] = await pool.query(
    'SELECT id FROM attendance_records WHERE staff_id = ? AND date = ?',
    [staff_id, today]
  );
  if (!rows.length) return { ok: false, msg: 'No attendance found for today.' };
  await pool.query(
    'UPDATE attendance_records SET check_out_time = ?, marked_by_system = 0 WHERE id = ?',
    [now, rows[0].id]
  );
  return { ok: true };
}

// ===== business rules =====
export async function canCheckInAtLocation({ staff, userLat, userLng }) {
  const office = await getOfficeLocationForDept(staff.department_id);
  if (!office) {
    return {
      ok: false,
      msg: 'Office location not set for your department. Please contact ICT to configure your department coordinates.'
    };
  }

  const d = distanceMeters(
    Number(userLat), Number(userLng),
    Number(office.latitude), Number(office.longitude)
  );

  if (d <= CHECKIN_RADIUS_METERS) return { ok: true, office };

  const miles = (d / 1609.34).toFixed(2);
  const allowed = (CHECKIN_RADIUS_METERS / 1609.34).toFixed(2);
  return {
    ok: false,
    msg: `You are too far from your office (~${miles} mi away). Check-in requires being within ~${allowed} mi (~${Math.round(CHECKIN_RADIUS_METERS)} m).`,
    office
  };
}

export function classifyStatusByTime(now = new Date(), leaveReason = '') {
  if (leaveReason) return 'ON LEAVE';
  const totalMin = now.getHours() * 60 + now.getMinutes();
  if (totalMin <= 8 * 60) return 'PRESENT/On-Time';
  if (totalMin <= 10 * 60) return 'PRESENT/Slightly Late';
  return 'PRESENT/Very Late';
}

// ===== top counts for today (present/leave/absent) =====
// If user is admin => global counts; else filter by user's school/department.
export async function getTodayCountsFiltered(user) {
  const isAdmin =
    !!user?.is_admin ||
    String(user?.role || '').toLowerCase() === 'admin' ||
    String(user?.role_name || '').toLowerCase() === 'admin';

  let presentCount = 0, leaveCount = 0, totalActive = 0;

  if (isAdmin) {
    const [[{ p }]] = await pool.query(
      "SELECT COUNT(*) AS p FROM attendance_records WHERE date = CURDATE() AND status LIKE 'PRESENT%'"
    );
    const [[{ l }]] = await pool.query(
      "SELECT COUNT(*) AS l FROM attendance_records WHERE date = CURDATE() AND status = 'ON LEAVE'"
    );
    const [[{ ta }]] = await pool.query(
      "SELECT COUNT(*) AS ta FROM staff WHERE status='ACTIVE'"
    );
    presentCount = p || 0; leaveCount = l || 0; totalActive = ta || 0;
  } else {
    // filter by the logged-in user's school & department
    const sid = Number(user?.school_id || 0);
    const did = Number(user?.department_id || 0);

    const [[{ p }]] = await pool.query(
      "SELECT COUNT(*) AS p FROM attendance_records WHERE date = CURDATE() AND status LIKE 'PRESENT%' AND school_id = ? AND department_id = ?",
      [sid, did]
    );
    const [[{ l }]] = await pool.query(
      "SELECT COUNT(*) AS l FROM attendance_records WHERE date = CURDATE() AND status = 'ON LEAVE' AND school_id = ? AND department_id = ?",
      [sid, did]
    );
    const [[{ ta }]] = await pool.query(
      "SELECT COUNT(*) AS ta FROM staff WHERE status='ACTIVE' AND school_id = ? AND department_id = ?",
      [sid, did]
    );
    presentCount = p || 0; leaveCount = l || 0; totalActive = ta || 0;
  }

  const absentCount = Math.max(0, totalActive - presentCount - leaveCount);
  return { presentCount, leaveCount, absentCount, isAdmin };
}
