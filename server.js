// server.js
import 'dotenv/config';
import { requireAuth, requireRole, enforceStatusGlobally } from './app/core/session.js';
import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import csrf from 'csurf';
import flash from 'connect-flash';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';

import adminRoutes from './app/web/routes/admin.routes.js';
import { ROLE_MENUS } from './app/web/config/role-menus.js';
import { requireMenuPermission } from './app/core/permissions.js';
import { ensureAdminUser } from './app/services/user.service.js';

import * as authRoutesMod       from './app/web/routes/auth.routes.js';
import * as staffRoutesMod      from './app/web/routes/staff.routes.js';
import * as studentRoutesMod    from './app/web/routes/student.routes.js';
import * as transcriptRoutesMod from './app/web/routes/transcripts.routes.js';
import * as resultsRoutesMod    from './app/web/routes/results.routes.js';
import * as acadRoutesMod       from './app/web/routes/academic-records.routes.js';
import * as applicantRoutesMod  from './app/web/routes/applicant.routes.js';

import sessionRoutes  from "./app/web/routes/session.routes.js";
import semesterRoutes from "./app/web/routes/semester.routes.js";
import attendanceRoutes from './app/web/routes/attendance.routes.js';
import { notFound, errorHandler } from './app/core/error.js';
import markAttendanceRoutes from './app/web/routes/mark-attendance.routes.js';
import attendanceReportRoutes from './app/web/routes/attendance-report.routes.js';
import watchlistRoutes from './app/web/routes/watchlist.routes.js';
// import * as feesRoutesMod from './app/web/routes/fees.routes.js';
import * as feesRoutesMod from './app/web/routes/staff/fees.js';
import paymentRoutes from './app/web/routes/payment.routes.js';
import roleRoutes from './app/web/routes/roles.routes.js';
import assignCourseRoutes from './app/web/routes/assign-course.routes.js';
import viewAssignedCoursesRoutes from './app/web/routes/view-assigned-courses.routes.js';
import lectureTimeRoutes from './app/web/routes/lecture-time.routes.js';
import examDateRoutes from './app/web/routes/exam-date.routes.js';
import studentLectureTimeRoutes from './app/web/routes/student-lecture-time.routes.js';
import studentExamTimeRoutes from './app/web/routes/student-exam-time.routes.js';
import studentProfileRoutes from './app/web/routes/student-profile.routes.js';
import studentUploadRoutes from './app/web/routes/student-upload.routes.js';
import studentRegistrationRoutes from './app/web/routes/student-registration.routes.js';
import courseRegistrationReportRoutes from './app/web/routes/course-registration-report.routes.js';
import studentAttendanceRoutes from './app/web/routes/student-attendance.routes.js';
import studentLectureVenueRoutes from './app/web/routes/student-lecture-venue.routes.js';
import studentAttendanceReportRoutes from './app/web/routes/student-attendance-report.routes.js';






// -------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

function requireRouter(mod, label) {
  const r = mod?.default || mod?.router || mod?.routes;
  if (typeof r !== 'function') throw new Error(`[ROUTES] ${label} must export a router`);
  return r;
}

const authRoutes       = requireRouter(authRoutesMod,       'auth.routes.js');
const staffRoutes      = requireRouter(staffRoutesMod,      'staff.routes.js');
const studentRoutes    = requireRouter(studentRoutesMod,    'student.routes.js');
const transcriptRoutes = requireRouter(transcriptRoutesMod, 'transcripts.routes.js');
const resultsRoutes    = requireRouter(resultsRoutesMod,    'results.routes.js');
const acadRoutes       = requireRouter(acadRoutesMod,       'academic-records.routes.js');
const applicantRoutes  = requireRouter(applicantRoutesMod,  'applicant.routes.js');
// const feesRoutes = requireRouter(feesRoutesMod, 'fees.routes.js');
const feesRoutes = requireRouter(feesRoutesMod, 'staff/fees.js');


// -------------------------------------------------------------
// SESSIONS / SECURITY / GLOBAL MIDDLEWARE
// -------------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 6 }
  })
);

app.use(helmet({ contentSecurityPolicy: false }));

app.set('views', path.join(__dirname, 'app/web/views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layouts/main');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));
app.use(flash());

// make the current URL path available to all EJS views as `currentPath`
app.use((req, res, next) => {
  res.locals.currentPath = req.path || '';
  next();
});

// Static
app.use('/public', express.static(path.join(__dirname, 'app/web/public')));
app.get('/favicon.ico', (_req, res) =>
  res.sendFile(path.join(__dirname, 'app/web/public', 'favicon.ico'))
);

// CSRF
// const csrfProtection = csrf({ cookie: false });
// app.use((req, res, next) => {
//   if (req.path === '/login') return next();
//   return csrfProtection(req, res, next);
// });
const csrfProtection = csrf({ cookie: false });

// Global CSRF, but skip some paths where we handle CSRF at route level
const csrfSkipPaths = ['/login', '/student/profile'];

app.use((req, res, next) => {
  if (csrfSkipPaths.includes(req.path)) return next();
  return csrfProtection(req, res, next);
});


app.use('/', roleRoutes);  // put above any “catch-all” redirects

// Expose CSRF + user to all views
app.use((req, res, next) => {
  try { res.locals.csrfToken = req.csrfToken?.() || null; } catch { res.locals.csrfToken = null; }
  const s = req.session || {};
  res.locals.user = s.user || s.staff || s.account || req.user || null;

  const role = String(res.locals.user?.role || '').toLowerCase();
  res.locals.roleMenus = ROLE_MENUS;
  res.locals.roleMenuForUser = ROLE_MENUS[role] ?? null;
  if (typeof res.locals.allowedModules === 'undefined') res.locals.allowedModules = null;
  next();
});

// Friendly CSRF error
app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('pages/denied', {
      title: 'Access Denied',
      pageTitle: 'ACCESS DENIED',
      reason: 'Invalid or missing security token. Please refresh and try again.',
      homeHref: '/',
    });
  }
  return next(err);
});

app.use(enforceStatusGlobally);
app.use((req, res, next) => {
  if (res.locals.title === undefined) res.locals.title = 'Dashboard';
  next();
});
app.use((req, res, next) => {
  res.locals.messages = {
    success: req.flash('success')[0],
    error: req.flash('error')[0]
  };
  next();
});

// Helper for rendering user in views
function ensureUserForViews(req, res, next) {
  if (!res.locals.user) {
    const s = req.session || {};
    const c = s.user || s.staff || s.account || req.user || {};
    const role = String(c.role || s.role || 'staff').toLowerCase();
    const name = c.name || c.fullname || c.email || 'User';
    res.locals.user = { name, role };
  }
  next();
}


// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------
app.get('/', (_req, res) => res.render('pages/landing'));
app.use('/', authRoutes);

// Set Lecture Time (same guard style as attendance)
app.use(
  '/staff/lecture-time',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  requireRole('staff', 'admin', 'hod', 'registry', 'lecturer', 'bursary'),
  lectureTimeRoutes
);

// Set Exam Date (visible to all staff, same pattern as lecture time)
app.use(
  '/staff/exams/date',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  requireRole('staff', 'admin', 'hod', 'registry', 'lecturer', 'bursary'),
  examDateRoutes
);
// ✅ Alias so old URLs like /staff/exam/set-date/9 also work
app.use(
  '/staff/exam',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  requireRole('staff', 'admin', 'hod', 'registry', 'lecturer', 'bursary'),
  examDateRoutes
);

// =======================================================
// ASSIGN COURSE ROUTES — MUST COME BEFORE GENERIC /staff
// =======================================================
app.use(
  '/staff/courses',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  assignCourseRoutes
);
app.use('/staff/courses', viewAssignedCoursesRoutes);
// Student attendance pages use the AdminLTE layout + staff roles
app.use(
  '/staff/student-attendance',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  requireRole('staff', 'admin', 'hod', 'registry', 'lecturer', 'bursary')
);



// Applicant (AdminLTE layout + correct sidebar role)
app.use(
  '/applicant',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  (req, res, next) => {
    if (!res.locals.user) res.locals.user = { name: 'User', role: 'applicant' };
    else res.locals.user.role = 'applicant';
    next();
  },
  applicantRoutes
);

// Student lecture time (view-only page)
app.use(
  '/student/lecture-time',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  (req, res, next) => {
    // mimic the /student block so sidebar + role work correctly
    if (!res.locals.user) res.locals.user = { name: 'User', role: 'student' };
    else res.locals.user.role = 'student';
    next();
  },
  studentLectureTimeRoutes
);

// Student exam time table (view + PDF)
app.use(
  '/student/exam-time-table',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  (req, res, next) => {
    if (!res.locals.user) res.locals.user = { name: 'User', role: 'student' };
    else res.locals.user.role = 'student';
    next();
  },
  studentExamTimeRoutes
);

// Student profile (photo + emergency contact etc.)
app.use(
  '/student/profile',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  ensureUserForViews,
  (req, res, next) => {
    if (!res.locals.user) res.locals.user = { name: 'User', role: 'student' };
    else res.locals.user.role = 'student';
    next();
  },
  studentProfileRoutes
);

// after other student routes like /student/profile, /student/exam-time-table, etc.

app.use(
  '/student/registration',
  ensureUserForViews,
  (req, res, next) => {
    // Make sure layout & user role matches your existing student pages
    res.locals.layout = 'layouts/adminlte';
    if (res.locals.user) {
      res.locals.user.role = 'student';
    }
    next();
  },
  studentRegistrationRoutes,
);

// Student attendance (uses same layout, but path is /student/attendance/...) 
app.use(
  '/student/attendance',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  studentAttendanceRoutes
);
// Upload Student Data (Admin-only)
app.use(
  '/staff/students',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  ensureUserForViews,
  // only admin-level roles can access
  requireRole('admin', 'superadmin', 'administrator'),
  studentUploadRoutes
);


// Student (AdminLTE layout + correct sidebar role)
app.use(
  '/student',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  (req, res, next) => {
    if (!res.locals.user) res.locals.user = { name: 'User', role: 'student' };
    else res.locals.user.role = 'student';
    next();
  },
  studentRoutes
);

// ✅ Add this BEFORE routes:
app.use((req, res, next) => {
  res.locals.currentPath = req.path || '';
  next();
});

// ✅ Attendance routes (must mount before generic /staff routes)
app.use(
  '/staff/attendance',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  requireRole('staff','admin','hod','registry', 'lecturer', 'bursary'),
  attendanceRoutes
);

app.use('/staff/attendance', markAttendanceRoutes);

app.use(attendanceReportRoutes);
app.use('/staff/attendance', studentLectureVenueRoutes);
// Student attendance report route: /staff/student-attendance/report
app.use(studentAttendanceReportRoutes);


app.use(watchlistRoutes);
app.use(courseRegistrationReportRoutes);

app.use('/staff/fees', feesRoutes);

app.use('/', paymentRoutes);


// ✅ Staff routes
app.use(
  '/staff',
  ensureUserForViews,
  requireRole('staff', 'admin', 'registry', 'hod', 'lecturer', 'staff'),
  requireMenuPermission({
    base: '/staff',
    allowIfNoConfig: true,
    superRoles: ['admin', 'superadmin', 'administrator']
  }),
  staffRoutes
);


// ✅ Admin routes
app.use(
  '/staff',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  (req, res, next) => { try { res.locals.csrfToken = req.csrfToken?.() || null; } catch {} next(); },
  requireRole('staff','admin','hod','registry', 'lecturer', 'staff'),
  requireMenuPermission({
    base: '/staff',
    allowIfNoConfig: true,
    superRoles: ['admin', 'superadmin', 'administrator']
  }),
  adminRoutes
);

// app.use(
//   '/staff',
//   (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
//   (req, res, next) => { try { res.locals.csrfToken = req.csrfToken?.() || null; } catch {} next(); },
//   requireRole('staff', 'admin'),
//   requireMenuPermission({
//     base: '/staff',
//     allowIfNoConfig: true,
//     superRoles: ['admin', 'superadmin', 'administrator']
//   }),
//   adminRoutes
// );


// ✅ Academic/session/semester routes
app.use(
  '/staff/session',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  sessionRoutes
);

app.use(
  '/staff/semester',
  (req, res, next) => { res.locals.layout = 'layouts/adminlte'; next(); },
  semesterRoutes
);


// -------------------------------------------------------------
// ERROR HANDLERS
// -------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.stack || err);
  res.status(500).render('pages/error', { title: 'Server error' });
});


// -------------------------------------------------------------
// BOOTSTRAP
// -------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));

ensureAdminUser()
  .then(() => console.log('✔ Default admin ensured'))
  .catch((e) => console.error('Failed to ensure admin user:', e));
