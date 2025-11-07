// app/web/controllers/school.controller.js
import { pool } from '../../core/db.js';

export async function managePage(req, res) {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  const where = [];
  const params = [];
  if (q) { where.push('name LIKE ?'); params.push(`%${q}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let total = 0, schools = [];
  try {
    const [c] = await pool.query(`SELECT COUNT(*) AS total FROM schools ${whereSql}`, params);
    total = Number(c?.[0]?.total || 0);
    const [r] = await pool.query(`SELECT id, name FROM schools ${whereSql} ORDER BY name LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    schools = r;
  } catch (e) {
    console.error('school managePage:', e);
  }

  res.render('schools/manage', {
    title: 'Add/Edit School',
    pageTitle: 'Add/Edit School',
    csrfToken: res.locals.csrfToken,
    q, page, pageSize, total, schools,
    success: req.flash('success')[0] || '',
    error: req.flash('error')[0] || ''
  });
}

export async function create(req, res) {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/staff/schools');
  try {
    // Upsert by normalized name
    const [exist] = await pool.query('SELECT id FROM schools WHERE LOWER(name)=LOWER(?) LIMIT 1', [name]);
    if (exist.length) {
      await pool.query('UPDATE schools SET name=? WHERE id=?', [name, exist[0].id]);
      req.flash('success', 'School updated.');
    } else {
      await pool.query('INSERT INTO schools (name) VALUES (?)', [name]);
      req.flash('success', 'School added.');
    }
  } catch (e) {
    console.error('school create:', e);
    req.flash('error', 'Save failed.');
  }
  res.redirect('/staff/schools');
}

export async function update(req, res) {
  try {
    await pool.query('UPDATE schools SET name=? WHERE id=?', [(req.body.name || '').trim(), parseInt(req.params.id || '0', 10)]);
    req.flash('success', 'School updated.');
  } catch (e) {
    console.error('school update', e);
    req.flash('error', 'Update failed.');
  }
  res.redirect('/staff/schools');
}

export async function remove(req, res) {
  try {
    await pool.query('DELETE FROM schools WHERE id=?', [parseInt(req.params.id || '0', 10)]);
    req.flash('success', 'School deleted.');
  } catch (e) {
    console.error('school remove', e);
    req.flash('error', 'Delete failed.');
  }
  res.redirect('/staff/schools');
}
