import { pool } from "../../core/db.js";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { writeAudit } from "../../services/auditService.js";

const studentPhotoDirectory = path.resolve("app/web/public/uploads/students");

function clean(value) {
  const v = String(value ?? "").trim();
  return v === "" ? null : v;
}

function normalizeEmail(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function buildLike(value) {
  return `%${String(value || "").trim()}%`;
}

export async function showStudentEditPage(_req, res) {
  res.render("students/edit", {
    title: "Edit Student",
    pageTitle: "Edit Student",
    csrfToken: res.locals.csrfToken || "",
  });
}

export async function listStudents(req, res) {
  try {
    const {
      q = '',
      matric = '',
      email = '',
      name = '',
      page = '1',
      pageSize = '10',
    } = req.query;

    const currentPage = Math.max(Number(page) || 1, 1);
    const limit = Math.min(Math.max(Number(pageSize) || 10, 5), 100);
    const offset = (currentPage - 1) * limit;

    const where = [`LOWER(COALESCE(pu.role, '')) = 'student'`];
    const params = [];

    if (q) {
      where.push(`(
        pu.matric_number LIKE ?
        OR pu.username LIKE ?
        OR pu.access_code LIKE ?
        OR CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) LIKE ?
      )`);
      params.push(buildLike(q), buildLike(q), buildLike(q), buildLike(q));
    }

    if (matric) {
      where.push(`pu.matric_number LIKE ?`);
      params.push(buildLike(matric));
    }

    if (email) {
      where.push(`pu.username LIKE ?`);
      params.push(buildLike(email));
    }

    if (name) {
      where.push(`CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) LIKE ?`);
      params.push(buildLike(name));
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [countRows] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM public_users pu
      ${whereSql}
      `,
      params,
    );

    const [items] = await pool.query(
      `
      SELECT
        pu.id,
        pu.first_name,
        pu.middle_name,
        pu.last_name,
        pu.dob,
        pu.state_of_origin,
        pu.lga,
        pu.phone,
        pu.username AS email,
        pu.access_code,
        pu.matric_number,
        pu.status,
        '' AS year_of_entry,
        '' AS school,
        '' AS department,
        '' AS programme,
        '' AS student_level
      FROM public_users pu
      ${whereSql}
      ORDER BY pu.last_name, pu.first_name, pu.id
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    return res.json({
      items,
      total: Number(countRows[0]?.total || 0),
      page: currentPage,
      pageSize: limit,
    });
  } catch (err) {
    console.error('listStudents error:', err);
    return res.status(500).json({ items: [], total: 0, message: 'Failed to load students.' });
  }
}

export async function updateStudent(req, res) {
  const conn = await pool.getConnection();

  try {
    const id = Number(req.params.id);
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid student id." });
    }

    const [existingRows] = await conn.query(
      `
      SELECT id, username, access_code, matric_number
      FROM public_users
      WHERE id = ? AND LOWER(role) = 'student'
      LIMIT 1
      `,
      [id],
    );

    const existing = existingRows[0];
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Student not found." });
    }

    const b = req.body || {};
    const email = normalizeEmail(b.email);

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required." });
    }

    if (!clean(b.firstName) || !clean(b.lastName)) {
      return res.status(400).json({
        success: false,
        message: "First name and last name are required.",
      });
    }

    const [emailRows] = await conn.query(
      `
      SELECT id
      FROM public_users
      WHERE username = ? AND id <> ?
      LIMIT 1
      `,
      [email, id],
    );

    if (emailRows.length) {
      return res.status(400).json({
        success: false,
        message: "Email/username already belongs to another user.",
      });
    }

    await conn.beginTransaction();

    await conn.query(
      `
      UPDATE public_users
      SET
        first_name = ?,
        middle_name = ?,
        last_name = ?,
        dob = COALESCE(?, dob),
        state_of_origin = ?,
        lga = ?,
        phone = ?,
        username = ?,
        access_code = ?,
        status = ?
      WHERE id = ?
      LIMIT 1
      `,
      [
        clean(b.firstName),
        clean(b.middleName),
        clean(b.lastName),
        clean(b.dob),
        clean(b.stateOfOrigin) || "",
        clean(b.lga) || "",
        clean(b.phone) || "",
        email,
        clean(b.accessCode),
        clean(b.status) || "ACTIVE",
        id,
      ],
    );

    await conn.query(
      `
      UPDATE student_imports
      SET
        student_email = ?,
        access_code = COALESCE(?, access_code),
        first_name = ?,
        middle_name = ?,
        last_name = ?,
        year_of_entry = ?,
        school = ?,
        department = ?,
        programme = ?,
        student_level = ?,
        level = ?,
        state_of_origin = ?,
        lga = ?,
        updated_at = NOW()
      WHERE
        (matric_number IS NOT NULL AND matric_number = ?)
        OR (access_code IS NOT NULL AND access_code = ?)
        OR LOWER(student_email) = LOWER(?)
      `,
      [
        email,
        clean(b.accessCode),
        clean(b.firstName),
        clean(b.middleName),
        clean(b.lastName),
        clean(b.yearOfEntry),
        clean(b.school),
        clean(b.department),
        clean(b.programme),
        clean(b.studentLevel),
        clean(b.studentLevel),
        clean(b.stateOfOrigin),
        clean(b.lga),
        existing.matric_number,
        existing.access_code,
        existing.username,
      ],
    );

    await conn.commit();

    return res.json({ success: true, message: "Student record updated." });
  } catch (err) {
    await conn.rollback();
    console.error("updateStudent error:", err);

    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        success: false,
        message: "Duplicate email, access code, or matric number detected.",
      });
    }

    return res
      .status(500)
      .json({ success: false, message: err.message || "Update failed." });
  } finally {
    conn.release();
  }
}

function validImage(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimeType === "image/png") {
    return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return mimeType === "image/jpeg" && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function managedStudentPhoto(filePath) {
  if (!String(filePath || "").startsWith("/uploads/students/")) return null;
  const resolved = path.resolve("app/web/public", String(filePath).replace(/^\//, ""));
  return resolved.startsWith(`${studentPhotoDirectory}${path.sep}`) ? resolved : null;
}

export async function replacePassport(req, res) {
  const studentId = Number(req.params.id);
  const reason = clean(req.body?.reason);
  let newFsPath = null;
  let oldPhotoPath = null;
  const conn = await pool.getConnection();

  try {
    if (!studentId) return res.status(400).json({ success: false, message: "Invalid student id." });
    if (!reason) return res.status(400).json({ success: false, message: "A reason for changing the passport photograph is required." });
    if (!req.file || !validImage(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ success: false, message: "The selected file is not a valid JPG or PNG image." });
    }

    await fs.mkdir(studentPhotoDirectory, { recursive: true });
    const extension = req.file.mimetype === "image/png" ? ".png" : ".jpg";
    const filename = `student-${studentId}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
    newFsPath = path.join(studentPhotoDirectory, filename);
    const newPhotoPath = `/uploads/students/${filename}`;
    await fs.writeFile(newFsPath, req.file.buffer, { flag: "wx" });

    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT pu.id, pu.matric_number, sp.photo_path
       FROM public_users pu
       JOIN student_profiles sp ON sp.user_id = pu.id
       WHERE pu.id = ? AND LOWER(pu.role) = 'student'
       LIMIT 1 FOR UPDATE`,
      [studentId],
    );
    const student = rows[0];
    if (!student) throw new Error("Student profile not found.");
    oldPhotoPath = student.photo_path || null;

    await conn.query("UPDATE student_profiles SET photo_path = ? WHERE user_id = ?", [newPhotoPath, studentId]);
    await conn.query(
      `INSERT INTO student_photos (student_id, photo_type, file_path)
       VALUES (?, 'PROFILE', ?)
       ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), uploaded_at = NOW()`,
      [studentId, newPhotoPath],
    );
    await writeAudit(conn, req, {
      action: "STUDENT_PASSPORT_REPLACED", entityType: "student", entityId: studentId, reason,
      oldValues: { photo_path: oldPhotoPath },
      newValues: { photo_path: newPhotoPath, matric_number: student.matric_number },
    });
    await conn.commit();

    const oldFsPath = managedStudentPhoto(oldPhotoPath);
    if (oldFsPath && oldFsPath !== newFsPath) await fs.unlink(oldFsPath).catch(() => {});
    return res.json({ success: true, message: "Student passport photograph updated successfully.", photoPath: newPhotoPath });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (newFsPath) await fs.unlink(newFsPath).catch(() => {});
    console.error("replaceStudentPassport error:", err);
    return res.status(500).json({ success: false, message: err.message || "Passport update failed." });
  } finally {
    conn.release();
  }
}
