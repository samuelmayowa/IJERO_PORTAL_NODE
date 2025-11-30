// app/web/controllers/auth.controller.js
import bcrypt from 'bcryptjs';
import { pool } from '../../core/db.js';
import { authenticate } from '../../services/user.service.js';

/** Render login page */
export function showLogin(_req, res) {
  res.render('pages/login', { title: 'Login', pageTitle: 'Login' });
}

/** Handle login, set session, and role-based redirect */
export async function doLogin(req, res) {
  try {
    const { username, password } = req.body || {};

    // 1) staff/admin authentication (existing logic)
    const user = await authenticate(username, password);
    if (!user) {
      // 2) try public_users (student/applicant)
      try {
        const [pub] = await pool.query(
          `SELECT id, role, first_name, last_name, username, password_hash
           FROM public_users
           WHERE username = ?
           LIMIT 1`,
          [username]
        );

        if (pub.length) {
          const ok = await bcrypt.compare(password, pub[0].password_hash);
          if (ok) {
            req.session.publicUser = {
              id: pub[0].id,
              username: pub[0].username,
              role: pub[0].role,
              full_name: `${pub[0].first_name || ''} ${pub[0].last_name || ''}`.trim(),
            };
            return res.redirect(
              pub[0].role === 'applicant'
                ? '/applicant/dashboard'
                : '/student/dashboard'
            );
          }
        }
      } catch (e) {
        console.error('public user login error:', e);
      }

      req.flash?.('error', 'Invalid username or password');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.id,
      name: user.fullName || user.username || 'User',
      role: (user.role || 'staff').toLowerCase(),
      roles: user.roles || [],
      username: user.username,
      email: user.email,
    };

    const r = req.session.user.role;

    if (
      [
        'superadmin',
        'administrator',
        'admin',
        'staff',
        'hod',
        'lecturer',
        'dean',
        'ict',
        'bursary',
        'registry',
        'admission officer',
        'auditor',
        'health center',
        'works',
        'library',
        'provost',
        'student union',
      ].includes(r)
    ) {
      return res.redirect('/dashboard');
    }

    if (r === 'student') return res.redirect('/student/dashboard');
    if (r === 'applicant') return res.redirect('/applicant/dashboard');

    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.flash?.('error', 'Login failed');
    return res.redirect('/login');
  }
}

/** Destroy session */
export function doLogout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

// ---- public guards ----
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
  const csrfToken =
    typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  return res.render('pages/register', {
    layout: 'layouts/site',
    title: 'Create Portal Account',
    csrfToken,
  });
}

/**
 * AJAX: student lookup by email + access_code in public_users
 */
export async function studentLookup(req, res) {
  try {
    const { email, access_code } = req.body || {};
    const emailTrim = (email || '').trim().toLowerCase();
    const codeTrim = (access_code || '').trim();

    if (!emailTrim || !codeTrim) {
      return res.status(400).json({
        ok: false,
        message: 'Please provide both Email and Access Code.',
      });
    }

    if (codeTrim.length < 8) {
      return res.status(400).json({
        ok: false,
        message: 'Access Code looks too short.',
      });
    }

    const [rows] = await pool.query(
      `
        SELECT
          id,
          role,
          first_name,
          middle_name,
          last_name,
          dob,
          state_of_origin,
          lga,
          phone,
          username,
          matric_number,
          access_code
        FROM public_users
        WHERE role = 'student'
          AND username = ?
          AND access_code = ?
        LIMIT 1
      `,
      [emailTrim, codeTrim]
    );

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message:
          'No matching student record was found. Please check your Email and Access Code.',
      });
    }

    const stu = rows[0];

    return res.json({
      ok: true,
      student: {
        id: stu.id,
        first_name: stu.first_name || '',
        middle_name: stu.middle_name || '',
        last_name: stu.last_name || '',
        dob: stu.dob || '',
        state_of_origin: stu.state_of_origin || '',
        lga: stu.lga || '',
        phone: stu.phone || '',
        email: stu.username || emailTrim,
        matric_number: stu.matric_number || '',
      },
    });
  } catch (err) {
    console.error('Error in studentLookup:', err);
    return res.status(500).json({
      ok: false,
      message:
        'Sorry, we could not verify your details right now. Please try again.',
    });
  }
}

// REGISTER
export async function postRegister(req, res) {
  try {
    const {
      role,
      first_name,
      middle_name,
      last_name,
      dob,
      state_of_origin,
      lga,
      phone,
      email,
      username,
      password,
      access_code,
      agree,
      _preview,
    } = req.body || {};

    if (!role || !['student', 'applicant'].includes(role)) {
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
    if (!password || password.trim().length < 8) {
      req.flash('error', 'Password must be at least 8 characters long.');
      return res.redirect('/register');
    }

    const emailLower = email.trim().toLowerCase();
    const usernameFinal = (username || emailLower).trim().toLowerCase();
    const phoneTrim = (phone || '').trim();
    const dobTrim = (dob || '').trim();
    const firstTrim = (first_name || '').trim();
    const middleTrim = (middle_name || '').trim() || null;
    const lastTrim = (last_name || '').trim();

    const password_hash = await bcrypt.hash(password.trim(), 10);

    // ---------- STUDENT REGISTRATION ----------
    if (role === 'student') {
      const codeTrim = (access_code || '').trim();

      if (!codeTrim || codeTrim.length < 8) {
        req.flash(
          'error',
          'A valid Access Code is required for Student registration.'
        );
        return res.redirect('/register');
      }

      // get existing student row INCLUDING state_of_origin, lga, dob, phone
      const [rows] = await pool.query(
        `
          SELECT
            id,
            role,
            first_name,
            middle_name,
            last_name,
            username,
            matric_number,
            state_of_origin,
            lga,
            dob,
            phone
          FROM public_users
          WHERE role = 'student'
            AND username = ?
            AND access_code = ?
          LIMIT 1
        `,
        [emailLower, codeTrim]
      );

      if (!rows.length) {
        req.flash(
          'error',
          'Email and Access Code do not match any student record. Please check and try again.'
        );
        return res.redirect('/register');
      }

      const student = rows[0];

      // username uniqueness (excluding this row)
      const [dup] = await pool.query(
        'SELECT id FROM public_users WHERE username = ? AND id <> ? LIMIT 1',
        [usernameFinal, student.id]
      );
      if (dup.length) {
        req.flash(
          'error',
          'Sorry, that username is already in use. Please choose another one.'
        );
        return res.redirect('/register');
      }

      // UPDATE — keep original state_of_origin / lga / dob / phone if body doesn't send them
      await pool.query(
        `
          UPDATE public_users
          SET
            first_name      = ?,
            middle_name     = ?,
            last_name       = ?,
            dob             = ?,
            state_of_origin = ?,
            lga             = ?,
            phone           = ?,
            username        = ?,
            password_hash   = ?,
            status          = 'ACTIVE'
          WHERE id = ?
        `,
        [
          firstTrim || student.first_name,
          middleTrim || student.middle_name,
          lastTrim || student.last_name,
          dobTrim || student.dob || null,
          state_of_origin || student.state_of_origin || null,
          lga || student.lga || null,
          phoneTrim || student.phone || null,
          usernameFinal,
          password_hash,
          student.id,
        ]
      );

      req.session.publicUser = {
        id: student.id,
        username: usernameFinal,
        role: 'student',
        full_name: `${firstTrim || student.first_name || ''} ${
          lastTrim || student.last_name || ''
        }`.trim(),
      };

      const next = '/student/dashboard';
      return res
        .status(200)
        .render('pages/register-success', {
          layout: false,
          title: 'Registration Successful',
          next,
          full_name: `${firstTrim || student.first_name || ''} ${
            lastTrim || student.last_name || ''
          }`.trim(),
        });
    }

    // ---------- APPLICANT REGISTRATION ----------
    const [u1] = await pool.query(
      `SELECT id FROM public_users WHERE username = ? LIMIT 1`,
      [usernameFinal]
    );
    if (u1.length) {
      req.flash('error', 'Username is already taken.');
      return res.redirect('/register');
    }

    const [ins] = await pool.query(
      `
      INSERT INTO public_users
      (role, first_name, middle_name, last_name, dob, state_of_origin, lga, phone, username, password_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `,
      [
        'applicant',
        firstTrim,
        middleTrim,
        lastTrim,
        dobTrim || null,
        state_of_origin || null,
        lga || null,
        phoneTrim || null,
        usernameFinal,
        password_hash,
      ]
    );

    req.session.publicUser = {
      id: ins.insertId,
      username: usernameFinal,
      role,
      full_name: `${firstTrim} ${lastTrim}`.trim(),
    };

    const next = '/applicant/dashboard';
    return res.status(200).render('pages/register-success', {
      layout: false,
      title: 'Registration Successful',
      next,
      full_name: `${firstTrim || ''} ${lastTrim || ''}`.trim(),
    });
  } catch (e) {
    console.error('register error:', e);
    req.flash('error', 'Could not register. Try again.');
    return res.redirect('/register');
  }
}

// ---------- Student Password Reset ----------
export function showStudentReset(req, res) {
  const csrfToken =
    typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  return res.render('pages/student-reset', {
    layout: 'layouts/site',
    title: 'Reset Password (Student)',
    csrfToken,
  });
}

export async function postStudentReset(req, res) {
  try {
    const { role, surname, dob, phone } = req.body || {};
    const roleSafe = role === 'applicant' ? 'applicant' : 'student';

    if (!surname || !dob || !phone) {
      req.flash('error', 'Provide surname, date of birth and phone.');
      return res.redirect('/student/reset');
    }

    const [rows] = await pool.query(
      `
      SELECT id FROM public_users
      WHERE role = ? AND last_name = ? AND dob = ? AND phone = ?
      LIMIT 1
    `,
      [roleSafe, surname.trim(), dob, phone.trim()]
    );

    if (!rows.length) {
      req.flash('error', 'We could not verify your details.');
      return res.redirect('/student/reset');
    }

    const pw = await bcrypt.hash('College1', 10);
    await pool.query(
      `UPDATE public_users SET password_hash = ? WHERE id = ?`,
      [pw, rows[0].id]
    );

    return res.render('pages/register-success', {
      layout: false,
      title: 'Password Reset Successful',
      headingIcon: 'fa-unlock-alt',
      headingText: 'Password Reset Successful',
      messageHtml:
        'Password for your <b>' +
        roleSafe +
        '</b> account has been reset to <code>College1</code>.<br/>Use your username and this temporary password to sign in, then change it immediately.',
      primaryHref: '/login',
      primaryLabel: 'Go to Login',
      secondaryHref: '/',
      secondaryLabel: 'Homepage',
    });
  } catch (e) {
    console.error('reset error:', e);
    req.flash('error', 'Could not reset password.');
    return res.redirect('/student/reset');
  }
}

// ---------- Public dashboards (placeholders) ----------
export async function studentDashboard(req, res) {
  const [sessRows] = await pool.query(
    `SELECT name FROM sessions WHERE is_current = 1 LIMIT 1`
  );
  const [semRows] = await pool.query(
    `SELECT name FROM semesters WHERE is_current = 1 LIMIT 1`
  );

  return res.render('pages/student-dashboard', {
    layout: 'layouts/adminlte',
    _role: 'student',
    _user: {
      full_name: req.session?.publicUser?.full_name || 'Student',
    },
    allowedModules: [],
    currentPath: req.path || '',
    currentSession: sessRows[0] || null,
    currentSemester: semRows[0] || null,
    totalPaid: 0,
    totalRegisteredCourses: 0,
  });
}

export async function applicantDashboard(req, res) {
  const [sessRows] = await pool.query(
    `SELECT name FROM sessions WHERE is_current = 1 LIMIT 1`
  );

  return res.render('pages/applicant-dashboard', {
    layout: 'layouts/adminlte',
    _role: 'applicant',
    _user: {
      full_name: req.session?.publicUser?.full_name || 'Applicant',
    },
    allowedModules: [],
    currentPath: req.path || '',
    currentSession: sessRows[0] || null,
    totalPaid: 0,
    pendingActions: 0,
    notices: 0,
  });
}

/* Legacy export names used in routes */
export { showLogin as getLogin };
export { doLogin as postLogin };
export { doLogout as logout };
