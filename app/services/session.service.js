// app/services/session.service.js
import { pool } from "../core/db.js";

/** Ensure sessions exist from 2010/2011 to 2030/2031 */
export async function ensureSessions() {
  const start = 2010, end = 2030;
  const values = [];
  for (let y = start; y <= end; y++) {
    const name = `${y}/${y + 1}`;
    values.push([name]);
  }
  await pool.query(
    "INSERT IGNORE INTO sessions (name) VALUES " +
      values.map(() => "(?)").join(","),
    values
  );
  // ensure exactly one current
  const [cur] = await pool.query("SELECT id FROM sessions WHERE is_current=1 LIMIT 1");
  if (!cur.length) {
    await pool.query("UPDATE sessions SET is_current=0");
    await pool.query("UPDATE sessions SET is_current=1 WHERE name=?", [`${end}/${end+1}`]);
  }
}

export async function getAll() {
  await ensureSessions();
  const [list] = await pool.query(
    "SELECT id, name, is_current FROM sessions ORDER BY name ASC"
  );
  const [cur] = await pool.query(
    "SELECT id, name FROM sessions WHERE is_current=1 LIMIT 1"
  );
  return { list, current: cur[0] || null };
}

export async function getCurrent() {
  await ensureSessions();
  const [rows] = await pool.query("SELECT * FROM sessions WHERE is_current=1 LIMIT 1");
  return rows[0] || null;
}

export async function setCurrent(sessionName) {
  const name = String(sessionName || '').trim();
  if (!name) throw new Error('Session name required');
  await ensureSessions();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE sessions SET is_current=0");
    await conn.query("UPDATE sessions SET is_current=1 WHERE name=?", [name]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
