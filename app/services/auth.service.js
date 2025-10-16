
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../core/db.js';

function sha1Hex(s=''){ return crypto.createHash('sha1').update(s, 'utf8').digest('hex'); }

export async function findStudentByCredentials(username, password){
  // Try students table by matricNumber or studentEmail
  const [rows] = await pool.query(
    `SELECT ID, matricNumber, firstName, lastName, adminKey, passKey
     FROM students
     WHERE TRIM(LOWER(matricNumber)) = TRIM(LOWER(?))
        OR TRIM(LOWER(studentEmail)) = TRIM(LOWER(?))
     LIMIT 1`, [username, username]);
  if (!rows.length) return null;
  const s = rows[0];
  // Accept either SHA1(adminKey) or plaintext passKey (as present in dump)
  const ok =
    (s.adminKey && s.adminKey.length===40 && s.adminKey === sha1Hex(password)) ||
    (s.passKey && s.passKey === password);
  if (!ok) return null;
  return { id: s.ID, matricNumber: s.matricNumber, role: 'student', permissions: [] };
}

export async function findStaffByCredentials(username, password){
  // Try Staffs table by StaffCode or Email
  const [rows] = await pool.query(
    `SELECT ID, StaffCode, Email, password
     FROM Staffs
     WHERE TRIM(LOWER(StaffCode)) = TRIM(LOWER(?))
        OR TRIM(LOWER(Email)) = TRIM(LOWER(?))
     LIMIT 1`, [username, username]);
  if (!rows.length) return null;
  const st = rows[0];
  const ok = (st.password && st.password.length===40 && st.password === sha1Hex(password));
  if (!ok) return null;
  return { id: st.ID, staffCode: st.StaffCode, role: 'staff',
    permissions: ['transcripts.generate','transcripts.view','transcripts.send','results.view','records.view','results.compute'] };
}
