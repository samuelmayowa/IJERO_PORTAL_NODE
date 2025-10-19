import {
  getStaffById, getTodayRecord, getRecentRecords,
  insertCheckIn, updateCheckout,
  canCheckInAtLocation, classifyStatusByTime,
  getOfficeLocationForDept, getTodayCountsFiltered,
  CHECKIN_RADIUS_METERS
} from '../../services/mark-attendance.service.js';

// single string from connect-flash (arrays)
function oneFlash(req, key) {
  if (!req.flash) return '';
  const arr = req.flash(key);
  return Array.isArray(arr) && arr.length ? String(arr[0]) : '';
}

export async function markAttendancePage(req, res) {
  try {
    const user = req.session?.user || {};
    const staffId = user?.id || 1; // replace with real session accessor
    const page = Number(req.query.page || 1);

    const staff = await getStaffById(staffId);
    const today = new Date().toISOString().slice(0, 10);
    const todayRec = await getTodayRecord(staffId); // CURDATE() inside

    const { rows: recent, total, totalPages } = await getRecentRecords(staffId, page, 10);
    const office = staff?.department_id ? await getOfficeLocationForDept(staff.department_id) : null;

    const counts = await getTodayCountsFiltered(user);

    const messages = {
      success: oneFlash(req, 'success'),
      error: oneFlash(req, 'error')
    };

    const csrfToken = (typeof req.csrfToken === 'function')
      ? req.csrfToken()
      : (res.locals && res.locals.csrfToken) || '';

    res.render('attendance/mark-attendance', {
      title: 'Mark Attendance',
      staff, office, today, todayRec,
      recent,
      pagination: { total, totalPages, page },
      counts,
      messages,
      csrfToken,
      radiusMeters: CHECKIN_RADIUS_METERS,
      currentUser: user
    });
  } catch (e) {
    console.error('[markAttendancePage] Error:', e);
    if (req.flash) req.flash('error', 'Failed to load attendance page.');
    res.redirect('/staff/attendance/mark');
  }
}

export async function submitAttendance(req, res) {
  try {
    const user = req.session?.user || {};
    const staffId = user?.id || 1;

    const staff = await getStaffById(staffId);
    if (!staff) {
      req.flash && req.flash('error', 'Staff not found.');
      return res.redirect('/staff/attendance/mark');
    }

    // one record per day — using CURDATE() in the service
    const existing = await getTodayRecord(staffId);
    if (existing) {
      const prettyToday = new Date().toDateString();
      const time = existing.check_in_time || '';
      req.flash && req.flash('error', `You have already checked in at ${time} for today (${prettyToday}). Thank you.`);
      return res.redirect('/staff/attendance/mark');
    }

    const { latitude, longitude, leave_reason } = req.body;

    // === BYPASS: leave reason selected => SKIP location + proximity entirely ===
    if (leave_reason && leave_reason.trim() !== '') {
      await insertCheckIn({
        staff_id: staffId,
        school_id: staff.school_id,
        department_id: staff.department_id,
        latitude: null,      // force nulls for leave
        longitude: null,     // force nulls for leave
        status: 'ON LEAVE',
        leave_reason
      });
      req.flash && req.flash('success', 'Checked in as ON LEAVE successfully!');
      return res.redirect('/staff/attendance/mark');
    }

    // === PRESENT: require location + 1-mile proximity ===
    if (!latitude || !longitude) {
      req.flash && req.flash('error', 'Location is required to check in. Please enable location and try again.');
      return res.redirect('/staff/attendance/mark');
    }

    const proximity = await canCheckInAtLocation({
      staff,
      userLat: latitude,
      userLng: longitude
    });
    if (!proximity.ok) {
      // Provide the friendly modal message you requested
      req.flash && req.flash('error', 'You are expected to be in the office. Please move to your office location and try again.');
      return res.redirect('/staff/attendance/mark');
    }

    const status = classifyStatusByTime(new Date(), ''); // no leave
    await insertCheckIn({
      staff_id: staffId,
      school_id: staff.school_id,
      department_id: staff.department_id,
      latitude,
      longitude,
      status,
      leave_reason: null
    });

    req.flash && req.flash('success', 'Checked in successfully!');
    res.redirect('/staff/attendance/mark');
  } catch (e) {
    console.error('[submitAttendance] Error:', e);
    req.flash && req.flash('error', 'Error marking attendance.');
    res.redirect('/staff/attendance/mark');
  }
}

export async function checkoutAttendance(req, res) {
  try {
    const user = req.session?.user || {};
    const staffId = user?.id || 1;
    const { ok, msg } = await updateCheckout(staffId);
    if (!ok) req.flash && req.flash('error', msg || 'Unable to checkout.');
    else req.flash && req.flash('success', 'Checked out successfully!');
    res.redirect('/staff/attendance/mark');
  } catch (e) {
    console.error('[checkoutAttendance] Error:', e);
    req.flash && req.flash('error', 'Error checking out.');
    res.redirect('/staff/attendance/mark');
  }
}
