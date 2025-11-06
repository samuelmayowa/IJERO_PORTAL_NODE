// app/web/controllers/uniform.report.controller.js
import { pool } from '../../core/db.js';

/* ---------------- Page (filters) ---------------- */
export async function page(req, res) {
  let sessions = [], schools = [], departments = [];
  try { const [r] = await pool.query('SELECT id, name, is_current FROM sessions ORDER BY id DESC'); sessions = r; } catch {}
  try { const [r] = await pool.query('SELECT id, name FROM schools ORDER BY name'); schools = r; } catch {}
  try { const [r] = await pool.query('SELECT id, name, school_id FROM departments ORDER BY name'); departments = r; } catch {}

  const staff = req.session?.staff || req.session?.user || {};
  const hodDeptId = (String(staff?.department_id ?? '') || null);

  res.render('uniform/report', {
    title: 'Uniform Report',
    pageTitle: 'Uniform Report',
    sessions, schools, departments,
    hodDeptId
  });
}

/* ---------------- helpers ---------------- */
function buildBaseWhere(req) {
  const q = req.query || {};
  const where = [];
  const params = [];

  if (q.session_id)    { where.push('um.session_id = ?'); params.push(q.session_id); }
  if (q.school_id)     { where.push('um.school_id = ?');  params.push(q.school_id); }
  if (q.department_id) { where.push('um.department_id = ?'); params.push(q.department_id); }
  if (q.person_role)   { where.push('um.person_role = ?'); params.push(String(q.person_role).toUpperCase()); }

  // Restrict HOD to own department if available
  const role = (req.session?.user?.role || req.session?.staff?.role || '').toLowerCase();
  if (role === 'hod') {
    const hodDeptId = req.session?.user?.department_id || req.session?.staff?.department_id;
    if (hodDeptId) { where.push('um.department_id = ?'); params.push(hodDeptId); }
  }

  // Free-text search across person_id, name, school, department
  if (q.q) {
    const like = `%${q.q}%`;
    where.push('(um.person_id LIKE ? OR pu.first_name LIKE ? OR pu.last_name LIKE ? OR s.name LIKE ? OR d.name LIKE ?)');
    params.push(like, like, like, like, like);
  }

  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/* ---------------- API: paginated list ---------------- */
export async function apiList(req, res) {
  const page     = Math.max(1, parseInt(req.query.page ?? '1', 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize ?? '10', 10)));
  const offset   = (page - 1) * pageSize;

  const { clause, params } = buildBaseWhere(req);

  const selectSql = `
    SELECT
      um.id, um.person_role, um.person_id, um.session_id,
      s.name  AS school_name,
      d.name  AS department_name,
      um.programme, um.level, um.entry_year, um.gender,
      um.waist_cm, um.chest_cm, um.hips_cm, um.shoe_size,
      um.color_cap, um.color_top, um.color_bottom, um.color_tie,
      um.status, DATE_FORMAT(um.created_at, '%Y-%m-%d %H:%i') AS created_at,
      CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS person_name
    FROM uniform_measurements um
    LEFT JOIN schools s      ON s.id = um.school_id
    LEFT JOIN departments d  ON d.id = um.department_id
    LEFT JOIN public_users pu
      ON pu.username = um.person_id COLLATE utf8mb4_unicode_ci
    ${clause}
    ORDER BY um.id DESC
    LIMIT ? OFFSET ?`;

  const countSql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN UPPER(um.gender)='MALE'   THEN 1 ELSE 0 END) AS male_cnt,
      SUM(CASE WHEN UPPER(um.gender)='FEMALE' THEN 1 ELSE 0 END) AS female_cnt,
      SUM(CASE WHEN UPPER(um.status)='COMPLETED' THEN 1 ELSE 0 END) AS completed_cnt
    FROM uniform_measurements um
    LEFT JOIN schools s      ON s.id = um.school_id
    LEFT JOIN departments d  ON d.id = um.department_id
    LEFT JOIN public_users pu
      ON pu.username = um.person_id COLLATE utf8mb4_unicode_ci
    ${clause}`;

  let rows = [], totals = { total:0, male_cnt:0, female_cnt:0, completed_cnt:0 };
  try {
    const [r1] = await pool.query(countSql, params);
    totals = r1?.[0] || totals;
    const [r2] = await pool.query(selectSql, [...params, pageSize, offset]);
    rows = r2;
  } catch (e) {
    console.error('uniform apiList error:', e);
  }

  res.json({
    ok: true,
    page, pageSize,
    total: Number(totals.total || 0),
    male: Number(totals.male_cnt || 0),
    female: Number(totals.female_cnt || 0),
    completed: Number(totals.completed_cnt || 0),
    items: rows
  });
}

/* ---------------- API: CSV Export (uses same filters) ---------------- */
export async function exportCsv(req, res) {
  const { clause, params } = buildBaseWhere(req);
  const sql = `
    SELECT
      um.person_role, um.person_id,
      CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS person_name,
      um.session_id,
      s.name AS school, d.name AS department,
      um.programme, um.level, um.entry_year, um.gender,
      um.neck_cm, um.chest_cm, um.bust_cm, um.waist_cm, um.hips_cm,
      um.sleeve_cm, um.shoulder_cm, um.top_length_cm, um.trouser_len_cm, um.skirt_len_cm,
      um.shoe_size,
      um.color_cap, um.color_top, um.color_bottom, um.color_tie,
      um.status, DATE_FORMAT(um.created_at, '%Y-%m-%d %H:%i') AS created_at
    FROM uniform_measurements um
    LEFT JOIN schools s      ON s.id = um.school_id
    LEFT JOIN departments d  ON d.id = um.department_id
    LEFT JOIN public_users pu
      ON pu.username = um.person_id COLLATE utf8mb4_unicode_ci
    ${clause}
    ORDER BY um.id DESC
    LIMIT 5000
  `;

  let rows = [];
  try { const [r] = await pool.query(sql, params); rows = r; } catch (e) { console.error('exportCsv', e); }

  const headers = Object.keys(rows[0] || {
    person_role:'', person_id:'', person_name:'', session_id:'', school:'', department:'',
    programme:'', level:'', entry_year:'', gender:'', neck_cm:'', chest_cm:'', bust_cm:'',
    waist_cm:'', hips_cm:'', sleeve_cm:'', shoulder_cm:'', top_length_cm:'', trouser_len_cm:'',
    skirt_len_cm:'', shoe_size:'', color_cap:'', color_top:'', color_bottom:'', color_tie:'',
    status:'', created_at:''
  });

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="uniform-report.csv"');
  res.send(lines.join('\r\n'));
}
