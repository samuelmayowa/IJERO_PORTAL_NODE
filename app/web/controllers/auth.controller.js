// app/web/controllers/auth.controller.js
import bcrypt from 'bcryptjs';
import { pool } from '../../core/db.js';
import { authenticate } from '../../services/user.service.js';

/** Render login page */
export function showLogin(_req, res) {
  res.render('pages/login', { title: 'Login', pageTitle: 'Login' });
}

/* -------------------- helpers for dashboard -------------------- */
const _columnsCache = new Map();

async function getTableColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);

  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME AS name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
    `,
    [tableName]
  );

  const set = new Set((rows || []).map((r) => r.name));
  _columnsCache.set(tableName, set);
  return set;
}

function mapSemesterNameToKey(semesterName) {
  const n = String(semesterName || '').trim().toLowerCase();
  if (n.startsWith('first')) return 'FIRST';
  if (n.startsWith('second')) return 'SECOND';
  if (n.startsWith('summer')) return 'SUMMER';
  return String(semesterName || '').trim().toUpperCase();
}

async function getCurrentSessionAndSemester() {
  const [sessRows] = await pool.query(
    `SELECT id, name FROM sessions WHERE is_current = 1 LIMIT 1`
  );
  const [semRows] = await pool.query(
    `SELECT id, name FROM semesters WHERE is_current = 1 LIMIT 1`
  );

  const currentSession = sessRows?.[0] || null;
  const currentSemester = semRows?.[0] || null;

  return {
    currentSession,
    currentSemester,
    semesterKey: mapSemesterNameToKey(currentSemester?.name),
  };
}

async function enrichWithCourseDetails(items, courseIdGetter) {
  const list = Array.isArray(items) ? items : [];
  const ids = Array.from(
    new Set(list.map(courseIdGetter).filter((v) => v !== null && v !== undefined))
  );

  if (!ids.length) return list;

  let cols;
  try {
    cols = await getTableColumns('courses');
  } catch {
    return list;
  }

  const codeCol = cols.has('code')
    ? 'code'
    : cols.has('course_code')
      ? 'course_code'
      : null;

  const titleCol = cols.has('title')
    ? 'title'
    : cols.has('name')
      ? 'name'
      : cols.has('course_title')
        ? 'course_title'
        : null;

  if (!codeCol && !titleCol) return list;

  const selectParts = ['id'];
  selectParts.push(codeCol ? `${codeCol} AS course_code` : `NULL AS course_code`);
  selectParts.push(titleCol ? `${titleCol} AS course_title` : `NULL AS course_title`);

  const [rows] = await pool.query(
    `SELECT ${selectParts.join(', ')} FROM courses WHERE id IN (?)`,
    [ids]
  );

  const map = new Map();
  (rows || []).forEach((r) => map.set(r.id, r));

  return list.map((x) => {
    const cid = courseIdGetter(x);
    const c = map.get(cid);
    return {
      ...x,
      course_code: c?.course_code ?? null,
      course_title: c?.course_title ?? null,
    };
  });
}
/* ------------------ end helpers for dashboard ------------------ */

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
          `SELECT id, role, first_name, middle_name, last_name, username, matric_number, password_hash
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
              matric_number: pub[0].matric_number || null,
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
        matric_number: student.matric_number || null,
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
      matric_number: null,
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

/* -------------------- DYNAMIC student dashboard -------------------- */
export async function studentDashboard(req, res) {
  const publicUser = req.session?.publicUser || null;
  if (!publicUser || publicUser.role !== 'student') return res.redirect('/login');

  const studentId = publicUser.id;

  const { currentSession, currentSemester, semesterKey } =
    await getCurrentSessionAndSemester();

  let totalRegisteredCourses = 0;
  let recentCourseRegistrations = [];

  if (studentId && currentSession?.id && semesterKey) {
    const [cnt] = await pool.query(
      `
        SELECT COUNT(*) AS total
        FROM student_course_regs
        WHERE student_id = ?
          AND session_id = ?
          AND semester = ?
          AND status = 'SUBMITTED'
      `,
      [studentId, currentSession.id, semesterKey]
    );
    totalRegisteredCourses = Number(cnt?.[0]?.total || 0);

    const [regs] = await pool.query(
      `
        SELECT id, course_id, units, status, created_at
        FROM student_course_regs
        WHERE student_id = ?
          AND session_id = ?
          AND semester = ?
          AND status = 'SUBMITTED'
        ORDER BY created_at DESC
        LIMIT 4
      `,
      [studentId, currentSession.id, semesterKey]
    );

    recentCourseRegistrations = await enrichWithCourseDetails(
      regs || [],
      (r) => r.course_id
    );
  }

  let recentAttendance = [];
  if (studentId) {
    const [att] = await pool.query(
      `
        SELECT id, course_id, status, check_in_at, created_at
        FROM student_attendance_records
        WHERE student_id = ?
        ORDER BY COALESCE(check_in_at, created_at) DESC
        LIMIT 4
      `,
      [studentId]
    );

    recentAttendance = await enrichWithCourseDetails(att || [], (a) => a.course_id);
  }

  let photo_path = null;
  try {
    const [rows] = await pool.query(
      `SELECT file_path
       FROM student_photos
       WHERE student_id = ? AND photo_type = 'PROFILE'
       ORDER BY uploaded_at DESC
       LIMIT 1`,
      [studentId]
    );
    photo_path = rows?.[0]?.file_path || null;
  } catch {}

  let totalPayable = 0;
  let totalPaid = 0;
  let payableBreakdown = { school: 0, faculty: 0, application: 0 };
  let paymentsBreakdown = { school: 0, faculty: 0, application: 0 };
  let paymentSummaryRows = [];
  let recentPayments = [];

  try {
    if (studentId) {
      const [[stu]] = await pool.query(
        `
          SELECT
            pu.state_of_origin,
            pu.matric_number,
            pu.username,
            pu.phone,
            sp.school_id AS profile_school_id,
            s.name AS profile_school_name,
            sp.level AS profile_level
          FROM public_users pu
          LEFT JOIN student_profiles sp
            ON sp.user_id = pu.id
          LEFT JOIN schools s
            ON s.id = sp.school_id
          WHERE pu.id = ?
          LIMIT 1
        `,
        [studentId]
      );

      const [[imp]] = await pool.query(
        `
          SELECT
            school,
            level,
            student_level
          FROM student_imports
          WHERE matric_number = ?
             OR student_email = ?
          ORDER BY id DESC
          LIMIT 1
        `,
        [
          stu?.matric_number || publicUser?.matric_number || '',
          stu?.username || publicUser?.username || ''
        ]
      );

      let studentSchoolId = Number(stu?.profile_school_id || 0);

      if (!studentSchoolId) {
        const fallbackSchoolName =
          String(stu?.profile_school_name || imp?.school || '').trim();

        if (fallbackSchoolName) {
          const [[sch]] = await pool.query(
            `SELECT id FROM schools WHERE TRIM(name) = ? LIMIT 1`,
            [fallbackSchoolName]
          );
          studentSchoolId = Number(sch?.id || 0);
        }
      }

      const stateOfOrigin =
        stu?.state_of_origin ||
        publicUser?.state_of_origin ||
        '';

      const isIndigene =
        String(stateOfOrigin).trim().toLowerCase() === 'ekiti';

      const rawLevel =
        stu?.profile_level ||
        imp?.student_level ||
        imp?.level ||
        '';

      const levelAliases = (() => {
        const v = String(rawLevel || '').trim().toUpperCase();
        const set = new Set();
        if (!v) return [];
        set.add(v);

        if (v === '100') set.add('ND1');
        if (v === '200') set.add('ND2');
        if (v === '300') { set.add('ND3'); set.add('HND1'); }
        if (v === '400') set.add('HND2');
        if (v === '500') set.add('HND3');

        if (v === 'ND1') set.add('100');
        if (v === 'ND2') set.add('200');
        if (v === 'ND3') set.add('300');
        if (v === 'HND1') set.add('300');
        if (v === 'HND2') set.add('400');
        if (v === 'HND3') set.add('500');

        return Array.from(set);
      })();

      const categorizePayment = (name, purpose) => {
        const txt = `${name || ''} ${purpose || ''}`.toLowerCase();
        if (
          txt.includes('application') ||
          txt.includes('admission') ||
          txt.includes('utme') ||
          txt.includes('form')
        ) return 'application';
        if (txt.includes('faculty')) return 'faculty';
        return 'school';
      };

      const [ptRows] = await pool.query(
        `
          SELECT
            pt.*,
            pts.session_id AS matched_session_id,
            pts.semester AS matched_semester,
            psch.school_id AS matched_school_id,
            pr.entry_level,
            pr.current_level,
            pr.admission_session_id,
            pr.amount_override
          FROM payment_types pt
          LEFT JOIN payment_type_sessions pts
            ON pts.payment_type_id = pt.id
          LEFT JOIN payment_type_schools psch
            ON psch.payment_type_id = pt.id
          LEFT JOIN payment_type_rules pr
            ON pr.payment_type_id = pt.id
          WHERE pt.is_active = 1
            AND (
              NOT EXISTS (
                SELECT 1
                FROM payment_type_sessions ptsx
                WHERE ptsx.payment_type_id = pt.id
              )
              OR (
                pts.session_id = ?
                AND (
                  pts.semester IS NULL
                  OR TRIM(COALESCE(pts.semester, '')) = ''
                  OR UPPER(COALESCE(pts.semester, '')) = 'ALL'
                  OR UPPER(COALESCE(pts.semester, '')) = ?
                )
              )
            )
            AND (
              UPPER(COALESCE(pt.scope, '')) IN ('SCHOOL', 'BY SCHOOL', 'BY_SCHOOL')
              AND ? > 0
              AND psch.school_id = ?
            )
          ORDER BY pt.name ASC, pt.id DESC
        `,
        [
          currentSession?.id || 0,
          String(semesterKey || '').toUpperCase(),
          studentSchoolId,
          studentSchoolId
        ]
      );

      console.log('DASHBOARD_PAYMENT_DEBUG', {
        studentId,
        matric: stu?.matric_number || publicUser?.matric_number || '',
        stateOfOrigin,
        isIndigene,
        studentSchoolId,
        profileSchoolId: stu?.profile_school_id || null,
        profileSchoolName: stu?.profile_school_name || null,
        importSchool: imp?.school || null,
        rawLevel,
        levelAliases,
        currentSessionId: currentSession?.id || 0,
        semesterKey: String(semesterKey || '').toUpperCase(),
        matchedRows: (ptRows || []).map(r => ({
          id: r.id,
          name: r.name,
          purpose: r.purpose,
          scope: r.scope,
          matched_session_id: r.matched_session_id,
          matched_semester: r.matched_semester,
          matched_school_id: r.matched_school_id,
          entry_level: r.entry_level,
          current_level: r.current_level,
          amount: r.amount,
          amount_indigene: r.amount_indigene,
          amount_non_indigene: r.amount_non_indigene,
          uses_indigene_regime: r.uses_indigene_regime
        }))
      });

      const grouped = new Map();

      for (const row of (ptRows || [])) {
        if (!grouped.has(row.id)) {
          grouped.set(row.id, {
            base: row,
            rules: []
          });
        }

        const hasRule =
          row.entry_level != null ||
          row.current_level != null ||
          row.admission_session_id != null ||
          row.amount_override != null;

        if (hasRule) {
          grouped.get(row.id).rules.push({
            entry_level: row.entry_level,
            current_level: row.current_level,
            admission_session_id: row.admission_session_id,
            amount_override: row.amount_override
          });
        }
      }

      totalPayable = 0;
      payableBreakdown = { school: 0, faculty: 0, application: 0 };
      paymentSummaryRows = [];

      for (const { base, rules } of grouped.values()) {
        let matchedRule = null;

        if (rules.length) {
          matchedRule = rules.find((r) => {
            const entryOk =
              !r.entry_level ||
              levelAliases.includes(String(r.entry_level).trim().toUpperCase());

            const currentOk =
              !r.current_level ||
              levelAliases.includes(String(r.current_level).trim().toUpperCase());

            return entryOk && currentOk;
          });

          if (!matchedRule) continue;
        }

        let amount = Number(
          Number(base.uses_indigene_regime || 0)
            ? (isIndigene ? base.amount_indigene : base.amount_non_indigene)
            : base.amount
        ) || 0;

        if (matchedRule && matchedRule.amount_override != null && matchedRule.amount_override !== '') {
          amount = Number(matchedRule.amount_override) || amount;
        }

        const category = categorizePayment(base.name, base.purpose);

        totalPayable += amount;
        payableBreakdown[category] += amount;

        paymentSummaryRows.push({
          payment_type_id: base.id,
          name: base.name,
          purpose: base.purpose,
          amount,
          category
        });
      }

      const payeeA = stu?.matric_number || publicUser?.matric_number || '';
      const payeeB = stu?.username || publicUser?.username || '';
      const payeeC = stu?.phone || publicUser?.phone || '';
      const payeeD = String(studentId);

      const [paidRows] = await pool.query(
        `
          SELECT purpose, amount
          FROM payment_invoices
          WHERE status = 'PAID'
            AND payee_id IN (?, ?, ?, ?)
        `,
        [payeeA, payeeB, payeeC, payeeD]
      );

      totalPaid = 0;
      paymentsBreakdown = { school: 0, faculty: 0, application: 0 };

      for (const row of (paidRows || [])) {
        const amt = Number(row.amount || 0);
        const category = categorizePayment('', row.purpose || '');
        totalPaid += amt;
        paymentsBreakdown[category] += amt;
      }

      const [recentRows] = await pool.query(
        `
          SELECT
            rrr,
            purpose,
            amount,
            status,
            DATE(COALESCE(paid_at, created_at)) AS date
          FROM payment_invoices
          WHERE payee_id IN (?, ?, ?, ?)
          ORDER BY id DESC
          LIMIT 4
        `,
        [payeeA, payeeB, payeeC, payeeD]
      );

      recentPayments = recentRows || [];
    }
  } catch (err) {
    console.error('Error building payment dashboard data:', err);
  }

  return res.render('pages/student-dashboard', {
    layout: 'layouts/adminlte',
    _role: 'student',
    _user: { full_name: publicUser.full_name || 'Student' },
    user: res.locals.user || publicUser || null,
    publicUser,
    photo_path,

    allowedModules: [],
    currentPath: req.path || '',
    currentSession: currentSession || null,
    currentSemester: currentSemester || null,

    totalPayable,
    totalPaid,
    payableBreakdown,
    paymentsBreakdown,
    paymentSummaryRows,
    recentPayments,

    totalRegisteredCourses,
    recentCourseRegistrations,
    recentAttendance,
  });
}
export async function studentPaymentHistory(req, res) {
  const publicUser = req.session?.publicUser || null;
  if (!publicUser) return res.redirect('/login');

  const studentId = publicUser?.id || null;

  let photo_path = null;
  let payments = [];

  try {
    const [profileRows] = await pool.query(
      `
        SELECT sp.photo_path, sp.phone, pu.username, pu.matric_number
        FROM public_users pu
        LEFT JOIN student_profiles sp
          ON sp.user_id = pu.id
        WHERE pu.id = ?
        LIMIT 1
      `,
      [studentId]
    );

    const stu = profileRows?.[0] || null;
    photo_path = stu?.photo_path || null;

    const payeeA = stu?.matric_number || publicUser?.matric_number || '';
    const payeeB = stu?.username || publicUser?.username || '';
    const payeeC = stu?.phone || publicUser?.phone || '';
    const payeeD = String(studentId || '');

    const [rows] = await pool.query(
  `
      SELECT
        order_id,
        rrr,
        purpose,
        amount,
        portal_charge,
        status,
        DATE(COALESCE(paid_at, created_at)) AS date
      FROM payment_invoices
      WHERE payee_id IN (?, ?, ?, ?)
      ORDER BY id DESC
    `,
    [payeeA, payeeB, payeeC, payeeD]
  );

    payments = rows || [];
  } catch (err) {
    console.error('Error loading student payment history:', err);
  }

  return res.render('pages/student-payment-history', {
    layout: 'layouts/adminlte',
    _role: 'student',
    _user: { full_name: publicUser.full_name || 'Student' },
    user: res.locals.user || publicUser || null,
    publicUser,
    photo_path,
    allowedModules: [],
    currentPath: req.path || '',
    payments
  });
}

/* ------------------ end dynamic student dashboard ------------------ */

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
