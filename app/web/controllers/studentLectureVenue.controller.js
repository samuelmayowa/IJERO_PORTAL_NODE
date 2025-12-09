// app/web/controllers/studentLectureVenue.controller.js

import pool from '../../core/db.js';

const DEFAULT_RADIUS_METERS = 200;

function getAllowedRadius(input) {
  const specific = Number(process.env.STUDENT_ATTENDANCE_RADIUS_METERS);
  const generic =
    Number(process.env.ATTENDANCE_RADIUS_METERS) ||
    Number(process.env.ATTENDANCE_RADIUS);

  const envRadius =
    (Number.isFinite(specific) && specific > 0 && specific) ||
    (Number.isFinite(generic) && generic > 0 && generic) ||
    DEFAULT_RADIUS_METERS;

  const bodyRadius = Number(input);
  if (Number.isFinite(bodyRadius) && bodyRadius > 0) return bodyRadius;

  return envRadius;
}

/**
 * Only allow admin-type staff to access this page.
 */
function requireAdmin(req, res) {
  const role = String(
    req.session?.user?.role ||
      req.session?.staff?.role ||
      ''
  ).toLowerCase();

  const allowed = ['admin', 'portal administrator', 'ict'];
  if (!allowed.includes(role)) {
    req.flash('error', 'You are not allowed to manage lecture venues.');
    res.redirect('/staff/dashboard');
    return false;
  }
  return true;
}

/**
 * GET /staff/attendance/student-venue
 */
export async function showVenuePage(req, res) {
  if (!requireAdmin(req, res)) return;

  let schools = [];
  let departments = [];
  let venues = [];

  try {
    const [schoolRows] = await pool.query(
      'SELECT id, name FROM schools ORDER BY name'
    );
    schools = schoolRows;
  } catch (e) {
    console.error('lectureVenue: load schools error', e);
  }

  try {
    const [deptRows] = await pool.query(
      'SELECT id, school_id, name FROM departments ORDER BY name'
    );
    departments = deptRows;
  } catch (e) {
    console.error('lectureVenue: load departments error', e);
  }

  try {
    const [venueRows] = await pool.query(
      `
      SELECT
        lv.id,
        lv.school_id,
        lv.department_id,
        lv.name,
        lv.latitude,
        lv.longitude,
        lv.radius_meters,
        s.name AS school_name,
        d.name AS department_name
      FROM lecture_venues lv
      LEFT JOIN schools s     ON s.id = lv.school_id
      LEFT JOIN departments d ON d.id = lv.department_id
      ORDER BY s.name, d.name, lv.name
      `
    );
    venues = venueRows;
  } catch (e) {
    console.error('lectureVenue: load venues error', e);
  }

  const venueNames = [...new Set(venues.map((v) => v.name))];

  res.locals.layout = 'layouts/adminlte'; // same layout as other staff attendance pages

  res.render('attendance/student-lecture-venue', {
    title: 'Set Lecture Venue Location',
    pageTitle: 'Set Lecture Venue Location',
    schools,
    departments,
    venues,
    venueNames,
    defaultRadius: getAllowedRadius(),
    csrfToken: req.csrfToken(),
  });
}

/**
 * POST /staff/attendance/student-venue
 */
export async function saveVenue(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = req.body || {};
  const schoolId = Number(body.school_id || 0);
  const departmentId = Number(body.department_id || 0);
  const venueName = String(body.venue_name || '').trim();
  const lat = Number(body.latitude);
  const lng = Number(body.longitude);
  const radius = getAllowedRadius(body.radius_meters);

  if (
    !schoolId ||
    !departmentId ||
    !venueName ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    req.flash(
      'error',
      'School, department, venue name, latitude and longitude are required.'
    );
    return res.redirect('/staff/attendance/student-venue');
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    req.flash('error', 'Latitude/longitude are out of range.');
    return res.redirect('/staff/attendance/student-venue');
  }

  try {
    await pool.query(
      `
      INSERT INTO lecture_venues
        (school_id, department_id, name, latitude, longitude, radius_meters)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        latitude      = VALUES(latitude),
        longitude     = VALUES(longitude),
        radius_meters = VALUES(radius_meters)
      `,
      [schoolId, departmentId, venueName, lat, lng, radius]
    );

    req.flash('success', 'Lecture venue location saved.');
  } catch (err) {
    console.error('saveVenue error:', err);
    req.flash('error', err.message || 'Could not save lecture venue.');
  }

  res.redirect('/staff/attendance/student-venue');
}

/**
 * POST /staff/attendance/student-venue/:id/delete
 */
export async function deleteVenue(req, res) {
  if (!requireAdmin(req, res)) return;

  const id = Number(req.params.id || 0);
  if (!id) {
    req.flash('error', 'Invalid venue id.');
    return res.redirect('/staff/attendance/student-venue');
  }

  try {
    await pool.query('DELETE FROM lecture_venues WHERE id = ? LIMIT 1', [id]);
    req.flash('success', 'Lecture venue deleted.');
  } catch (err) {
    console.error('deleteVenue error:', err);
    req.flash('error', 'Could not delete venue.');
  }

  res.redirect('/staff/attendance/student-venue');
}

export default {
  showVenuePage,
  saveVenue,
  deleteVenue,
};
