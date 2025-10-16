// app/services/semester.service.js
import { pool } from "../core/db.js";

export async function ensureSemesters() {
  await pool.query(
    `INSERT IGNORE INTO semesters (name) VALUES
     ('First'), ('Second'), ('Summer / Carry Over')`
  );
  const [cur] = await pool.query("SELECT id FROM semesters WHERE is_current=1 LIMIT 1");
  if (!cur.length) {
    await pool.query("UPDATE semesters SET is_current=0");
    await pool.query("UPDATE semesters SET is_current=1 WHERE name='First'");
  }
}

export async function getCurrentSemester() {
  await ensureSemesters();
  const [rows] = await pool.query("SELECT * FROM semesters WHERE is_current=1 LIMIT 1");
  return rows[0] || null;
}

export async function setCurrentSemester(name) {
  const semester = String(name || "").trim();
  if (!semester) throw new Error("Semester name required");
  await ensureSemesters();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE semesters SET is_current=0");
    await conn.query("UPDATE semesters SET is_current=1 WHERE name=?", [semester]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
