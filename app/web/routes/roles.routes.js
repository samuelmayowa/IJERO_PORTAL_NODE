// app/web/routes/roles.routes.js
import { Router } from 'express';
import {
  lecturerDashboard,
  hodDashboard,
  deanDashboard,
  bursaryDashboard,
  registryDashboard,
  admissionOfficerDashboard,
  ictDashboard
} from '../controllers/dashboards.controller.js';

import { requireRole } from '../../core/session.js';

const r = Router();

/**
 * Apply AdminLTE layout ONLY to role areas (keeps public pages clean).
 */
r.use(
  ['/lecturer', '/hod', '/dean', '/bursary', '/registry', '/admission', '/ict', '/staff'],
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); }
);

/**
 * Expose CSRF token to AdminLTE views for safe POST /logout.
 * Falls back to empty string if csurf isn't active on this request.
 */
r.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  } catch (e) {
    res.locals.csrfToken = '';
  }
  next();
});

/** Role dashboards */
r.get('/lecturer/dashboard',  requireRole('lecturer','admin','staff'), lecturerDashboard);
r.get('/hod/dashboard',       requireRole('hod','admin','staff'),      hodDashboard);
r.get('/dean/dashboard',      requireRole('dean','admin','staff'),     deanDashboard);
r.get('/bursary/dashboard',   requireRole('bursary','admin','staff'),  bursaryDashboard);
r.get('/registry/dashboard',  requireRole('registry','admin','staff'), registryDashboard);
r.get('/admission/dashboard', requireRole('admission officer','admin','staff'), admissionOfficerDashboard);
r.get('/ict/dashboard',       requireRole('ict','admin','staff'),      ictDashboard);

/** Smart redirect from /dashboard by role (fallback to staff) */
r.get('/dashboard', (req, res) => {
  const role = String(req.session?.user?.role || '').toLowerCase();
  const map = new Map([
    ['lecturer', '/lecturer/dashboard'],
    ['hod',      '/hod/dashboard'],
    ['dean',     '/dean/dashboard'],
    ['bursary',  '/bursary/dashboard'],
    ['registry', '/registry/dashboard'],
    ['admission officer', '/admission/dashboard'],
    ['ict',      '/ict/dashboard'],
  ]);
  const target = map.get(role) || '/staff/dashboard';
  return res.redirect(target);
});

export default r;
