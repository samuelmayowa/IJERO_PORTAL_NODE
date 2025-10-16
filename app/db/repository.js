// app/db/repository.js
import { pool } from '../core/db.js';

// --- Schools / Departments ---
export async function listSchools() {
  const [rows] = await pool.query(
    'SELECT id, name FROM schools WHERE is_active=1 ORDER BY name'
  );
  return rows;
}

export async function listDepartmentsBySchool(schoolId) {
  const [rows] = await pool.query(
    'SELECT id, name FROM departments WHERE school_id=? AND is_active=1 ORDER BY name',
    [Number(schoolId)]
  );
  return rows;
}

// --- Office Locations (attendance) ---
export async function listOfficeLocations({ limit = 50, offset = 0 } = {}) {
  const [rows] = await pool.query(
    `SELECT ol.id, sc.name AS school, d.name AS department, ol.latitude, ol.longitude
     FROM office_locations ol
     INNER JOIN schools sc ON sc.id=ol.school_id
     INNER JOIN departments d ON d.id=ol.department_id
     ORDER BY sc.name, d.name
     LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
  );
  return rows;
}

export async function upsertOfficeLocation({ school_id, department_id, latitude, longitude, created_by = null }) {
  const [existing] = await pool.query(
    'SELECT id FROM office_locations WHERE school_id=? AND department_id=?',
    [Number(school_id), Number(department_id)]
  );
  if (existing.length) {
    await pool.query(
      'UPDATE office_locations SET latitude=?, longitude=? WHERE id=?',
      [Number(latitude), Number(longitude), existing[0].id]
    );
    return existing[0].id;
  }
  const [res] = await pool.query(
    'INSERT INTO office_locations (school_id, department_id, latitude, longitude, created_by) VALUES (?,?,?,?,?)',
    [Number(school_id), Number(department_id), Number(latitude), Number(longitude), created_by]
  );
  return res.insertId;
}

export async function deleteOfficeLocation(id) {
  await pool.query('DELETE FROM office_locations WHERE id=?', [Number(id)]);
}
