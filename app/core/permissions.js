// app/core/permissions.js
import { ROLE_MENUS, normalizePath } from '../web/config/role-menus.js';

function isSuperRole(role = '', superRoles = []) {
  const r = String(role || '').toLowerCase();
  return superRoles.map(x => String(x).toLowerCase()).includes(r);
}

/**
 * Guard requests by role-based allow-list.
 * Options:
 *  - base: '/staff' or '/student' (only enforce under this prefix)
 *  - allowIfNoConfig: if true, roles without a config are allowed everywhere
 *  - superRoles: list of roles that bypass checks (e.g., ['admin','superadmin'])
 */
export function requireMenuPermission({
  base = '/staff',
  allowIfNoConfig = true,
  superRoles = ['admin', 'superadmin', 'administrator'],
} = {}) {
  const baseNorm = normalizePath(base);

    return (req, res, next) => {
    // Only enforce under the base path
    const pathNorm = normalizePath(req.path);
    if (!pathNorm.startsWith(baseNorm)) return next();

    const role = String(res.locals.user?.role || '').toLowerCase();

    // Super roles: bypass
    if (isSuperRole(role, superRoles)) return next();

    const cfg = ROLE_MENUS[role];

    // No config: allow (so legacy/admin flow keeps working)
    if (typeof cfg === 'undefined' && allowIfNoConfig) return next();

    // Null config: full access
    if (cfg === null) return next();

    // Array allow-list — normalize & test
    const allowed = new Set((cfg || []).map(normalizePath));

    // Common dashboard route should always be whitelisted by you,
    // but allow '/staff' itself for convenience
    if (pathNorm === baseNorm) return next();

    if (allowed.has(pathNorm)) return next();

    // Deny with your existing page
    return res.status(403).render('pages/denied', {
      title: 'Access Denied',
      pageTitle: 'ACCESS DENIED',
      reason: 'ACCESS DENIED: YOU DO NOT HAVE PERMISSION TO ACCESS THE REQUESTED PAGE',
      homeHref: '/',
    });
  };

}
