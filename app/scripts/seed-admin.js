// app/scripts/seed-admin.js
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

// ----- DB config (use .env if present) -----
const isProd  = process.env.NODE_ENV === 'production';
const DB_NAME = process.env.DB_NAME || (isProd ? 'newportalroot_ijero_node' : 'ijero_node');
const DB_USER = process.env.DB_USER || (isProd ? 'newportalroot_ijero_node' : 'root');
const DB_PASS = process.env.DB_PASSWORD || '';
const DB_HOST = process.env.DB_HOST || 'localhost';

// ----- Admin credentials -----
const ADMIN_USERNAME = 'admin';
const ADMIN_EMAIL    = 'admin@example.com';
const ADMIN_PASSWORD = 'ChangeMe123!';

(async () => {
  const conn = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
  });

  // 1) Ensure the admin user exists
  const [existing] = await conn.execute(
    'SELECT id FROM staff WHERE username = ? LIMIT 1',
    [ADMIN_USERNAME]
  );

  let userId;
  if (existing.length) {
    userId = existing[0].id;
    console.log('✔ Admin user already exists (id=%s)', userId);
  } else {
    // Find any baseline school/department (optional)
    const [[school]] = await conn.query(
      'SELECT id FROM schools WHERE name = ? LIMIT 1',
      ['Main School']
    );
    const [[dept]] = await conn.query(
      `SELECT d.id
         FROM departments d
         JOIN schools s ON s.id = d.school_id
        WHERE d.name = ? LIMIT 1`,
      ['Environmental Health Assistance']
    );

    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    const [res] = await conn.execute(
      `INSERT INTO staff
         (staff_no, full_name, username, email, password_hash, status, school_id, department_id)
       VALUES
         ('ADMIN','Portal Administrator', ?, ?, ?, 'ACTIVE', ?, ?)`,
      [ADMIN_USERNAME, ADMIN_EMAIL, password_hash, school?.id || null, dept?.id || null]
    );
    userId = res.insertId;
    console.log('✔ Admin user created (id=%s)', userId);
  }

  // 2) Attach roles by NAME (no more legacy "slug")
  const needRoles = ['admin', 'staff'];
  for (const roleName of needRoles) {
    const [[role]] = await conn.query('SELECT id FROM roles WHERE name = ? LIMIT 1', [roleName]);
    if (!role?.id) {
      console.log(`• Role "${roleName}" not found; creating it`);
      const [r] = await conn.execute('INSERT INTO roles(name) VALUES(?)', [roleName]);
      role && (role.id = r.insertId);
    }

    // user_roles schema: (user_id, role_id) UNIQUE
    await conn.execute(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES(?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), role_id = VALUES(role_id)`,
      [userId, role.id]
    );
  }

  console.log('✔ Admin seeding complete');
  await conn.end();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
