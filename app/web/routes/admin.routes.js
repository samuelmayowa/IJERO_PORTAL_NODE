// app/web/routes/admin.routes.js
// Routes for “Action Staff” and “Manage Staff” tools.
// Notes:
// - Keeps your existing handlers (no UI/logic change).
// - Adds `requireRole('admin','staff')` so the pages are protected.
// - Uses AdminLTE layout for these pages.

import { Router } from 'express';
import { blockIfReadOnly, requireRole } from '../../core/session.js';
import {
  // Add User / Role
  showAddUser, addUser,
  // Password Reset
  showPasswordReset, doPasswordReset,
  // Sessions (legacy admin-only tools, page still useful)
  showManageSession, setSession, switchBackSession,
  // Staff tools (lists + edit)
  showModifyStaff, searchStaff, updateStaff, deleteStaff,
  // Assign extra roles
  showAssignRole, assignExtraRoles,
  // Shared
  listUsers
} from '../controllers/admin.controller.js';

const router = Router();

// Always use AdminLTE layout here
router.use((req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); });

// ──────────────────────────────────────────────────────────────
// Add User / Role
// ──────────────────────────────────────────────────────────────
router.get('/users/add',                 requireRole('admin','staff'), showAddUser);
router.post('/users/add',                requireRole('admin','staff'), blockIfReadOnly('Add User/Role'), addUser);

// ──────────────────────────────────────────────────────────────
// Password Reset
// ──────────────────────────────────────────────────────────────
router.get('/password-reset',            requireRole('admin','staff'), showPasswordReset);
router.post('/password-reset',           requireRole('admin','staff'), blockIfReadOnly('Password Reset'), doPasswordReset);

// ──────────────────────────────────────────────────────────────
// Session management (legacy admin panel page)
// (You now also have /staff/session/current & /staff/session/semester)
// ──────────────────────────────────────────────────────────────
router.get('/session/manage',            requireRole('admin','staff'), showManageSession);
router.post('/session/set',              requireRole('admin','staff'), blockIfReadOnly('Set Session'), setSession);
router.post('/session/back',             requireRole('admin','staff'), blockIfReadOnly('Switch Back Session'), switchBackSession);

// ──────────────────────────────────────────────────────────────
// Manage Staff (Modify)
// ──────────────────────────────────────────────────────────────
router.get('/manage/modify',             requireRole('admin','staff'), showModifyStaff);
router.get('/api/staff',                 requireRole('admin','staff'), searchStaff); // read-only
router.post('/api/staff/:id',            requireRole('admin','staff'), blockIfReadOnly('Update Staff'),  updateStaff);
router.post('/api/staff/:id/delete',     requireRole('admin','staff'), blockIfReadOnly('Delete Staff'),  deleteStaff);

// ──────────────────────────────────────────────────────────────
// Assign extra roles
// ──────────────────────────────────────────────────────────────
router.get('/manage/assign-role',        requireRole('admin','staff'), showAssignRole);
router.post('/api/staff/assign-roles',   requireRole('admin','staff'), blockIfReadOnly('Assign Roles'),  assignExtraRoles);

// ──────────────────────────────────────────────────────────────
// AJAX: users by role (used in reset & elsewhere)
// ──────────────────────────────────────────────────────────────
router.get('/api/users',                 requireRole('admin','staff'), listUsers);

export default router;
