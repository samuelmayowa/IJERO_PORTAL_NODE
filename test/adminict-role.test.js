import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STAFF_PERMISSIONS, ROLE_PERMISSION_DEFAULTS, defaultPermissions } from '../app/core/staff-permissions.js';
import { HOME_BY_ROLE } from '../app/core/roles.js';
import { isLoginAllowed } from '../app/core/status-policy.js';
import { redirectByRole } from '../app/core/session.js';
import { ROLE_MENUS } from '../app/web/config/role-menus.js';

test('adminict has every administrative permission except role assignment', () => {
  const permissions = defaultPermissions(['adminict']);
  assert.equal(permissions.size, STAFF_PERMISSIONS.length - 1);
  assert.equal(permissions.has('dashboard.view'), true);
  assert.equal(permissions.has('roles.manage'), false);
  assert.deepEqual(new Set(ROLE_PERMISSION_DEFAULTS.adminict), permissions);
});

test('adminict uses the staff dashboard and administrative menu policy', () => {
  assert.equal(HOME_BY_ROLE.adminict, '/staff/dashboard');
  assert.equal(redirectByRole({ role: 'adminict' }), '/staff/dashboard');
  assert.equal(ROLE_MENUS.adminict, null);
});

test('adminict follows the staff account-status policy', () => {
  assert.equal(isLoginAllowed('ACTIVE', 'adminict'), true);
  assert.equal(isLoginAllowed('SUSPENDED', 'adminict'), false);
});

test('layout and shared sidebar recognize adminict explicitly', () => {
  const layout = fs.readFileSync(new URL('../app/web/views/layouts/adminlte.ejs', import.meta.url), 'utf8');
  const sidebar = fs.readFileSync(new URL('../app/web/views/partials/sidebar.ejs', import.meta.url), 'utf8');
  assert.match(layout, /_role === 'adminict' \? 'admin'/);
  assert.match(sidebar, /'admin', 'adminict', 'administrator', 'superadmin'/);
});
