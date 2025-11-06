// app/web/routes/staff.routes.js
import { Router } from 'express';
import * as staffCtrl from '../controllers/staff.controller.js';
import * as uniformRpt from '../controllers/uniform.report.controller.js';
import { requireRole } from '../../core/session.js';

const router = Router();

/** Helper: safely call a controller if it exists. */
const safe = (fnName) => {
  const fn = staffCtrl?.[fnName];
  if (typeof fn === 'function') return fn;
  return (_req, res) => {
    res
      .status(500)
      .send(`Controller "${fnName}" is not exported as a function from app/web/controllers/staff.controller.js`);
  };
};

/**
 * Apply AdminLTE layout ONLY to staff areas (keeps public pages clean).
 */
router.use(
  ['/staff', '/dashboard', '/password-reset', '/api'],
  (req, res, next) => {
    res.locals.layout = 'layouts/adminlte';
    next();
  }
);

/**
 * Expose CSRF token to AdminLTE views for safe POST /logout.
 * Falls back to empty string if csurf isn't active on this request.
 */
router.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  } catch (e) {
    res.locals.csrfToken = '';
  }
  next();
});

/** Keep old link working: /staff -> /staff/dashboard */
router.get('/staff', (_req, res) => res.redirect('/staff/dashboard'));

/** Dashboard (existing page) */
router.get('/dashboard', safe('dashboard'));

/** Password Reset page + APIs */
router.get('/password-reset', safe('passwordResetPage'));                  // render page
router.get('/api/password/users', safe('listUsersForPasswordReset'));      // table data (paginated)
router.post('/api/password/reset/:id', safe('resetPasswordToCollege1'));   // reset to College1
router.post('/api/password/change', safe('changePasswordByAdmin'));        // admin sets custom password
// ─────────────────────────────────────────────
// Uniform Measurement Report (Admin/Registry/HOD)
// ─────────────────────────────────────────────
// Page
router.get('/uniform/report',         requireRole('admin','registry','hod'), uniformRpt.page);
router.get('/uniform/api/report',     requireRole('admin','registry','hod'), uniformRpt.apiList);
router.get('/uniform/api/export/csv', requireRole('admin','registry','hod'), uniformRpt.exportCsv);



export default router;
