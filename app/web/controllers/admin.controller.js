// app/web/controllers/admin.controller.js
//
// Controllers for Action Staff + Manage Staff (clean, parameterized).

import * as users from '../../services/user.service.js';
import * as sessions from '../../services/session.service.js';
import { resolveSchoolId, resolveDepartmentId } from '../../services/user.service.js';
import { pool } from '../../core/db.js';

/* ---------- Add User (page) ---------- */
export const showAddUser = async (_req, res) => {
  try {
    const [schools] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    const [departments] = await pool.query('SELECT id, school_id, name FROM departments ORDER BY name');

    res.render('staff/admin-add-user', {
      title: 'Add User / Role',
      pageTitle: 'Add User / Role',
      schools,
      departments
    });
  } catch (e) {
    console.error('showAddUser error:', e);
    res.render('staff/admin-add-user', {
      title: 'Add User / Role',
      pageTitle: 'Add User / Role',
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
      // form field names from admin-add-user.ejs
      name: fullName,
      username,
      email,
      phone,                 // currently unused, kept for future
      level,                 // currently unused, kept for future
      staffNumber,
      school,
      department,
      highestQualification,  // currently unused, kept for future
      password,
      role
    } = req.body || {};

    await users.createUser({
      fullName,
      username,
      email,
      staffNumber,
      school,          // may be id or name; service handles both
      department,      // may be id or name; service handles both
      highestQualification,
      password: password || 'College1',
      role
    });

    req.flash('success', 'User created successfully!');
  } catch (e) {
    console.error('addUser error:', e);
    req.flash('error', e.message || 'Could not create user');
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

/* ---------- Session (legacy admin page still useful) ---------- */
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

/* ---------- Manage Staff: pages ---------- */
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

/* ---------- Shared API: list + filters (used by both pages) ---------- */
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

/* ---------- API: update / delete staff (Modify Staff) ---------- */
export const updateStaff = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid staff id' });

    const b = req.body || {};

    // Resolve school/department ids if text names were posted
    let school_id = null, department_id = null;
    if (b.school)      school_id = await resolveSchoolId(b.school);
    if (b.department)  department_id = await resolveDepartmentId(b.department);

    const sets = [], vals = [];
    if (b.fullName !== undefined)   { sets.push('full_name = ?');  vals.push(b.fullName || null); }
    if (b.email !== undefined)      { sets.push('email = ?');      vals.push(b.email || null); }
    if (b.username !== undefined)   { sets.push('username = ?');   vals.push(b.username || null); }
    if (b.staffNumber !== undefined){ sets.push('staff_no = ?');   vals.push(b.staffNumber || null); }
    if (b.phone !== undefined)      { sets.push('phone = ?');      vals.push(b.phone || null); }
    if (b.status !== undefined)     { sets.push('status = ?');     vals.push(b.status || null); }
    if (school_id)                  { sets.push('school_id = ?');  vals.push(school_id); }
    if (department_id)              { sets.push('department_id = ?'); vals.push(department_id); }

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

/* ---------- API: assign roles (Assign Role page) ---------- */
export const assignExtraRoles = async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const rolesRaw = req.body?.roles;
    const roles = Array.isArray(rolesRaw) ? rolesRaw : (rolesRaw ? [rolesRaw] : []);

    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }

    await users.setRoles({ username, roles });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || 'Could not assign roles' });
  }
};

/* Legacy alias (kept for router compatibility) */
export const searchStaff = listUsers;
