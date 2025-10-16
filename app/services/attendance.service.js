// app/services/attendance.service.js
//
// Attendance / Office Location data-access
// - Uses new schema tables: schools(id,name), departments(id, school_id, name)
// - office_locations table is created if missing
// - All queries are parameterized
// - Includes "ensureDepartment" so new department names can be typed and created

import { pool } from '../core/db.js';

// Ensure storage table exists
async function ensureTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS office_locations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      department_id INT NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      UNIQUE KEY uk_school_dept (school_id, department_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(sql);
}

// ---------- Lookups ----------
export async function getSchools() {
  const [rows] = await pool.query(`SELECT id, name FROM schools ORDER BY name`);
  return rows;
}

export async function getDepartmentsBySchool(schoolId) {
  const [rows] = await pool.query(
    `SELECT id, name FROM departments WHERE school_id = ? ORDER BY name`,
    [schoolId]
  );
  return rows;
}

/**
 * Ensure a department exists for a school; returns its id.
 * Creates the department if not found.
 */
export async function ensureDepartment(schoolId, deptName) {
  const name = String(deptName || '').trim();
  if (!name) return null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert by (school_id, name)
    await conn.query(
      `INSERT INTO departments (school_id, name)
       SELECT ?, ?
       FROM DUAL
       WHERE NOT EXISTS (
         SELECT 1 FROM departments WHERE school_id = ? AND name = ?
       )`,
      [schoolId, name, schoolId, name]
    );

    const [[row]] = await conn.query(
      `SELECT id FROM departments WHERE school_id = ? AND name = ? LIMIT 1`,
      [schoolId, name]
    );

    await conn.commit();
    return row?.id || null;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------- Office locations ----------
export async function getOfficeLocation(schoolId, departmentId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT latitude, longitude
     FROM office_locations
     WHERE school_id = ? AND department_id = ?
     LIMIT 1`,
    [schoolId, departmentId]
  );
  return rows[0] || null;
}

/**
 * Insert or update an office location (supports camelCase or snake_case inputs).
 * Returns the affected row id.
 */
export async function upsertOfficeLocation(payload) {
  await ensureTable();

  // Accept both naming styles
  const schoolId     = payload.schoolId     ?? payload.school_id;
  const departmentId = payload.departmentId ?? payload.department_id;
  const latitude     = payload.latitude;
  const longitude    = payload.longitude;

  const sql = `
    INSERT INTO office_locations (school_id, department_id, latitude, longitude)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      latitude = VALUES(latitude),
      longitude = VALUES(longitude)
  `;
  const [res] = await pool.query(sql, [schoolId, departmentId, latitude, longitude]);
  return res.insertId || null;
}

/** List office locations (simple paging) */
export async function getAllOfficeLocations({ offset = 0, limit = 10 } = {}) {
  await ensureTable();

  const [rows] = await pool.query(
    `
    SELECT 
      ol.id,
      s.name AS school_name,
      d.name AS department_name,
      ol.latitude, ol.longitude
    FROM office_locations ol
    LEFT JOIN schools s ON s.id = ol.school_id
    LEFT JOIN departments d ON d.id = ol.department_id
    ORDER BY s.name, d.name
    LIMIT ? OFFSET ?
    `,
    [limit, offset]
  );

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM office_locations`);
  return { rows, total };
}
