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

    // 1) Try your existing staff/admin authentication first
    const user = await authenticate(username, password);
    if (!user) {
      // 2) ---- try public portal users (student/applicant) before failing ----
      try {
        // Look up public user
        const [pub] = await pool.query(
          `SELECT id, role, first_name, last_name, username, password_hash
           FROM public_users WHERE username = ? LIMIT 1`,
          [username]
        );

        if (pub.length) {
          const ok = await bcrypt.compare(password, pub[0].password_hash);
          if (ok) {
            req.session.publicUser = {
              id: pub[0].id,
              username: pub[0].username,
              role: pub[0].role,
              full_name: `${pub[0].first_name || ''} ${pub[0].last_name || ''}`.trim()
            };
            return res.redirect(
              pub[0].role === 'applicant' ? '/applicant/dashboard' : '/student/dashboard'
            );
          }
        }
      } catch (e) {
        console.error('public user login error:', e);
      }

      // 3) If we got here, both staff/admin and public user failed
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
      return res.redirect('/dashboard'); // mapped dashboard for staff-like roles
    }

    // Students & applicants keep their dedicated dashboards
    if (r === 'student')   return res.redirect('/student/dashboard');
    if (r === 'applicant') return res.redirect('/applicant/dashboard');

    // Fallback (unknown role) → role-aware redirect
    return res.redirect('/dashboard');
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

import bcrypt from 'bcryptjs';
import { pool } from '../../core/db.js'; // adjust path if needed

// helper: public dashboards’ session gate
function requirePublic(role) {
  return (req, res, next) => {
    if (!req.session?.publicUser || (role && req.session.publicUser.role !== role)) {
      return res.redirect('/login');
    }
    res.locals.publicUser = req.session.publicUser;
    next();
  };
}
// --- add (or keep) these lightweight public guards ---
export function requireStudent(req, res, next) {
  if (req.session?.publicUser?.role === 'student') return next();
  return res.redirect('/login');
}
export function requireApplicant(req, res, next) {
  if (req.session?.publicUser?.role === 'applicant') return next();
  return res.redirect('/login');
}


// ---------- Register ----------
export async function showRegister(req, res) {
  const csrfToken = (typeof req.csrfToken === 'function') ? req.csrfToken() : '';
  return res.render('pages/register', { layout: 'layouts/site', title: 'Create Portal Account', csrfToken });
}

// REGISTER — email as username, Access Code gate for students
export async function postRegister(req, res) {
  try {
    const {
      role, first_name, middle_name, last_name, dob,
      state_of_origin, lga, phone, email, username, password,
      access_code, agree, _preview
    } = req.body || {};

    if (!role || !['student','applicant'].includes(role)) {
      req.flash('error', 'Please choose Applicant or Student.');
      return res.redirect('/register');
    }
    if (_preview !== '1') {
      req.flash('error', 'Please click Preview, then Submit.');
      return res.redirect('/register');
    }
    if (!agree) {
      req.flash('error', 'Please accept the terms and conditions.');
      return res.redirect('/register');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      req.flash('error', 'Please enter a valid email address.');
      return res.redirect('/register');
    }

    // If Student: Access Code must be valid & unused
    if (role === 'student') {
      if (!access_code || !/^[A-Za-z0-9]{16}$/.test(access_code)) {
        req.flash('error', 'A valid 16-character Access Code is required for Student registration.');
        return res.redirect('/register');
      }
      const [ac] = await pool.query(`SELECT code, used_by FROM access_codes WHERE code=? AND role='student' LIMIT 1`, [access_code]);
      if (!ac.length) {
        req.flash('error', 'Access Code not found.');
        return res.redirect('/register');
      }
      if (ac[0].used_by) {
        req.flash('error', 'This Access Code has already been used.');
        return res.redirect('/register');
      }
    }

    const usernameFinal = (username || email).trim().toLowerCase();

    const [u1] = await pool.query(`SELECT id FROM public_users WHERE username=? LIMIT 1`, [usernameFinal]);
    if (u1.length) {
      req.flash('error', 'Username is already taken.');
      return res.redirect('/register');
    }

    const password_hash = await bcrypt.hash(password, 10);
    const [ins] = await pool.query(`
      INSERT INTO public_users
      (role, first_name, middle_name, last_name, dob, state_of_origin, lga, phone, username, password_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [
      role, first_name?.trim(), middle_name?.trim() || null, last_name?.trim(),
      dob, state_of_origin, lga, phone, usernameFinal, password_hash
    ]);

    // If Student, mark access code used
    if (role === 'student' && access_code) {
      await pool.query(`UPDATE access_codes SET used_by=?, used_at=NOW() WHERE code=?`, [ins.insertId, access_code]);
    }

    req.session.publicUser = {
      username: usernameFinal,
      role,
      full_name: `${first_name} ${last_name}`.trim()
    };

    const next = role === 'applicant' ? '/applicant/dashboard' : '/student/dashboard';
    return res.status(200).render('pages/register-success', {
    layout: false,
      title: 'Registration Successful',
      next,
      full_name: `${first_name || ''} ${last_name || ''}`.trim()
    });

  } catch (e) {
    console.error('register error:', e);
    req.flash('error', 'Could not register. Try again.');
    return res.redirect('/register');
  }
}


// ---------- Student Password Reset ----------
export function showStudentReset(req, res) {
  const csrfToken = (typeof req.csrfToken === 'function') ? req.csrfToken() : '';
  return res.render('pages/student-reset', { layout: 'layouts/site', title: 'Reset Password (Student)', csrfToken });
}

// RESET — supports student or applicant via role field
export async function postStudentReset(req, res) {
  try {
    const { role, surname, dob, phone } = req.body || {};
    const roleSafe = (role === 'applicant') ? 'applicant' : 'student';

    if (!surname || !dob || !phone) {
      req.flash('error', 'Provide surname, date of birth and phone.');
      return res.redirect('/student/reset');
    }
    const [rows] = await pool.query(`
      SELECT id FROM public_users
      WHERE role=? AND last_name=? AND dob=? AND phone=?
      LIMIT 1
    `, [roleSafe, surname.trim(), dob, phone.trim()]);

    if (!rows.length) {
      req.flash('error', 'We could not verify your details.');
      return res.redirect('/student/reset');
    }

    const pw = await bcrypt.hash('College1', 10);
    await pool.query(`UPDATE public_users SET password_hash=? WHERE id=?`, [pw, rows[0].id]);

    // OLD (your file): flashed + redirect to /login (which you couldn't see). :contentReference[oaicite:0]{index=0}
    // NEW: render a success page with two buttons (Login/Homepage) reusing register-success.ejs
    return res.render('pages/register-success', {
      layout: false, // stand-alone page (prevents nested layout / "scatter")
      title: 'Password Reset Successful',
      headingIcon: 'fa-unlock-alt',
      headingText: 'Password Reset Successful',
      messageHtml: `Password for your <b>${roleSafe}</b> account has been reset to <code>College1</code>.<br/>Use your username and this temporary password to sign in, then change it immediately.`,
      primaryHref: '/login',
      primaryLabel: 'Go to Login',
      secondaryHref: '/',
      secondaryLabel: 'Homepage'
    });
  } catch (e) {
    console.error('reset error:', e);
    req.flash('error', 'Could not reset password.');
    return res.redirect('/student/reset');
  }
}

// ---------- Public dashboards (placeholders) ----------
export async function studentDashboard(req, res) {
  const [sessRows] = await pool.query(`SELECT name FROM sessions WHERE is_current=1 LIMIT 1`);
  const [semRows]  = await pool.query(`SELECT name FROM semesters WHERE is_current=1 LIMIT 1`);

  return res.render('pages/student-dashboard', {
    layout: 'layouts/adminlte',
    _role: 'student',
    _user: { full_name: (req.session?.publicUser?.full_name || 'Student') },
    allowedModules: [],
    currentPath: req.path || '',
    currentSession: sessRows[0] || null,
    currentSemester: semRows[0] || null,
    totalPaid: 0,
    totalRegisteredCourses: 0
  });
}

export async function applicantDashboard(req, res) {
  const [sessRows] = await pool.query(`SELECT name FROM sessions WHERE is_current=1 LIMIT 1`);

  return res.render('pages/applicant-dashboard', {
    layout: 'layouts/adminlte',
    _role: 'applicant',
    _user: { full_name: (req.session?.publicUser?.full_name || 'Applicant') },
    allowedModules: [],
    currentPath: req.path || '',
    currentSession: sessRows[0] || null,
    totalPaid: 0,
    pendingActions: 0,
    notices: 0
  });
}

/* ---- Legacy export names expected by app/web/routes/auth.routes.js ---- */
export { showLogin as getLogin };
export { doLogin   as postLogin };
export { doLogout  as logout };
