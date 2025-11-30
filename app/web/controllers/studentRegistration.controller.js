// app/web/controllers/studentRegistration.controller.js

import crypto from 'crypto';
import pool from '../../core/db.js';

const MAX_UNITS_PER_SEMESTER = 35;

/**
 * Helper: current logged-in student (public_users row)
 */
async function getCurrentStudent(req) {
  const publicUserId = req.session?.publicUser?.id;
  if (!publicUserId) return null;

  const [rows] = await pool.query(
    'SELECT * FROM public_users WHERE id = ? LIMIT 1',
    [publicUserId],
  );
  return rows[0] || null;
}

/**
 * Helper: list sessions (or academic sessions).
 * Adapt query to match your sessions table.
 */
async function getSessions() {
  // If your table name/columns differ, adjust here.
  const [rows] = await pool.query(
    'SELECT id, name, is_current FROM sessions ORDER BY id DESC',
  );
  return rows;
}

/**
 * Helper: get summary of registrations for student/session/semester
 */
async function getRegistrationSummary(studentId, sessionId, semester) {
  const [rows] = await pool.query(
    `
    SELECT
      r.id,
      c.id           AS course_id,
      c.code         AS course_code,
      c.title        AS course_title,
      c.unit         AS course_unit,
      c.level        AS course_level,
      c.semester     AS course_semester,
      r.reg_type,
      r.status
    FROM student_course_regs r
    JOIN courses c ON c.id = r.course_id
    WHERE
      r.student_id = ?
      AND r.session_id = ?
      AND r.semester = ?
    ORDER BY c.code
    `,
    [studentId, sessionId, semester],
  );

  const totalUnits = rows.reduce((sum, row) => sum + (row.course_unit || 0), 0);
  const totalCourses = rows.length;
  const isLocked = rows.some((row) => row.status === 'SUBMITTED');

  return { rows, totalUnits, totalCourses, isLocked };
}

/**
 * NEW: Helper – read student profile status
 * We use this to gate course registration until profile is COMPLETE.
 */
async function getProfileStatus(userId) {
  const [rows] = await pool.query(
    'SELECT status FROM student_profiles WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return rows[0]?.status || null;
}

/**
 * GET /student/registration
 * Main course registration page
 */

// NEW: Fetch extended student profile details
async function getStudentProfile(userId) {
  const [rows] = await pool.query(
    `SELECT department_id, programme_id, level, photo_path 
     FROM student_profiles WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function showCourseRegistrationPage(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      req.flash('error', 'You must be logged in as a student to register courses.');
      return res.redirect('/login');
    }

    const sessions = await getSessions();
    const defaultSession =
      sessions.find((s) => s.is_current === 'YES' || s.is_current === 1) ||
      sessions[0] ||
      null;

    const semesters = [
      { value: 'FIRST', label: 'First Semester' },
      { value: 'SECOND', label: 'Second Semester' },
    ];

    const profileStatus = await getProfileStatus(student.id);
    const profileComplete = profileStatus === 'COMPLETE';

    return res.render('student/registration', {
      title: 'Course Registration',
      student,
      sessions,
      semesters,
      defaultSessionId: defaultSession ? defaultSession.id : null,
      profileStatus,
      profileComplete,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    console.error('showCourseRegistrationPage error:', err);
    req.flash('error', 'Could not load course registration page.');
    return res.redirect('/student/dashboard');
  }
}

/**
 * GET /student/registration/api/course?code=...&semester=...
 * Look up course for given code & semester.
 */
export async function apiFindCourseByCode(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, message: 'Not authenticated.' });
    }

    const codeRaw = (req.query.code || '').trim();
    const semester = (req.query.semester || '').trim().toUpperCase();

    if (!codeRaw || !semester) {
      return res
        .status(400)
        .json({ ok: false, message: 'Course code and semester are required.' });
    }

    const code = codeRaw.toUpperCase();

    const [rows] = await pool.query(
      `
      SELECT
        c.id,
        c.code,
        c.title,
        c.unit,
        c.level,
        c.semester,
        COALESCE(st.full_name, 'Not Assigned') AS lecturer
      FROM courses c
      LEFT JOIN course_assignments ca
        ON ca.course_id = c.id
      LEFT JOIN staff st
        ON st.id = ca.staff_id
      WHERE c.code = ?
      LIMIT 1
      `,
      [code],
    );

    if (!rows.length) {
      return res.json({
        ok: false,
        message: `No course found with code ${code}.`,
      });
    }

    const course = rows[0];

    if (course.semester !== semester) {
      return res.json({
        ok: false,
        message: `This course belongs to ${course.semester.toLowerCase()} semester.`,
      });
    }

    return res.json({
      ok: true,
      course: {
        id: course.id,
        code: course.code,
        title: course.title,
        unit: course.unit,
        level: course.level,
        semester: course.semester,
        lecturer: course.lecturer,
      },
    });
  } catch (err) {
    console.error('apiFindCourseByCode error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Error looking up course.' });
  }
}

/**
 * GET /student/registration/api/list?sessionId=...&semester=...
 * List registered courses for that session/semester.
 */
export async function apiListRegistrations(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, message: 'Not authenticated.' });
    }

    const { sessionId, semester } = req.query;
    if (!sessionId || !semester) {
      return res
        .status(400)
        .json({ ok: false, message: 'Session and semester are required.' });
    }

    const { rows, totalUnits, totalCourses, isLocked } =
      await getRegistrationSummary(student.id, Number(sessionId), semester);

    return res.json({
      ok: true,
      items: rows,
      totalUnits,
      totalCourses,
      isLocked,
    });
  } catch (err) {
    console.error('apiListRegistrations error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Error loading registrations.' });
  }
}

/**
 * POST /student/registration/api/add
 * Body: { sessionId, semester, courseCode, regType }
 */
export async function apiAddCourse(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, message: 'Not authenticated.' });
    }

    // --- PROFILE GATE -------------------------------------------------------
    const profileStatus = await getProfileStatus(student.id);
    if (profileStatus !== 'COMPLETE') {
      return res.status(400).json({
        ok: false,
        code: 'PROFILE_INCOMPLETE',
        message:
          'Your student profile is not yet marked as COMPLETE. Please visit the Bursary with your previous school fee receipts and the Directorate of ICT to regularise your records before registering courses.',
      });
    }
    // -----------------------------------------------------------------------

    const { sessionId, semester, courseCode, regType } = req.body;
    if (!sessionId || !semester || !courseCode || !regType) {
      return res
        .status(400)
        .json({ ok: false, message: 'All fields are required to add a course.' });
    }

    const trimmedCode = courseCode.trim().toUpperCase();
    const regTypeNormalized =
      regType.toUpperCase() === 'ELECTIVE' ? 'ELECTIVE' : 'MAIN';

    // Find course by code
    const [courses] = await pool.query(
      'SELECT id, code, title, unit, semester FROM courses WHERE code = ? LIMIT 1',
      [trimmedCode],
    );
    const course = courses[0];
    if (!course) {
      return res.status(404).json({
        ok: false,
        message: `No course found with code ${trimmedCode}.`,
      });
    }

    if (course.semester !== semester) {
      return res.status(400).json({
        ok: false,
        message: `This course belongs to ${course.semester.toLowerCase()} semester.`,
      });
    }

    // Check if registration is already locked
    const { isLocked, totalUnits } = await getRegistrationSummary(
      student.id,
      Number(sessionId),
      semester,
    );
    if (isLocked) {
      return res.status(400).json({
        ok: false,
        message:
          'Registration for this session and semester has already been submitted.',
      });
    }

    // Enforce max units per semester
    const newTotalUnits = totalUnits + (course.unit || 0);
    if (newTotalUnits > MAX_UNITS_PER_SEMESTER) {
      return res.status(400).json({
        ok: false,
        message: `You cannot register more than ${MAX_UNITS_PER_SEMESTER} units. Current: ${totalUnits}, course: ${course.unit}.`,
      });
    }

    // If course already registered, just update reg_type
    const [existingRows] = await pool.query(
      `
      SELECT id
      FROM student_course_regs
      WHERE student_id = ?
        AND session_id = ?
        AND semester = ?
        AND course_id = ?
      LIMIT 1
      `,
      [student.id, Number(sessionId), semester, course.id],
    );

    if (existingRows.length) {
      await pool.query(
        `
        UPDATE student_course_regs
        SET reg_type = ?, units = ?
        WHERE id = ?
        `,
        [regTypeNormalized, course.unit, existingRows[0].id],
      );
    } else {
      await pool.query(
        `
        INSERT INTO student_course_regs
          (student_id, session_id, semester, course_id, reg_type, units)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          student.id,
          Number(sessionId),
          semester,
          course.id,
          regTypeNormalized,
          course.unit,
        ],
      );
    }

    const summary = await getRegistrationSummary(
      student.id,
      Number(sessionId),
      semester,
    );

    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('apiAddCourse error:', err);
    return res.status(500).json({ ok: false, message: 'Error adding course.' });
  }
}

/**
 * POST /student/registration/api/remove
 * Body: { sessionId, semester, regId }
 */
export async function apiRemoveCourse(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, message: 'Not authenticated.' });
    }

    const { sessionId, semester, regId } = req.body;
    if (!sessionId || !semester || !regId) {
      return res
        .status(400)
        .json({ ok: false, message: 'Missing required fields.' });
    }

    const { isLocked } = await getRegistrationSummary(
      student.id,
      Number(sessionId),
      semester,
    );
    if (isLocked) {
      return res.status(400).json({
        ok: false,
        message:
          'Registration for this session and semester has already been submitted.',
      });
    }

    await pool.query(
      `
      DELETE FROM student_course_regs
      WHERE id = ?
        AND student_id = ?
        AND session_id = ?
        AND semester = ?
      `,
      [Number(regId), student.id, Number(sessionId), semester],
    );

    const summary = await getRegistrationSummary(
      student.id,
      Number(sessionId),
      semester,
    );

    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('apiRemoveCourse error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Error removing course.' });
  }
}

/**
 * POST /student/registration/api/finish
 * Body: { sessionId, semester }
 */
export async function apiFinishRegistration(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, message: 'Not authenticated.' });
    }

    const { sessionId, semester } = req.body;
    if (!sessionId || !semester) {
      return res
        .status(400)
        .json({ ok: false, message: 'Session and semester are required.' });
    }

    const summary = await getRegistrationSummary(
      student.id,
      Number(sessionId),
      semester,
    );

    if (!summary.totalCourses) {
      return res.status(400).json({
        ok: false,
        message: 'You have not registered any courses yet.',
      });
    }

    if (summary.totalUnits > MAX_UNITS_PER_SEMESTER) {
      return res.status(400).json({
        ok: false,
        message: `Total units (${summary.totalUnits}) cannot exceed ${MAX_UNITS_PER_SEMESTER}.`,
      });
    }

    if (summary.isLocked) {
      // Already submitted; just return current token if present
      const [tokenRow] = await pool.query(
        `
        SELECT form_token
        FROM student_course_regs
        WHERE student_id = ?
          AND session_id = ?
          AND semester = ?
        LIMIT 1
        `,
        [student.id, Number(sessionId), semester],
      );

      const existingToken = tokenRow[0]?.form_token || null;
      return res.json({
        ok: true,
        alreadySubmitted: true,
        totalUnits: summary.totalUnits,
        totalCourses: summary.totalCourses,
        downloadUrl: existingToken
          ? `/student/registration/print?sessionId=${sessionId}&semester=${semester}&token=${existingToken}`
          : null,
      });
    }

    const token = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `
      UPDATE student_course_regs
      SET status = 'SUBMITTED', form_token = ?
      WHERE student_id = ?
        AND session_id = ?
        AND semester = ?
      `,
      [token, student.id, Number(sessionId), semester],
    );

    return res.json({
      ok: true,
      totalUnits: summary.totalUnits,
      totalCourses: summary.totalCourses,
      downloadUrl: `/student/registration/print?sessionId=${sessionId}&semester=${semester}&token=${token}`,
    });
  } catch (err) {
    console.error('apiFinishRegistration error:', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Error finishing registration.' });
  }
}

/**
 * GET /student/registration/print?sessionId=...&semester=...&token=...
 * Simple printable HTML page (browser can "Save as PDF")
 * Includes QR code pointing to /verify/course-form/:token (to be implemented later).
 */
export async function showCourseFormPrint(req, res) {
  try {
    const student = await getCurrentStudent(req);
    if (!student) {
      req.flash('error', 'You must be logged in as a student.');
      return res.redirect('/login');
    }

    const { sessionId, semester, token } = req.query;
    if (!sessionId || !semester || !token) {
      req.flash('error', 'Invalid course form link.');
      return res.redirect('/student/registration');
    }

    // NEW: Load extra profile info
    const profile = await getStudentProfile(student.id);

    const [sessionRows] = await pool.query(
      'SELECT id, name FROM sessions WHERE id = ? LIMIT 1',
      [Number(sessionId)]
    );

    const session = sessionRows[0] || { name: '' };

    const [rows] = await pool.query(
      `
      SELECT
        c.code,
        c.title,
        c.unit,
        c.level,
        c.semester,
        r.reg_type
      FROM student_course_regs r
      JOIN courses c ON c.id = r.course_id
      WHERE
        r.student_id = ?
        AND r.session_id = ?
        AND r.semester = ?
        AND r.form_token = ?
        AND r.status = 'SUBMITTED'
      ORDER BY c.code
      `,
      [student.id, Number(sessionId), semester, token]
    );

    if (!rows.length) {
      req.flash('error', 'No submitted course form found for this reference.');
      return res.redirect('/student/registration');
    }

    const totalUnits = rows.reduce((sum, row) => sum + (row.unit || 0), 0);
    const totalCourses = rows.length;

    const qrTargetUrl = `${req.protocol}://${req.get(
      'host'
    )}/verify/course-form/${token}`;

    return res.render('student/registration-print', {
      title: 'Course Registration Form',
      student,
      session,
      semester,
      rows,
      totalUnits,
      totalCourses,
      qrTargetUrl,

      // NEW: extra student info
      profile
    });
  } catch (err) {
    console.error('showCourseFormPrint error:', err);
    req.flash('error', 'Error loading course form.');
    return res.redirect('/student/registration');
  }
}
