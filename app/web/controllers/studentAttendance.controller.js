// app/web/controllers/studentAttendance.controller.js

import { DateTime } from 'luxon';
import pool from '../../core/db.js'; // same DB wrapper you’re using elsewhere

const DEFAULT_RADIUS_METERS = 200;

/**
 * Read allowed radius from env or fall back to 200m.
 */
function getAllowedRadius() {
  const raw =
    process.env.STUDENT_ATTENDANCE_RADIUS_METERS ||
    process.env.ATTENDANCE_RADIUS_METERS ||
    DEFAULT_RADIUS_METERS;

  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_RADIUS_METERS;
  return v;
}

/**
 * Get the logged-in student user_id as used by student_profiles / student_course_regs.
 * Your student area stores this in req.session.publicUser, not req.session.user.
 */
async function getLoggedInStudentUserId(req) {
  const pu = req.session?.publicUser;

  if (!pu || String(pu.role).toLowerCase() !== 'student') {
    return null;
  }

  if (pu.id) return pu.id; // already stored

  if (!pu.username) return null;

  const [rows] = await pool.query(
    'SELECT id FROM public_users WHERE username = ? LIMIT 1',
    [pu.username]
  );
  return rows[0]?.id || null;
}

/**
 * Load lectures from lecture_times for this student (today and later),
 * using course_assignments for session / semester.
 */
async function getStudentLecturesForToday(studentUserId) {
  const now = DateTime.local();
  const today = now.toISODate(); // 'YYYY-MM-DD'
  const timeNow = now.toFormat('HH:mm:ss');

  const [rows] = await pool.query(
    `
    SELECT
      lt.id AS lecture_time_id,
      ca.session_id,
      ca.semester,
      lt.lecture_date,
      lt.start_time,
      lt.end_time,
      lt.venue,
      ca.id      AS course_assignment_id,
      ca.course_id,
      c.code     AS course_code,
      c.title    AS course_title,
      sp.school_id,
      sp.department_id AS student_department_id,
      CASE
        WHEN lt.lecture_date = ? AND ? BETWEEN lt.start_time AND lt.end_time THEN 1
        ELSE 0
      END AS is_active
    FROM lecture_times lt
    JOIN course_assignments ca
      ON ca.id = lt.course_assignment_id
    JOIN courses c
      ON c.id = ca.course_id
    JOIN student_course_regs scr
      ON scr.course_id  = ca.course_id
     AND scr.session_id = ca.session_id
     AND scr.semester   = ca.semester
     AND scr.status IN ('REGISTERED','SUBMITTED')
    JOIN student_profiles sp
      ON sp.user_id = scr.student_id
    WHERE
      scr.student_id = ?
      AND lt.lecture_date >= ?
    ORDER BY lt.lecture_date ASC, lt.start_time ASC
    `,
    [today, timeNow, studentUserId, today]
  );

  const activeLectures = rows.filter((r) => r.is_active === 1);
  const upcomingLectures = rows;

  return { activeLectures, upcomingLectures, today, timeNow };
}

/**
 * GET /student/attendance  (and /student/attendance/mark via routes)
 */
export async function showMarkAttendancePage(req, res) {
  try {
    const studentUserId = await getLoggedInStudentUserId(req);

    if (!studentUserId) {
      req.flash('error', 'Only logged-in students can mark attendance.');
      return res.redirect('/login');
    }

    const { activeLectures, upcomingLectures, today, timeNow } =
      await getStudentLecturesForToday(studentUserId);

    const canCheckIn = activeLectures.length > 0;

    return res.render('student/mark-attendance', {
      title: 'Mark Attendance',
      pageTitle: 'Mark Attendance',
      activeLectures,
      upcomingLectures,
      today,
      timeNow,
      canCheckIn,
      allowedRadiusMeters: getAllowedRadius(),
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    console.error('Error in showMarkAttendancePage:', err);
    req.flash('error', 'Unable to load attendance page.');
    return res.redirect('/student/dashboard');
  }
}

/**
 * POST /student/attendance/mark
 */
export async function submitStudentAttendance(req, res) {
  try {
    const studentUserId = await getLoggedInStudentUserId(req);

    if (!studentUserId) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/login');
    }

    const { lecture_time_id, latitude, longitude } = req.body || {};

    if (!lecture_time_id) {
      req.flash('error', 'Please select a lecture.');
      return res.redirect('/student/attendance');
    }

    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      req.flash(
        'error',
        'Unable to read your location. Please allow location access.'
      );
      return res.redirect('/student/attendance');
    }

    // 1) Verify lecture belongs to this student & is active now
    const now = DateTime.local();
    const today = now.toISODate();
    const timeNow = now.toFormat('HH:mm:ss');

    const [lectureRows] = await pool.query(
      `
      SELECT
        lt.id                AS lecture_time_id,
        lt.lecture_date,
        lt.start_time,
        lt.end_time,
        lt.venue,
        ca.session_id,
        ca.semester,
        ca.course_id,
        c.code              AS course_code,
        c.title             AS course_title,
        sp.school_id,
        sp.department_id    AS student_department_id,
        scr.student_id
      FROM lecture_times lt
      JOIN course_assignments ca
        ON ca.id = lt.course_assignment_id
      JOIN courses c
        ON c.id = ca.course_id
      JOIN student_course_regs scr
        ON scr.course_id  = ca.course_id
       AND scr.session_id = ca.session_id
       AND scr.semester   = ca.semester
       AND scr.status IN ('REGISTERED','SUBMITTED')
      JOIN student_profiles sp
        ON sp.user_id = scr.student_id
      WHERE
        lt.id = ?
        AND scr.student_id = ?
      LIMIT 1
      `,
      [lecture_time_id, studentUserId]
    );

    if (!lectureRows || lectureRows.length === 0) {
      req.flash('error', 'Invalid lecture selection.');
      return res.redirect('/student/attendance');
    }

    const lecture = lectureRows[0];

    if (
      lecture.lecture_date !== today ||
      !(timeNow >= lecture.start_time && timeNow <= lecture.end_time)
    ) {
      req.flash(
        'error',
        'Attendance window for this lecture is closed or not yet open.'
      );
      return res.redirect('/student/attendance');
    }

    // 2) Get venue location
    const [venueRows] = await pool.query(
      `
      SELECT *
      FROM lecture_venues
      WHERE name = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [lecture.venue]
    );

    if (!venueRows || venueRows.length === 0) {
      req.flash(
        'error',
        'Venue location has not been configured yet. Please contact ICT.'
      );
      return res.redirect('/student/attendance');
    }

    const venue = venueRows[0];
    const venueLat = Number(venue.latitude);
    const venueLon = Number(venue.longitude);

    if (!Number.isFinite(venueLat) || !Number.isFinite(venueLon)) {
      req.flash(
        'error',
        'Venue location is invalid. Please contact ICT to update the coordinates.'
      );
      return res.redirect('/student/attendance');
    }

    // 3) Distance check (Haversine)
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371000; // metres

    const φ1 = toRad(venueLat);
    const φ2 = toRad(lat);
    const Δφ = toRad(lat - venueLat);
    const Δλ = toRad(lon - venueLon);

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    const allowedRadius = getAllowedRadius();
    if (distance > allowedRadius) {
      req.flash(
        'error',
        `You are too far from the lecture venue (≈${Math.round(
          distance
        )}m). You must be within ${allowedRadius}m to mark attendance.`
      );
      return res.redirect('/student/attendance');
    }

    // 4) Insert attendance record (one per student+lecture)
    // Make sure your student_attendance_records table has these columns.
    await pool.query(
      `
      INSERT INTO student_attendance_records
        (student_id,
         lecture_time_id,
         course_id,
         session_id,
         semester,
         school_id,
         department_id,
         status,
         check_in_at,
         latitude,
         longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PRESENT', NOW(), ?, ?)
      ON DUPLICATE KEY UPDATE
        status     = VALUES(status),
        check_in_at = VALUES(check_in_at),
        latitude   = VALUES(latitude),
        longitude  = VALUES(longitude)
      `,
      [
        studentUserId,
        lecture.lecture_time_id,
        lecture.course_id,
        lecture.session_id,
        lecture.semester,
        lecture.school_id || null,
        lecture.student_department_id || null,
        lat,
        lon,
      ]
    );

    req.flash('success', 'Attendance marked successfully.');
    return res.redirect('/student/attendance');
  } catch (err) {
    console.error('Error in submitStudentAttendance:', err);
    req.flash('error', 'Unable to submit attendance.');
    return res.redirect('/student/attendance');
  }
}

export default {
  showMarkAttendancePage,
  submitStudentAttendance,
};
