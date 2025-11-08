// app/web/controllers/admin.controller.js
import * as users from '../../services/user.service.js';
import * as sessions from '../../services/session.service.js';
import { pool } from '../../core/db.js';

/* ---------- Helpers: normalize School/Department to NAMES ---------- */
async function normalizeSchoolName(input) {
  const val = String(input || '').trim();
  if (!val) return '';
  if (/^\d+$/.test(val)) {
    const [[row]] = await pool.query('SELECT name FROM schools WHERE id=? LIMIT 1', [Number(val)]);
    return row?.name || '';
  }
  return val;
}
async function normalizeDepartmentName(input) {
  const val = String(input || '').trim();
  if (!val) return '';
  if (/^\d+$/.test(val)) {
    const [[row]] = await pool.query('SELECT name FROM departments WHERE id=? LIMIT 1', [Number(val)]);
    return row?.name || '';
  }
  return val;
}

/* ---------- Add User (page) ---------- */
export const showAddUser = async (req, res) => {
  try {
    const [schools] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    const [departments] = await pool.query('SELECT id, school_id, name FROM departments ORDER BY name');

    // read flash *from req*
    const success = req.flash('success')[0] || '';
    const error   = req.flash('error')[0] || '';

    res.render('staff/admin-add-user', {
      title: 'Add User / Role',
      pageTitle: 'Add User / Role',
      csrfToken: res.locals.csrfToken,
      schools,
      departments,
      messages: { success, error }
    });
  } catch (e) {
    console.error('showAddUser error:', e);
    res.render('staff/admin-add-user', {
      title: 'Add User / Role',
      pageTitle: 'Add User / Role',
      csrfToken: res.locals.csrfToken,
      schools: [],
      departments: [],
      messages: { error: 'Failed to load schools/departments' }
    });
  }
};

/* ---------- Add User (POST) ---------- */
export const addUser = async (req, res) => {
  try {
    const {
      name: fullName,
      username,
      email,
      phone,
      level,
      staffNumber,
      school,
      department,
      highestQualification,
      password,
      role
    } = req.body || {};

    if (!email || !staffNumber) {
      req.flash('error', 'Email and Staff Number are required.');
      return res.redirect('/staff/users/add');
    }

    const schoolName = await normalizeSchoolName(school);
    const deptName   = await normalizeDepartmentName(department);

    await users.createUser({
      fullName,
      username,
      email,
      staffNumber,
      school: schoolName,
      department: deptName,
      highestQualification,
      password: password || 'College1',
      role
    });

    req.flash('success', 'User created successfully.');
  } catch (e) {
    let msg = e?.message || 'Could not create user.';
    if (e?.code === 'ER_DUP_ENTRY') {
      const m = (e.sqlMessage || '').toLowerCase();
      if (m.includes('uq_staff_username')) msg = 'Username already exists.';
      else if (m.includes('uq_staff_email')) msg = 'Email already exists.';
      else if (m.includes('uq_staff_no'))     msg = 'Staff Number already exists.';
      else msg = 'Duplicate value. Please use different credentials.';
    }
    console.error('addUser error:', e);
    req.flash('error', msg);
  }
  return res.redirect('/staff/users/add');
};

/* ---------- Password Reset ---------- */
export const showPasswordReset = async (_req, res) => {
  res.render('staff/admin-password-reset', { title: 'Password Reset', pageTitle: 'Password Reset' });
};
export const doPasswordReset = async (req, res) => {
  try {
    const { username } = req.body;
    await users.resetPassword(username, 'College1');
    return res.json({ success: true, message: 'Password Reset Successfully' });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || 'Could not reset password' });
  }
};

/* ---------- Manage Session ---------- */
export const showManageSession = async (_req, res) => {
  const data = await sessions.getAll();
  res.render('staff/session-current', {
    title: 'Manage Session',
    pageTitle: 'Manage Session',
    sessions: data.list,
    currentSession: data.current
  });
};
export const setSession = async (req, res) => {
  try {
    await sessions.setCurrent(req.body.session);
    req.flash('success', 'Session updated');
  } catch (e) {
    req.flash('error', e.message || 'Could not set session');
  }
  res.redirect('/staff/session/current');
};
export const switchBackSession = (_req, res) => res.redirect('/staff/session/current');

/* ---------- Manage Staff (pages) ---------- */
export async function showAssignRole(_req, res) {
  res.render('staff/assign-role', {
    title: 'Assign Role to Staff',
    pageTitle: 'Assign Role to Staff'
  });
}
export async function showModifyStaff(_req, res) {
  res.render('staff/modify-staff', {
    title: 'Modify Staff',
    pageTitle: 'Modify Staff'
  });
}

/* ---------- Shared API ---------- */
export const listUsers = async (req, res) => {
  try {
    const {
      role = '',
      q = '',
      department = '',
      school = '',
      email = '',
      name = '',
      username = '',
      staffNumber = '',
      page = '1',
      pageSize = '10'
    } = req.query;

    const data = await users.searchUsers({
      role, q, department, school, email, name, username, staffNumber,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 10
    });

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ items: [], total: 0, error: e.message || 'Failed to load users' });
  }
};

export const updateStaff = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid staff id' });

    const b = req.body || {};
    let schoolName = undefined, deptName = undefined;
    if (b.school !== undefined)     schoolName = await normalizeSchoolName(b.school);
    if (b.department !== undefined) deptName   = await normalizeDepartmentName(b.department);

    const sets = [], vals = [];
    if (b.fullName !== undefined)    { sets.push('full_name = ?');  vals.push(b.fullName || null); }
    if (b.email !== undefined)       { sets.push('email = ?');      vals.push(b.email || null); }
    if (b.username !== undefined)    { sets.push('username = ?');   vals.push(b.username || null); }
    if (b.staffNumber !== undefined) { sets.push('staff_no = ?');   vals.push(b.staffNumber || null); }
    if (b.phone !== undefined)       { sets.push('phone = ?');      vals.push(b.phone || null); }
    if (b.status !== undefined)      { sets.push('status = ?');     vals.push(b.status || null); }

    if (schoolName !== undefined) {
      const [[sch]] = await pool.query('SELECT id FROM schools WHERE name=? LIMIT 1', [schoolName || '']);
      if (sch?.id) { sets.push('school_id = ?'); vals.push(sch.id); }
    }
    if (deptName !== undefined) {
      const [[dep]] = await pool.query('SELECT id FROM departments WHERE name=? LIMIT 1', [deptName || '']);
      if (dep?.id) { sets.push('department_id = ?'); vals.push(dep.id); }
    }

    if (!sets.length) return res.json({ success: true, message: 'No changes' });

    const sql = `UPDATE staff SET ${sets.join(', ')} WHERE id = ? LIMIT 1`;
    vals.push(id);
    await pool.query(sql, vals);

    return res.json({ success: true });
  } catch (err) {
    console.error('updateStaff error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Update failed' });
  }
};

export const deleteStaff = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await users.deleteUser(id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not delete staff' });
  }
};

export const assignExtraRoles = async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const rolesRaw = req.body?.roles;
    const roles = Array.isArray(rolesRaw) ? rolesRaw : (rolesRaw ? [rolesRaw] : []);
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });

    await users.setRoles({ username, roles });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || 'Could not assign roles' });
  }
};

export const searchStaff = listUsers;
