// app/core/session.js
import {
  isLoginAllowed,
  isReadOnly,
  blockedMessage,
  readOnlyActionMessage,
  canUseModule,
  allowedModules,
} from './status-policy.js';

// 🔹 REFRESH USER FROM STORE so status/roles are always current
import * as usersSvc from '../services/user.service.js';

async function hydrateUser(u) {
  if (!u) return null;

  // Try by id → username → email, and gracefully fallback if service lacks a method
  try {
    if (u.id && typeof usersSvc.findById === 'function') {
      const byId = await usersSvc.findById(u.id);
      if (byId) return byId;
    }
    if (u.username && typeof usersSvc.findByUsername === 'function') {
      const byU = await usersSvc.findByUsername(u.username);
      if (byU) return byU;
    }
    if (u.email && typeof usersSvc.findByEmail === 'function') {
      const byE = await usersSvc.findByEmail(u.email);
      if (byE) return byE;
    }
  } catch (e) {
    console.error('[hydrateUser] lookup failed:', e.message || e);
  }
  return u; // fallback to existing session copy
}

// Attach the signed-in account to req.user
export function requireAuth(req, res, next) {
  const u =
    (req.session && (req.session.user || req.session.staff || req.session.account)) ||
    req.user ||
    null;
  if (!u) return res.redirect('/login');
  req.user = u;
  next();
}

// Role gate (simple primary role check)
export function requireRole(...allowed) {
  const allow = allowed.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const u =
      (req.session && (req.session.user || req.session.staff || req.session.account)) ||
      req.user ||
      null;
    if (!u) return res.redirect('/login');
    const role = String(u.role || '').toLowerCase();
    if (!allow.includes(role)) {
      return res.status(403).render('pages/access-denied', {
        title: 'Access Denied',
        pageTitle: 'Access Denied',
        message: 'ACCESS DENIED: YOU DO NOT HAVE PERMISSION TO ACCESS THE REQUESTED PAGE',
      });
    }
    req.user = u;
    next();
  };
}

// Global status enforcement (MUST be mounted before routes)
export async function enforceStatusGlobally(req, res, next) {
  try {
    const safe = ['/logout', '/login', '/verify-otp', '/access-denied', '/'];
    const skip = safe.some((p) => req.path.startsWith(p));

    let u =
      (req.session && (req.session.user || req.session.staff || req.session.account)) ||
      req.user ||
      null;
    if (!u) return next();

    // 🔄 Refresh user from store to capture latest status/role
    const fresh = await hydrateUser(u);
    u = fresh || u;

    // sync back to session & req
    if (req.session) {
      if (req.session.user) req.session.user = u;
      if (req.session.staff) req.session.staff = u;
      if (req.session.account) req.session.account = u;
    }
    req.user = u;

    // Block if status not allowed (applies even if they were already logged in)
    if (!isLoginAllowed(u.status, u.role)) {
      if (!skip) {
        const msg = blockedMessage(u.status, u);
        try { req.session.destroy(() => {}); } catch (_) {}
        return res.status(403).render('pages/access-denied', {
          title: 'Access Denied',
          pageTitle: 'Access Denied',
          message: msg,
        });
      }
    }

    // Expose read-only + allowedModules to views
    res.locals.readOnly = isReadOnly(u.status, u.role);
    res.locals.allowedModules = allowedModules(u.role, u.status); // Set or null
    next();
  } catch (err) {
    console.error('[enforceStatusGlobally] error:', err);
    next();
  }
}

// Prevent writes in read-only states
export function blockIfReadOnly(featureName = 'This feature') {
  return (req, res, next) => {
    const u =
      (req.session && (req.session.user || req.session.staff || req.session.account)) ||
      req.user ||
      null;
    if (!u) return res.redirect('/login');

    if (isReadOnly(u.status, u.role)) {
      const msg = readOnlyActionMessage(u);
      const wantsJSON =
        req.xhr ||
        (req.get('accept') || '').includes('application/json') ||
        (req.get('content-type') || '').includes('application/json');
      if (wantsJSON) {
        return res.status(403).json({ success: false, message: msg, readOnly: true });
      }
      return res.status(403).render('pages/access-denied', {
        title: 'Access Restricted',
        pageTitle: 'Access Restricted',
        message: msg,
      });
    }
    next();
  };
}

// Student module gate (GRADUATED only gets RESULTS/PERSONAL)
export function requireModule(moduleKey) {
  return (req, res, next) => {
    const u =
      (req.session && (req.session.user || req.session.staff || req.session.account)) ||
      req.user ||
      null;
    if (!u) return res.redirect('/login');

    if (!canUseModule(u.role, u.status, moduleKey)) {
      return res.status(403).render('pages/access-denied', {
        title: 'Access Denied',
        pageTitle: 'Access Denied',
        message: 'ACCESS DENIED: YOU DO NOT HAVE PERMISSION TO ACCESS THE REQUESTED PAGE',
      });
    }
    next();
  };
}

// Used by auth.controller.js
export function redirectByRole(userOrRole) {
  let role = userOrRole;
  if (typeof userOrRole === 'object' && userOrRole) role = userOrRole.role;
  role = String(role || '').toLowerCase();

  const staffRoles = new Set([
    'admin', 'administrator', 'superadmin',
    'staff',
    'lecturer',
    'h.o.d', 'hod', 'head of department',
    'dean',
    'registrary', 'registry', 'registrar',
    'bursary', 'bursar',
    'ict staff', 'ict',
    'college health centre', 'health', 'health centre',
    'auditor',
    'admission officer', 'admissions officer', 'admission',
    'school/dept. officer', 'school officer', 'department officer', 'dept officer',
    'student union'
  ]);

  if (staffRoles.has(role)) return '/staff/dashboard';
  if (role === 'student') return '/student/dashboard';
  if (role === 'applicant') return '/applicant/dashboard';
  return '/';
}
