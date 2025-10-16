// app/web/controllers/attendance.controller.js
//
// Controller for Attendance → Office Location
// - Validates inputs (presence + numeric ranges)
// - Uses flash banners for errors/success (rendered by layout's messages)
// - Supports department typed by name (ensured/created)

import { pool } from '../../core/db.js';
import {
  getSchools,
  getDepartmentsBySchool,
  getOfficeLocation,
  getAllOfficeLocations,
  upsertOfficeLocation,
  ensureDepartment
} from '../../services/attendance.service.js';

export async function viewOfficeLocationForm(req, res) {
  try {
    const schools = await getSchools();
    const selectedSchoolId = parseInt(req.query.school_id || (schools[0]?.id || 0), 10);

    const departments = selectedSchoolId
      ? await getDepartmentsBySchool(selectedSchoolId)
      : [];

    const selectedDepartmentId = parseInt(
      req.query.department_id || (departments[0]?.id || 0),
      10
    );

    let location = null;
    if (selectedSchoolId && selectedDepartmentId) {
      location = await getOfficeLocation(selectedSchoolId, selectedDepartmentId);
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = 10;
    const { rows: list, total } = await getAllOfficeLocations({
      limit: pageSize,
      offset: (page - 1) * pageSize
    });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    res.render('attendance/office-location', {
      title: 'Set Office Long/Lat',
      pageTitle: 'Set Office Long/Lat',
      schools,
      departments,
      selectedSchoolId,
      selectedDepartmentId,
      location,
      list,
      page,
      totalPages
    });
  } catch (err) {
    console.error('viewOfficeLocationForm error:', err);
    req.flash('error', err.message || 'Failed to load office locations');
    res.redirect('/staff');
  }
}

export async function saveOfficeLocation(req, res) {
  try {
    // Read incoming values
    const schoolId = parseInt(req.body.school_id, 10);
    const deptName = (req.body.department_name || '').trim(); // we accept name, not id, from the form
    const latStr   = String(req.body.latitude ?? '').trim();
    const lonStr   = String(req.body.longitude ?? '').trim();

    // Presence checks
    if (!schoolId) {
      req.flash('error', 'Please select a school.');
      return res.redirect('/staff/attendance/office-location');
    }
    if (!deptName) {
      req.flash('error', 'Please type or select a department.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }
    if (latStr === '' || lonStr === '') {
      req.flash('error', 'Latitude and Longitude are required.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }

    // Numeric + range validation
    const latitude  = Number(latStr);
    const longitude = Number(lonStr);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      req.flash('error', 'Latitude and Longitude must be numbers.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }
    if (Math.abs(latitude) > 90) {
      req.flash('error', 'Latitude must be between -90 and 90.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }
    if (Math.abs(longitude) > 180) {
      req.flash('error', 'Longitude must be between -180 and 180.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }

    // Resolve/ensure department by name
    const departmentId = await ensureDepartment(schoolId, deptName);
    if (!departmentId) {
      req.flash('error', 'Could not resolve department.');
      return res.redirect(`/staff/attendance/office-location?school_id=${schoolId}`);
    }

    await upsertOfficeLocation({ schoolId, departmentId, latitude, longitude });

    req.flash('success', 'Office location saved successfully.');
    res.redirect(
      `/staff/attendance/office-location?school_id=${schoolId}&department_id=${departmentId}`
    );
  } catch (err) {
    console.error('saveOfficeLocation error:', err);
    req.flash('error', err.message || 'Failed to save office location');
    res.redirect('/staff/attendance/office-location');
  }
}

export async function apiDepartmentsBySchool(req, res) {
  try {
    const schoolId = parseInt(req.params.schoolId || req.query.schoolId, 10);
    if (!schoolId) return res.json([]);
    const rows = await getDepartmentsBySchool(schoolId);
    res.json(rows);
  } catch (err) {
    console.error('apiDepartmentsBySchool error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function apiUpdateOfficeLocation(req, res) {
  try {
    const schoolId     = parseInt(req.body.school_id, 10);
    const departmentId = parseInt(req.body.department_id, 10);
    const latitude     = Number(req.body.latitude);
    const longitude    = Number(req.body.longitude);

    if (!schoolId || !departmentId) {
      return res.status(400).json({ success: false, message: 'Missing school/department.' });
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ success: false, message: 'Lat/Lon must be numbers.' });
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({ success: false, message: 'Lat in [-90,90], Lon in [-180,180].' });
    }

    const id = await upsertOfficeLocation({ schoolId, departmentId, latitude, longitude });
    res.json({ success: true, id });
  } catch (err) {
    console.error('apiUpdateOfficeLocation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

export async function apiDeleteOfficeLocation(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ success: false, message: 'Invalid ID' });

    await pool.query(`DELETE FROM office_locations WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('apiDeleteOfficeLocation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
}
