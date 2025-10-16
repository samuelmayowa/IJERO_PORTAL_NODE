// app/web/controllers/admin.controller.js
//
// Controllers for Action Staff + Manage Staff (clean, parameterized).

import * as users from '../../services/user.service.js';
import * as sessions from '../../services/session.service.js';

/* ---------- Add User ---------- */
export const showAddUser = async (_req, res) => {
  res.render('staff/admin-add-user', { title: 'Add User / Role', pageTitle: 'Add User / Role' });
};

export const addUser = async (req, res) => {
  try {
    const {
      name: fullName, username, email,
      phone, level, // ignored but kept for form compatibility
      staffNumber, school, department,
      highestQualification, password, role
    } = req.body;

    await users.createUser({
      fullName, username, email,
      staffNumber, school, department, highestQualification,
      password: password || 'College1',
      role
    });

    req.flash('success', 'User created successfully!');
  } catch (e) {
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
    const payload = req.body || {};
    await users.updateUser(id, {
      full_name: payload.fullName,
      email: payload.email,
      username: payload.username,
      staff_no: payload.staffNumber,
      status: payload.status
    });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not update staff' });
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
/* Accept ONLY username + roles to avoid any accidental NaN/id issues. */
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
