// app/web/controllers/department.controller.js
import { pool } from '../../core/db.js';

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

  res.render('departments/manage', {
    title: 'Add/Edit Department',
    pageTitle: 'Add/Edit Department',
    csrfToken: res.locals.csrfToken,
    q, page, pageSize, total,
    schools, departments,
    success: req.flash('success')[0] || '',
    error: req.flash('error')[0] || ''
  });
}

export async function create(req, res) {
  const name = (req.body.name || '').trim();
  const school_id = req.body.school_id ? parseInt(req.body.school_id, 10) : null;
  if (!name || !school_id) return res.redirect('/staff/departments');

  try {
    // upsert on (name, school_id)
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
