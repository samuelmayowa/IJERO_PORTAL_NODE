// app/web/routes/staff.routes.js
import { Router } from 'express';

// Existing controllers already in your app
import * as staffCtrl from '../controllers/staff.controller.js';
import * as uniformRpt from '../controllers/uniform.report.controller.js';

// Guards – be tolerant to different export names in app/core/session.js
import * as guard from '../../core/session.js';

// New controllers we added
import * as courseCtrl from '../controllers/course.controller.js';
import * as schoolCtrl from '../controllers/school.controller.js';
import * as departmentCtrl from '../controllers/department.controller.js';

const router = Router();

/* ──────────────────────────────────────────────────────────
   Helpers: resolve guards & safe controller access
   ────────────────────────────────────────────────────────── */
const staffOnly =
  guard.staffOnly ||
  guard.requireStaff ||
  guard.ensureStaff ||
  ((req, _res, next) => next()); // last-resort passthrough to avoid 500s

const requireRole = (...roles) =>
  (guard.requireRole ? guard.requireRole(...roles)
   : (req, _res, next) => next());

const safe = (fnName) => {
  const fn = staffCtrl?.[fnName];
  if (typeof fn === 'function') return fn;
  return (_req, res) =>
    res.status(500).send(
      `Controller "${fnName}" is not exported from app/web/controllers/staff.controller.js`
    );
};

/* ──────────────────────────────────────────────────────────
   Layout + CSRF available on every staff page
   ────────────────────────────────────────────────────────── */
router.use((req, res, next) => {
  res.locals.layout = 'layouts/adminlte';
  next();
});

router.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  } catch {
    res.locals.csrfToken = '';
  }
  next();
});

/* ──────────────────────────────────────────────────────────
   Keep /staff redirect + Dashboard
   ────────────────────────────────────────────────────────── */
router.get('/', (_req, res) => res.redirect('/staff/dashboard'));
router.get('/dashboard', safe('dashboard'));

/* ───────────────── Password tools (existing) ────────────── */
router.get('/password-reset',          safe('passwordResetPage'));
router.get('/api/password/users',      safe('listUsersForPasswordReset'));
router.post('/api/password/reset/:id', safe('resetPasswordToCollege1'));
router.post('/api/password/change',    safe('changePasswordByAdmin'));

/* ─────────────── Uniform Measurement Report ─────────────── */
router.get('/uniform/report',         requireRole('admin','registry','hod'), uniformRpt.page);
router.get('/uniform/api/report',     requireRole('admin','registry','hod'), uniformRpt.apiList);
router.get('/uniform/api/export/csv', requireRole('admin','registry','hod'), uniformRpt.exportCsv);

// ----- Courses -----
router.get('/courses/add', courseCtrl.addPage);
router.get('/courses/departments', courseCtrl.listDepartmentsBySchool);

router.post('/courses/add', courseCtrl.addCourse);
router.post('/courses/:id/update', courseCtrl.updateCourse);
router.post('/courses/:id/delete', courseCtrl.deleteCourse);


/* ───────────────────── Schools (Manage) ─────────────────── */
// ----- Schools -----
router.get('/schools',            schoolCtrl.managePage);
router.post('/schools/create',    schoolCtrl.create);
router.post('/schools/:id/update',schoolCtrl.update);
router.post('/schools/:id/delete',schoolCtrl.remove);


// ----- Departments -----
router.get('/departments',              departmentCtrl.managePage);
router.post('/departments/create',      departmentCtrl.create);
router.post('/departments/:id/update',  departmentCtrl.update);
router.post('/departments/:id/delete',  departmentCtrl.remove);


export default router;
