// app/web/controllers/auth.controller.js
import { authenticate } from '../../services/user.service.js';

/** Render login page */
export function showLogin(_req, res) {
  // Do NOT force a layout; /login is not under any AdminLTE-scoped router,
  // so it will render with the public/default layout used by your site pages.
  res.render('pages/login', { title: 'Login', pageTitle: 'Login' });
}



/** Handle login, set session, and role-based redirect */
export async function doLogin(req, res) {
  try {
    const { username, password } = req.body || {};
    const user = await authenticate(username, password);
    if (!user) {
      req.flash?.('error', 'Invalid username or password');
      return res.redirect('/login');
    }

    // Minimal session payload for views/middleware
    // NOTE: user.fullName comes from user.service.js (not full_name)
    req.session.user = {
      id: user.id,
      name: user.fullName || user.username || 'User',
      role: (user.role || 'staff').toLowerCase(),   // primary role resolved in user.service.js
      roles: user.roles || [],
      username: user.username,
      email: user.email,
    };

    const r = req.session.user.role;

    // Staff-like roles → role-aware /dashboard (mapped by roles.routes.js)
    if ([
      'superadmin','administrator','admin','staff','hod','lecturer','dean','ict','bursary','registry',
      'admission officer','auditor','health center','works','library','provost','student union'
    ].includes(r)) {
      return res.redirect('/dashboard'); // CHANGED from /staff
    }

    // Students & applicants keep their dedicated dashboards
    if (r === 'student')   return res.redirect('/student/dashboard');
    if (r === 'applicant') return res.redirect('/applicant/dashboard');

    // Fallback (unknown role) → role-aware redirect
    return res.redirect('/dashboard'); // CHANGED from /staff
  } catch (err) {
    console.error('Login error:', err);
    req.flash?.('error', 'Login failed');
    return res.redirect('/login');
  }
}

/** Destroy session and go to login */
export function doLogout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

/* ---- Legacy export names expected by app/web/routes/auth.routes.js ---- */
export { showLogin as getLogin };
export { doLogin   as postLogin };
export { doLogout  as logout };
