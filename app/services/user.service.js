// app/services/user.service.js
//
// All user-focused DB operations (new, clean schema).
// - No legacy columns.
// - Roles from roles.name via user_roles.

import { pool } from '../core/db.js';
import bcrypt from 'bcryptjs';

/** Map a DB row to UI shape */
function hydrateUserRow(row) {
  const roles = (row.roles_csv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const priority = [
    'superadmin','administrator','admin','staff','hod','lecturer','dean','ict','bursary','registry',
    'admission officer','auditor','health center','works','library','provost','student union','student','applicant'
  ];
  const primary = roles.find(r => priority.includes(r.toLowerCase())) || roles[0] || 'staff';

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    staffNumber: row.staff_no,
    school: row.school,
    department: row.department,
    status: row.status || 'ACTIVE',
    role: primary,
    roles
  };
}

/** Find user by username */
export async function findByUsername(username) {
  const [rows] = await pool.query(
    `
    SELECT s.*,
           sc.name AS school,
           d.name  AS department,
           (SELECT GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ',')
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = s.id) AS roles_csv
      FROM staff s
      LEFT JOIN schools sc ON sc.id = s.school_id
      LEFT JOIN departments d ON d.id = s.department_id
     WHERE TRIM(LOWER(s.username)) = TRIM(LOWER(?))
     LIMIT 1
    `,
    [username]
  );
  if (!rows.length) return null;
  const u = hydrateUserRow(rows[0]);
  return { ...u, password_hash: rows[0].password_hash };
}

/** Auth */
export async function authenticate(username, password) {
  const u = await findByUsername(username);
  if (!u || !u.password_hash) return null;
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

/** Ensure a default admin exists */
export async function ensureAdminUser() {
  const ADMIN_USERNAME = 'admin';
  const ADMIN_EMAIL    = 'admin@example.com';
  const ADMIN_NAME     = 'Portal Administrator';
  const DEFAULT_PASS   = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO roles(name) VALUES ('admin'),('staff')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`
    );
    const [[rAdmin]] = await conn.query(`SELECT id FROM roles WHERE name='admin' LIMIT 1`);
    const [[rStaff]] = await conn.query(`SELECT id FROM roles WHERE name='staff' LIMIT 1`);

    await conn.query(
      `INSERT INTO schools(name) VALUES ('Main School')
       ON DUPLICATE KEY UPDATE name=VALUES(name)`
    );
    const [[school]] = await conn.query(`SELECT id FROM schools WHERE name='Main School' LIMIT 1`);

    await conn.query(
      `INSERT INTO departments (school_id, name)
       SELECT ?, 'Environmental Health Assistance'
         FROM DUAL
        WHERE NOT EXISTS (
              SELECT 1 FROM departments
               WHERE school_id=? AND name='Environmental Health Assistance'
        )`,
      [school.id, school.id]
    );
    const [[dept]] = await conn.query(
      `SELECT id FROM departments WHERE school_id=? AND name='Environmental Health Assistance' LIMIT 1`,
      [school.id]
    );

    const [[exists]] = await conn.query(
      `SELECT id FROM staff WHERE username=? LIMIT 1`,
      [ADMIN_USERNAME]
    );

    let userId = exists?.id;
    if (!userId) {
      const hash = await bcrypt.hash(DEFAULT_PASS, 10);
      const [res] = await conn.query(
        `INSERT INTO staff
           (staff_no, full_name, username, email, password_hash, status, school_id, department_id)
         VALUES ('ADMIN', ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [ADMIN_NAME, ADMIN_USERNAME, ADMIN_EMAIL, hash, school.id, dept.id]
      );
      userId = res.insertId;
    }

    if (userId && rAdmin?.id) {
      await conn.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES(?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), role_id=VALUES(role_id)`,
        [userId, rAdmin.id]
      );
    }
    if (userId && rStaff?.id) {
      await conn.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES(?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), role_id=VALUES(role_id)`,
        [userId, rStaff.id]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Create user (minimal) */
export async function createUser(payload = {}) {
  const {
    fullName, username, email,
    staffNumber, school, department,
    highestQualification, // kept for future
    password = 'College1',
    role
  } = payload;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let school_id = null, department_id = null;

    if (school) {
      await conn.query(
        `INSERT INTO schools(name) VALUES (?)
         ON DUPLICATE KEY UPDATE name=VALUES(name)`,
        [String(school).trim()]
      );
      const [[s]] = await conn.query(`SELECT id FROM schools WHERE name=? LIMIT 1`, [String(school).trim()]);
      school_id = s?.id || null;
    }

    if (department) {
      await conn.query(
        `INSERT INTO departments(school_id, name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name)`,
        [school_id, String(department).trim()]
      );
      const [[d]] = await conn.query(
        `SELECT id FROM departments WHERE name=? ${school_id ? 'AND school_id=?' : ''} LIMIT 1`,
        school_id ? [String(department).trim(), school_id] : [String(department).trim()]
      );
      department_id = d?.id || null;
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [res] = await conn.query(
      `INSERT INTO staff (staff_no, full_name, username, email, password_hash, status, school_id, department_id)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [staffNumber || null, fullName, username || null, email || null, password_hash, school_id, department_id]
    );

    const userId = res.insertId;

    await conn.query(
      `INSERT INTO roles(name) VALUES ('staff')
       ON DUPLICATE KEY UPDATE name=VALUES(name)`
    );
    const [[rStaff]] = await conn.query(`SELECT id FROM roles WHERE name='staff' LIMIT 1`);
    if (rStaff?.id) {
      await conn.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES (?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), role_id=VALUES(role_id)`,
        [userId, rStaff.id]
      );
    }

    if (role) {
      await conn.query(
        `INSERT INTO roles(name) VALUES (?)
         ON DUPLICATE KEY UPDATE name=VALUES(name)`,
        [String(role).trim().toLowerCase()]
      );
      const [[r]] = await conn.query(`SELECT id FROM roles WHERE name=? LIMIT 1`, [String(role).trim().toLowerCase()]);
      if (r?.id) {
        await conn.query(
          `INSERT INTO user_roles(user_id, role_id) VALUES (?,?)
           ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), role_id=VALUES(role_id)`,
          [userId, r.id]
        );
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Update basic staff fields */
export async function updateUser(id, patch = {}) {
  const fields = [];
  const params = [];

  const map = {
    full_name: 'full_name',
    email: 'email',
    username: 'username',
    staff_no: 'staff_no',
    status: 'status'
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { fields.push(`${col}=?`); params.push(patch[k]); }
  }
  if (!fields.length) return;
  params.push(Number(id));

  await pool.query(`UPDATE staff SET ${fields.join(', ')} WHERE id=?`, params);
}

/** Delete a staff user (and links) */
export async function deleteUser(id) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM user_roles WHERE user_id=?`, [id]);
    await conn.query(`DELETE FROM staff WHERE id=?`, [id]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Reset password */
export async function resetPassword(username, newPassword = 'College1') {
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE staff SET password_hash=? WHERE username=?`, [hash, username]);
}

/** Assign roles (replace), resolved by username (safe & unambiguous) */
export async function setRoles({ username, roles = [] }) {
  const uname = String(username || '').trim();
  if (!uname) throw new Error('username is required');

  const cleanRoles = Array.from(new Set(
    (Array.isArray(roles) ? roles : [])
      .map(r => String(r || '').trim().toLowerCase())
      .filter(Boolean)
  ));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[u]] = await conn.query(
      `SELECT id FROM staff WHERE TRIM(LOWER(username))=TRIM(LOWER(?)) LIMIT 1`,
      [uname]
    );
    if (!u?.id) throw new Error('User not found');
    const uid = Number(u.id);

    // Ensure roles exist
    const roleIds = [];
    for (const r of cleanRoles) {
      await conn.query(
        `INSERT INTO roles(name) VALUES (?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [r]
      );
      const [[row]] = await conn.query(`SELECT id FROM roles WHERE name=? LIMIT 1`, [r]);
      if (row?.id) roleIds.push(row.id);
    }

    // Replace links
    await conn.query(`DELETE FROM user_roles WHERE user_id=?`, [uid]);
    for (const rid of roleIds) {
      await conn.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES (?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), role_id=VALUES(role_id)`,
        [uid, rid]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Search + paginate */
export async function searchUsers(opts = {}) {
  const {
    role = '',
    q = '',
    department = '',
    school = '',
    email = '',
    name = '',
    username = '',
    staffNumber = '',
    page = 1,
    pageSize = 10
  } = opts;

  const where = [];
  const params = [];

  if (role) {
    where.push(`
      EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = s.id AND r.name = ?
      )
    `);
    params.push(String(role).toLowerCase());
  }
  if (q) {
    const like = `%${q}%`;
    where.push(`(
      LOWER(s.full_name) LIKE LOWER(?) OR
      LOWER(s.username)  LIKE LOWER(?) OR
      LOWER(s.email)     LIKE LOWER(?) OR
      LOWER(sc.name)     LIKE LOWER(?) OR
      LOWER(d.name)      LIKE LOWER(?)
    )`);
    params.push(like, like, like, like, like);
  }
  if (department) { where.push(`LOWER(d.name) LIKE LOWER(?)`); params.push(`%${department}%`); }
  if (school)     { where.push(`LOWER(sc.name) LIKE LOWER(?)`); params.push(`%${school}%`); }
  if (email)      { where.push(`LOWER(s.email) LIKE LOWER(?)`); params.push(`%${email}%`); }
  if (name)       { where.push(`LOWER(s.full_name) LIKE LOWER(?)`); params.push(`%${name}%`); }
  if (username)   { where.push(`LOWER(s.username) LIKE LOWER(?)`); params.push(`%${username}%`); }
  if (staffNumber){ where.push(`LOWER(s.staff_no) LIKE LOWER(?)`); params.push(`%${staffNumber}%`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit  = Math.max(1, parseInt(pageSize, 10) || 10);
  const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit);

  const [[{ total }]] = await pool.query(
    `
    SELECT COUNT(*) AS total
      FROM staff s
      LEFT JOIN schools sc ON sc.id = s.school_id
      LEFT JOIN departments d ON d.id = s.department_id
     ${whereSql}
    `,
    params
  );

  const [rows] = await pool.query(
    `
    SELECT s.id, s.username, s.full_name, s.email, s.staff_no, s.status,
           sc.name AS school,
           d.name  AS department,
           (SELECT GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ',')
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = s.id) AS roles_csv
      FROM staff s
      LEFT JOIN schools sc ON sc.id = s.school_id
      LEFT JOIN departments d ON d.id = s.department_id
     ${whereSql}
     ORDER BY s.full_name ASC
     LIMIT ? OFFSET ?
    `,
    [...params, limit, offset]
  );

  const items = rows.map(hydrateUserRow);
  return { items, total };
}
