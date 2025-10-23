import crypto from 'crypto';
import { pool } from '../core/db.js'; // keep named import to match your current db.js

const sha1Hex = (s = '') =>
  crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

/**
 * Authenticate staff by email OR username + password.
 * - First try SHA1(password) (new rows)
 * - Then try plaintext (legacy rows)
 * - Only allow status = 'ACTIVE'
 *
 * Returns a compact user object or null.
 */
export async function authenticate(id, password) {
  const hashedPassword = sha1Hex(password || '');

  // 1) Try SHA1 match (ACTIVE only)
  let [rows] = await pool.query(
    `SELECT *
       FROM staff
      WHERE (email = ? OR username = ?)
        AND password = ?
        AND status = 'ACTIVE'
      LIMIT 1`,
    [id, id, hashedPassword]
  );

  // 2) Fallback: plaintext (ACTIVE only) for legacy data
  if (!rows.length) {
    [rows] = await pool.query(
      `SELECT *
         FROM staff
        WHERE (email = ? OR username = ?)
          AND password = ?
          AND status = 'ACTIVE'
        LIMIT 1`,
      [id, id, password]
    );
  }

  if (!rows.length) return null;

  const u = rows[0];
  const roleRaw = String(u.role || u.role_name || '').toLowerCase();

  return {
    id: u.id,
    email: u.email,
    username: u.username,
    staff_no: u.staff_no,
    school_id: u.school_id,
    department_id: u.department_id,
    status: u.status,
    role: u.role || u.role_name || 'staff',
    is_admin: !!u.is_admin || roleRaw === 'admin' || roleRaw === 'administrator',
  };
}

/**
 * Ensure there is at least one admin account so you can't lock yourself out.
 * - Username: admin
 * - Email: admin@example.com
 * - Password: College1 (SHA1 stored)
 * - status: ACTIVE
 */
export async function ensureAdminUser() {
  try {
    const [exists] = await pool.query(
      `SELECT id FROM staff
        WHERE (username='admin' OR email='admin@example.com')
        LIMIT 1`
    );
    if (exists.length) return { created: false };

    const pwd = 'College1';
    const hash = sha1Hex(pwd);

    await pool.query(
      `INSERT INTO staff
        (username, email, password, status, is_admin, full_name, staff_no, school_id, department_id)
       VALUES
        ('admin', 'admin@example.com', ?, 'ACTIVE', 1, 'Portal Administrator', 'ADMIN', NULL, NULL)`
      ,
      [hash]
    );

    return { created: true };
  } catch (e) {
    // Don’t crash server on startup if ensure step fails; just log.
    console.error('ensureAdminUser error:', e);
    return { created: false, error: e?.message };
  }
}
