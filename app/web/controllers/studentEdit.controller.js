import { pool } from '../../core/db.js';

function clean(value) {
  const v = String(value ?? '').trim();
  return v === '' ? null : v;
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function buildLike(value) {
  return `%${String(value || '').trim()}%`;
}

export async function showStudentEditPage(_req, res) {
  res.render('students/edit', {
    title: 'Edit Student',
    pageTitle: 'Edit Student',
    csrfToken: res.locals.csrfToken || '',
  });
}

export async function listStudents(req, res) {
  try {
    const {
      q = '',
      matric = '',
      email = '',
      name = '',
      department = '',
      school = '',
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
        OR si.department LIKE ?
        OR si.school LIKE ?
      )`);
      params.push(buildLike(q), buildLike(q), buildLike(q), buildLike(q), buildLike(q), buildLike(q));
    }

    if (matric) {
      where.push(`pu.matric_number LIKE ?`);
      params.push(buildLike(matric));
    }

    if (email) {
      where.push(`(pu.username LIKE ? OR si.student_email LIKE ?)`);
      params.push(buildLike(email), buildLike(email));
    }

    if (name) {
      where.push(`CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) LIKE ?`);
      params.push(buildLike(name));
    }

    if (department) {
      where.push(`si.department LIKE ?`);
      params.push(buildLike(department));
    }

    if (school) {
      where.push(`si.school LIKE ?`);
      params.push(buildLike(school));
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await pool.query(
      `
      SELECT COUNT(DISTINCT pu.id) AS total
      FROM public_users pu
      LEFT JOIN student_imports si
        ON (
          (pu.matric_number IS NOT NULL AND si.matric_number = pu.matric_number)
          OR (pu.access_code IS NOT NULL AND si.access_code = pu.access_code)
          OR LOWER(si.student_email) = LOWER(pu.username)
        )
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
        si.year_of_entry,
        si.school,
        si.department,
        si.programme,
        COALESCE(si.student_level, si.level) AS student_level
      FROM public_users pu
      LEFT JOIN student_imports si
        ON (
          (pu.matric_number IS NOT NULL AND si.matric_number = pu.matric_number)
          OR (pu.access_code IS NOT NULL AND si.access_code = pu.access_code)
          OR LOWER(si.student_email) = LOWER(pu.username)
        )
      ${whereSql}
      GROUP BY pu.id
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
      return res.status(400).json({ success: false, message: 'Invalid student id.' });
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
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const b = req.body || {};
    const email = normalizeEmail(b.email);

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    if (!clean(b.firstName) || !clean(b.lastName)) {
      return res.status(400).json({ success: false, message: 'First name and last name are required.' });
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
      return res.status(400).json({ success: false, message: 'Email/username already belongs to another user.' });
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
        clean(b.stateOfOrigin) || '',
        clean(b.lga) || '',
        clean(b.phone) || '',
        email,
        clean(b.accessCode),
        clean(b.status) || 'ACTIVE',
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

    return res.json({ success: true, message: 'Student record updated.' });
  } catch (err) {
    await conn.rollback();
    console.error('updateStudent error:', err);

    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Duplicate email, access code, or matric number detected.' });
    }

    return res.status(500).json({ success: false, message: err.message || 'Update failed.' });
  } finally {
    conn.release();
  }
}
