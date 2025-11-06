// app/web/controllers/applicant.controller.js
import { pool } from '../../core/db.js';

// Applicant dashboard -> render your AdminLTE applicant page
export function dashboard(req, res) {
  res.render('pages/applicant', { title: 'Applicant Dashboard', pageTitle: 'Dashboard' });
}

// GET /applicant/uniform
export async function uniformForm(req, res) {
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  // existing record (if any)
  let data = {};
  try {
    const [rows] = await pool.query(
      `SELECT * FROM uniform_measurements WHERE person_role=? AND person_id=? AND session_id <=> ? LIMIT 1`,
      [personRole, personId, sessionId]
    );
    data = rows[0] || {};
  } catch {}

  // dropdown data
  let schools = [], departments = [];
  try {
    const [r1] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    const [r2] = await pool.query('SELECT id, name, school_id FROM departments ORDER BY name');
    schools = r1; departments = r2;
  } catch {}

  res.render('uniform/uniform', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    mode: data?.id ? 'edit' : 'create',
    data, personRole, personId, sessionId, schools, departments
  });
}

// POST /applicant/uniform
export async function saveUniform(req, res) {
  const b = req.body || {};
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const sql = `
    INSERT INTO uniform_measurements
      (person_role, person_id, session_id, school_id, department_id, programme, level, entry_year,
       gender, height_cm, weight_kg, cap_size_cm, neck_cm, chest_cm, bust_cm, waist_cm, hips_cm,
       shoulder_cm, sleeve_cm, top_length_cm, trouser_len_cm, skirt_len_cm, shoe_size,
       color_cap, color_top, color_bottom, color_tie, status)
    VALUES (?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      school_id=VALUES(school_id), department_id=VALUES(department_id), programme=VALUES(programme),
      level=VALUES(level), entry_year=VALUES(entry_year), gender=VALUES(gender),
      height_cm=VALUES(height_cm), weight_kg=VALUES(weight_kg), cap_size_cm=VALUES(cap_size_cm),
      neck_cm=VALUES(neck_cm), chest_cm=VALUES(chest_cm), bust_cm=VALUES(bust_cm), waist_cm=VALUES(waist_cm),
      hips_cm=VALUES(hips_cm), shoulder_cm=VALUES(shoulder_cm), sleeve_cm=VALUES(sleeve_cm),
      top_length_cm=VALUES(top_length_cm), trouser_len_cm=VALUES(trouser_len_cm), skirt_len_cm=VALUES(skirt_len_cm),
      shoe_size=VALUES(shoe_size), color_cap=VALUES(color_cap), color_top=VALUES(color_top),
      color_bottom=VALUES(color_bottom), color_tie=VALUES(color_tie), status=VALUES(status)
  `;

  const params = [
    personRole, personId, sessionId,
    b.school_id || null, b.department_id || null, b.programme || null, b.level || null, b.entry_year || null,
    b.gender || null, b.height_cm || null, b.weight_kg || null, b.cap_size_cm || null, b.neck_cm || null,
    b.chest_cm || null, b.bust_cm || null, b.waist_cm || null, b.hips_cm || null,
    b.shoulder_cm || null, b.sleeve_cm || null, b.top_length_cm || null, b.trouser_len_cm || null, b.skirt_len_cm || null,
    b.shoe_size || null,
    b.color_cap || null, b.color_top || null, b.color_bottom || null, b.color_tie || null,
    (b.complete === '1') ? 'COMPLETED' : 'DRAFT'
  ];

  try { await pool.query(sql, params); } catch {}

  req.flash('success', (b.complete === '1') ? 'Uniform measurement submitted.' : 'Uniform measurement saved (draft).');
  return res.redirect('/applicant/uniform');
}

// GET /applicant/uniform/print
export async function uniformPrint(req, res) {
  const personRole = 'APPLICANT';
  const pu = req.session?.publicUser || {};
  const personId = (pu.username || pu.appNo || '').trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query('SELECT id FROM sessions WHERE is_current=1 LIMIT 1');
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const [rows] = await pool.query(
    `SELECT um.*, s.name AS school_name, d.name AS department_name
     FROM uniform_measurements um
     LEFT JOIN schools s ON s.id = um.school_id
     LEFT JOIN departments d ON d.id = um.department_id
     WHERE um.person_role=? AND um.person_id=? AND um.session_id <=> ? LIMIT 1`,
    [personRole, personId, sessionId]
  );
  const rec = rows[0] || {};

  // Build name: session → DB fallback
  let personName = (pu.first_name || pu.last_name)
    ? [pu.first_name, pu.middle_name, pu.last_name].filter(Boolean).join(' ')
    : '';

  if (!personName && personId) {
    try {
      const [pr] = await pool.query(
        'SELECT first_name, middle_name, last_name FROM public_users WHERE username=? LIMIT 1',
        [personId]
      );
      if (pr[0]) personName = [pr[0].first_name, pr[0].middle_name, pr[0].last_name].filter(Boolean).join(' ');
    } catch {}
  }

  res.render('uniform/print', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    record: rec,
    personRole,
    personId,
    personName,
    sessionId
  });
}
