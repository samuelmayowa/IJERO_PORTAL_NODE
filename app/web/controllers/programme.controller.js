import { pool } from '../../core/db.js';

const LEVEL_PATHS = [
  ['100', '200', '300', '400', '500', '600'],
  ['ND1', 'ND2', 'ND3'],
  ['HND1', 'HND2', 'HND3'],
];
export const PROGRAMME_LEVELS = LEVEL_PATHS.flat();

const clean = (value) => String(value ?? '').trim();
const positiveId = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const level = (value) => {
  const normalized = clean(value).toUpperCase();
  return PROGRAMME_LEVELS.includes(normalized) ? normalized : null;
};

function validateProgression(entryLevel, graduatingLevel) {
  if (!entryLevel || !graduatingLevel) throw new Error('Entry and graduating levels are required.');
  const path = LEVEL_PATHS.find((candidate) => candidate.includes(entryLevel));
  if (!path?.includes(graduatingLevel)) throw new Error('Entry and graduating levels must use the same level structure.');
  if (path.indexOf(entryLevel) > path.indexOf(graduatingLevel)) throw new Error('Graduating level cannot come before entry level.');
}

async function validateDepartment(connection, schoolId, departmentId) {
  const [[department]] = await connection.query(
    'SELECT id FROM departments WHERE id=? AND school_id=? LIMIT 1',
    [departmentId, schoolId],
  );
  if (!department) throw new Error('The selected department does not belong to the selected school.');
}

export async function managePage(req, res, next) {
  try {
    const q = clean(req.query.q);
    const like = `%${q}%`;
    const [[schools], [departments], [programmes]] = await Promise.all([
      pool.query('SELECT id,name FROM schools ORDER BY name'),
      pool.query('SELECT id,school_id,name FROM departments ORDER BY name'),
      pool.query(
        `SELECT p.id,p.name,p.acronym,p.school_id,p.department_id,
                p.entry_level,p.graduating_level,
                d.name department_name,s.name school_name
           FROM programmes p
           JOIN departments d ON d.id=p.department_id
           JOIN schools s ON s.id=p.school_id
          WHERE (?='' OR p.name LIKE ? OR d.name LIKE ? OR s.name LIKE ?)
          ORDER BY s.name,d.name,p.name`,
        [q, like, like, like],
      ),
    ]);
    res.render('programmes/manage', {
      layout: 'layouts/adminlte', title: 'Programme Management', pageTitle: 'Programme Management',
      schools, departments, programmes, levels: PROGRAMME_LEVELS, q,
      csrfToken: res.locals.csrfToken || '',
      success: req.flash('success')[0] || '', error: req.flash('error')[0] || '',
    });
  } catch (error) { next(error); }
}

export async function create(req, res) {
  const schoolId = positiveId(req.body.school_id);
  const departmentId = positiveId(req.body.department_id);
  const name = clean(req.body.name);
  const acronym = clean(req.body.acronym).toUpperCase() || null;
  const entryLevel = level(req.body.entry_level);
  const graduatingLevel = level(req.body.graduating_level);
  const connection = await pool.getConnection();
  try {
    if (!schoolId || !departmentId || !name) throw new Error('School, department and programme name are required.');
    validateProgression(entryLevel, graduatingLevel);
    await validateDepartment(connection, schoolId, departmentId);
    await connection.query(
      `INSERT INTO programmes (school_id,department_id,name,acronym,entry_level,graduating_level)
       VALUES (?,?,?,?,?,?)`,
      [schoolId, departmentId, name, acronym, entryLevel, graduatingLevel],
    );
    req.flash('success', 'Programme added. No students were promoted.');
  } catch (error) {
    req.flash('error', error.code === 'ER_DUP_ENTRY' ? 'That programme or acronym already exists.' : error.message || 'Programme could not be added.');
  } finally { connection.release(); }
  res.redirect('/staff/programmes');
}

export async function update(req, res) {
  const programmeId = positiveId(req.params.id);
  const schoolId = positiveId(req.body.school_id);
  const departmentId = positiveId(req.body.department_id);
  const name = clean(req.body.name);
  const acronym = clean(req.body.acronym).toUpperCase() || null;
  const entryLevel = level(req.body.entry_level);
  const graduatingLevel = level(req.body.graduating_level);
  const connection = await pool.getConnection();
  try {
    if (!programmeId || !schoolId || !departmentId || !name) throw new Error('All programme details are required.');
    validateProgression(entryLevel, graduatingLevel);
    await validateDepartment(connection, schoolId, departmentId);
    const [result] = await connection.query(
      `UPDATE programmes SET school_id=?,department_id=?,name=?,acronym=?,entry_level=?,graduating_level=? WHERE id=?`,
      [schoolId, departmentId, name, acronym, entryLevel, graduatingLevel, programmeId],
    );
    if (!result.affectedRows) throw new Error('Programme not found.');
    req.flash('success', 'Programme progression updated. No students were promoted.');
  } catch (error) {
    req.flash('error', error.code === 'ER_DUP_ENTRY' ? 'That programme or acronym already exists.' : error.message || 'Programme could not be updated.');
  } finally { connection.release(); }
  res.redirect('/staff/programmes');
}
