// app/web/controllers/course.controller.js
import { pool } from '../../core/db.js';

/* ---------- GET: Add Course page (with list + search/pager) ---------- */
export async function addPage(req, res) {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  // dropdowns
  let schools = [], departments = [], programmes = [];
  try {
    const [s] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    schools = s;
  } catch {}

  try {
    const [d] = await pool.query('SELECT d.id, d.name, d.school_id FROM departments d ORDER BY d.name');
    departments = d;
  } catch {}

  try {
    const [p] = await pool.query('SELECT id, name, department_id FROM programmes ORDER BY name');
    programmes = p;
  } catch {}

  // list courses (join school/department/programme + lecturer name)
  const where = [];
  const params = [];
  if (q) {
    where.push('(c.code LIKE ? OR c.title LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const countSql = `
    SELECT COUNT(*) AS total
    FROM courses c
    ${whereSql}
  `;
  const listSql = `
    SELECT c.id, c.code, c.title, c.unit, c.level, c.semester,
           c.school_id, c.department_id, c.programme_id, c.lecturer_id,
           s.name  AS school_name,
           d.name  AS department_name,
           p.name  AS programme_name,
           COALESCE(st.full_name, st.first_name, st.username, 'Not Assigned') AS lecturer_name
    FROM courses c
    LEFT JOIN schools s     ON s.id = c.school_id
    LEFT JOIN departments d ON d.id = c.department_id
    LEFT JOIN programmes p  ON p.id = c.programme_id
    LEFT JOIN staff st      ON st.id = c.lecturer_id
    ${whereSql}
    ORDER BY c.id DESC
    LIMIT ? OFFSET ?
  `;

  let total = 0, items = [];
  try {
    const [r1] = await pool.query(countSql, params);
    total = Number(r1?.[0]?.total || 0);
    const [r2] = await pool.query(listSql, [...params, pageSize, offset]);
    items = r2;
  } catch (e) {
    console.error('course addPage:', e);
  }

  // flash support
  const success = req.flash('success')[0] || '';
  const error   = req.flash('error')[0] || '';
  const confirmData = req.flash('confirmData')[0];
  let confirm = null;
  try { confirm = confirmData ? JSON.parse(confirmData) : null; } catch {}

  res.render('courses/add', {
    title: 'Add Course',
    pageTitle: 'Add Course',
    csrfToken: res.locals.csrfToken,
    schools, departments, programmes,
    q, page, pageSize, total, items,
    success, error, confirm
  });
}

/* ---------- POST: Add Course (programme optional) ---------- */
export async function addCourse(req, res) {
  const body = req.body || {};
  const payload = {
    code: (body.code || '').trim(),
    title: (body.title || '').trim(),
    unit: parseInt(body.unit || '0', 10) || 0,
    level: (body.level || 'ND1').trim(),
    semester: (body.semester || 'FIRST').trim(),
    school_id: body.school_id ? parseInt(body.school_id, 10) : null,
    department_id: body.department_id ? parseInt(body.department_id, 10) : null,
    programme_id: body.programme_id ? parseInt(body.programme_id, 10) : null // <-- optional
  };
  const override = String(body.override || '').toLowerCase() === 'yes';

  if (!payload.code || !payload.title) {
    req.flash('error', 'Course code and title are required.');
    return res.redirect('/staff/courses/add');
  }

  try {
    const [existRows] = await pool.query(
      'SELECT id FROM courses WHERE UPPER(code)=UPPER(?) LIMIT 1',
      [payload.code]
    );

    if (existRows.length && !override) {
      req.flash('confirmData', JSON.stringify({
        message: `Course Code "${payload.code}" already exists. Do you want to override the existing details?`,
        payload
      }));
      return res.redirect('/staff/courses/add');
    }

    if (existRows.length && override) {
      const id = existRows[0].id;
      await pool.query(
        `UPDATE courses
           SET title=?, unit=?, level=?, semester=?, school_id=?, department_id=?, programme_id=?
         WHERE id=?`,
        [payload.title, payload.unit, payload.level, payload.semester,
         payload.school_id, payload.department_id, payload.programme_id, id]
      );
      req.flash('success', `Course "${payload.code}" updated successfully.`);
    } else {
      await pool.query(
        `INSERT INTO courses (code, title, unit, level, semester, school_id, department_id, programme_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [payload.code, payload.title, payload.unit, payload.level, payload.semester,
         payload.school_id, payload.department_id, payload.programme_id]
      );
      req.flash('success', `Course "${payload.code}" added successfully.`);
    }
  } catch (e) {
    console.error('addCourse:', e);
    req.flash('error', 'Could not save course. Please try again.');
  }

  res.redirect('/staff/courses/add');
}

/* ---------- POST: Update a course inline ---------- */
export async function updateCourse(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  const b = req.body || {};
  if (!id) return res.redirect('/staff/courses/add');

  try {
    await pool.query(
      `UPDATE courses SET code=?, title=?, unit=?, level=?, semester=?,
                          school_id=?, department_id=?, programme_id=?
       WHERE id=?`,
      [
        (b.code || '').trim(),
        (b.title || '').trim(),
        parseInt(b.unit || '0', 10) || 0,
        (b.level || 'ND1').trim(),
        (b.semester || 'FIRST').trim(),
        b.school_id ? parseInt(b.school_id, 10) : null,
        b.department_id ? parseInt(b.department_id, 10) : null,
        b.programme_id ? parseInt(b.programme_id, 10) : null,
        id
      ]
    );
    req.flash('success', 'Course updated.');
  } catch (e) {
    console.error('updateCourse:', e);
    req.flash('error', 'Update failed.');
  }
  res.redirect('/staff/courses/add');
}

/* ---------- POST: Delete a course ---------- */
export async function deleteCourse(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  try {
    await pool.query('DELETE FROM courses WHERE id=?', [id]);
    req.flash('success', 'Course deleted.');
  } catch (e) {
    console.error('deleteCourse:', e);
    req.flash('error', 'Delete failed.');
  }
  res.redirect('/staff/courses/add');
}

/* ---------- AJAX: dependent departments by school (unchanged) ---------- */
export async function listDepartmentsBySchool(req, res) {
  const schoolId = parseInt(req.query.school_id || '0', 10);
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM departments WHERE school_id=? ORDER BY name',
      [schoolId || 0]
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('listDepartmentsBySchool:', e);
    res.json({ ok: false, items: [] });
  }
}

/* ---------- NEW AJAX: programmes by department ---------- */
export async function listProgrammesByDepartment(req, res) {
  const departmentId = parseInt(req.query.department_id || '0', 10);
  try {
    const [rows] = await pool.query(
      'SELECT id, name FROM programmes WHERE department_id=? ORDER BY name',
      [departmentId || 0]
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('listProgrammesByDepartment:', e);
    res.json({ ok: false, items: [] });
  }
}
