// app/web/controllers/department.controller.js
import { pool } from '../../core/db.js';

/* ---------- PAGE: Manage Departments + Programmes ---------- */
export async function managePage(req, res) {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  let schools = [];
  try {
    const [s] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    schools = s;
  } catch {}

  const where = [];
  const params = [];
  if (q) {
    where.push('(d.name LIKE ? OR s.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const countSql = `
    SELECT COUNT(*) AS total
    FROM departments d
    LEFT JOIN schools s ON s.id = d.school_id
    ${whereSql}
  `;
  const listSql = `
    SELECT d.id, d.name, d.school_id, s.name AS school_name
    FROM departments d
    LEFT JOIN schools s ON s.id = d.school_id
    ${whereSql}
    ORDER BY d.id DESC
    LIMIT ? OFFSET ?
  `;

  let total = 0, departments = [];
  try {
    const [c] = await pool.query(countSql, params);
    total = Number(c?.[0]?.total || 0);
    const [r] = await pool.query(listSql, [...params, pageSize, offset]);
    departments = r;
  } catch (e) {
    console.error('dept managePage:', e);
  }

  // Pull all programmes so we can list/filter client-side
  let programmes = [];
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.department_id, p.school_id
         FROM programmes p
        ORDER BY p.name`
    );
    programmes = rows;
  } catch (e) {
    console.error('programmes list:', e);
  }

  res.render('departments/manage', {
    title: 'Add/Edit Department',
    pageTitle: 'Add/Edit Department',
    csrfToken: res.locals.csrfToken,
    q, page, pageSize, total,
    schools, departments, programmes,
    success: req.flash('success')[0] || '',
    error: req.flash('error')[0] || ''
  });
}

/* ---------- POST: Create or upsert a Department ---------- */
export async function create(req, res) {
  const name = (req.body.name || '').trim();
  const school_id = req.body.school_id ? parseInt(req.body.school_id, 10) : null;
  if (!name || !school_id) return res.redirect('/staff/departments');

  try {
    const [exist] = await pool.query(
      'SELECT id FROM departments WHERE LOWER(name)=LOWER(?) AND school_id=? LIMIT 1',
      [name, school_id]
    );
    if (exist.length) {
      await pool.query('UPDATE departments SET name=?, school_id=? WHERE id=?', [name, school_id, exist[0].id]);
      req.flash('success', 'Department updated.');
    } else {
      await pool.query('INSERT INTO departments (name, school_id) VALUES (?,?)', [name, school_id]);
      req.flash('success', 'Department added.');
    }
  } catch (e) {
    console.error('dept create:', e);
    req.flash('error', 'Save failed.');
  }
  res.redirect('/staff/departments');
}

/* ---------- POST: Update Department ---------- */
export async function update(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  const name = (req.body.name || '').trim();
  const school_id = req.body.school_id ? parseInt(req.body.school_id, 10) : null;

  try {
    await pool.query('UPDATE departments SET name=?, school_id=? WHERE id=?', [name, school_id, id]);
    req.flash('success', 'Department updated.');
  } catch (e) {
    console.error('dept update:', e);
    req.flash('error', 'Update failed.');
  }
  res.redirect('/staff/departments');
}

/* ---------- POST: Delete Department ---------- */
export async function remove(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  try {
    await pool.query('DELETE FROM departments WHERE id=?', [id]);
    req.flash('success', 'Department deleted.');
  } catch (e) {
    console.error('dept remove:', e);
    req.flash('error', 'Delete failed.');
  }
  res.redirect('/staff/departments');
}

/* ---------- NEW: Create Programme ---------- */
export async function createProgramme(req, res) {
  const school_id = req.body.school_id ? parseInt(req.body.school_id, 10) : null;
  const department_id = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
  const name = (req.body.programme_name || '').trim();

  if (!school_id || !department_id || !name) {
    req.flash('error', 'Programme needs school, department and name.');
    return res.redirect('/staff/departments');
  }

  try {
    await pool.query(
      `INSERT INTO programmes (school_id, department_id, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name)`,
      [school_id, department_id, name]
    );
    req.flash('success', 'Programme saved.');
  } catch (e) {
    console.error('createProgramme:', e);
    req.flash('error', 'Could not save programme.');
  }
  res.redirect('/staff/departments');
}

/* ---------- NEW: Delete Programme ---------- */
export async function deleteProgramme(req, res) {
  const id = parseInt(req.params.id || '0', 10);
  try {
    await pool.query('DELETE FROM programmes WHERE id=?', [id]);
    req.flash('success', 'Programme deleted.');
  } catch (e) {
    console.error('deleteProgramme:', e);
    req.flash('error', 'Delete failed.');
  }
  res.redirect('/staff/departments');
}

/* ---------- AJAX: Programmes by Department ---------- */
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
