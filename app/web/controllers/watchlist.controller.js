import {
  isAdminUser,
  listSchools,
  listDepartments,
  windowedStats,
  getWatchlistManual,
  upsertManual,
  removeManualEntry,
  getStaffHistory,
} from '../../services/watchlist.service.js';

function oneFlash(req, key) {
  if (!req.flash) return '';
  const arr = req.flash(key);
  return Array.isArray(arr) && arr.length ? String(arr[0]) : '';
}
const todayISO = () => new Date().toISOString().slice(0,10);

export async function page(req, res) {
  try {
    const user = req.session?.user || {};
    const admin = isAdminUser(user);

    const schoolId = admin ? (req.query.schoolId || '') : (user.school_id || '');
    const departmentId = admin ? (req.query.departmentId || '') : (user.department_id || '');
    const windowDays = Number(req.query.window || 30) || 30;

    // Defaults for thresholds (change as needed)
    const lateN      = Number(req.query.lateN      || 3);
    const veryLateN  = Number(req.query.veryLateN  || 2);
    const absentN    = Number(req.query.absentN    || 2);
    const geoFailN   = Number(req.query.geoFailN   || 2);

    const schools = await listSchools();
    const departments = await listDepartments(schoolId || null);

    const messages = { success: oneFlash(req,'success'), error: oneFlash(req,'error') };

    // csrfToken is already provided to all views by your existing middleware
    res.render('attendance/watchlist', {
      title: 'Watch-List Staff',
      admin,
      schools,
      departments,
      filters: { schoolId, departmentId, windowDays, lateN, veryLateN, absentN, geoFailN },
      messages,
      user,
      today: todayISO()
    });
  } catch (e) {
    console.error('[watchlist:page]', e);
    req.flash && req.flash('error', 'Failed to load Watch-List page.');
    res.redirect('/staff/dashboard');
  }
}

export async function data(req, res) {
  try {
    const user = req.session?.user || {};
    const admin = isAdminUser(user);

    const windowDays = Number(req.query.window || 30) || 30;

    let schoolId = req.query.schoolId || '';
    let departmentId = req.query.departmentId || '';

    // Non-admin users are scoped to their school/department
    if (!admin) {
      schoolId = user.school_id || '';
      departmentId = user.department_id || '';
    }

    const lateN     = Number(req.query.lateN     || 3);
    const veryLateN = Number(req.query.veryLateN || 2);
    const absentN   = Number(req.query.absentN   || 2);
    const geoFailN  = Number(req.query.geoFailN  || 2);

    const until = todayISO();
    const from = new Date(Date.now() - (windowDays*24*60*60*1000)).toISOString().slice(0,10);

    const result = await windowedStats({
      from, to: until, schoolId, departmentId,
      thresholds: { lateN, veryLateN, absentN, geoFailN }
    });

    const manualMap = await getWatchlistManual();

    const rows = result.rows.map(r => {
      const manual = manualMap.get(r.staff_id) || null;
      return {
        ...r,
        watch_status: manual ? 'Manual' : 'Auto',
        manual_reason: manual?.reason || '',
        manual_expires_on: manual?.expires_on || null
      };
    });

    res.json({ ok:true, rows, windowDays });
  } catch (e) {
    console.error('[watchlist:data]', e);
    res.status(500).json({ ok:false, error:'Failed to compute watchlist.' });
  }
}

export async function history(req, res) {
  try {
    const staffId = Number(req.query.staff_id || 0);
    if (!staffId) return res.json({ ok:false, error:'Missing staff id' });

    const days = Number(req.query.days || 30);
    const until = todayISO();
    const from = new Date(Date.now() - (days*24*60*60*1000)).toISOString().slice(0,10);

    const rows = await getStaffHistory(staffId, from, until);
    res.json({ ok:true, rows });
  } catch (e) {
    console.error('[watchlist:history]', e);
    res.status(500).json({ ok:false, error:'Failed to fetch history.' });
  }
}

export async function addManual(req, res) {
  try {
    const user = req.session?.user || {};
    const staff_id   = Number(req.body.staff_id);
    const reason     = (req.body.reason || '').trim() || null;
    const expires_on = (req.body.expires_on || '').trim() || null;

    if (!staff_id) {
      req.flash && req.flash('error', 'Staff is required.');
      return res.redirect('/staff/attendance/watchlist');
    }

    await upsertManual({
      staff_id,
      reason,
      created_by: user?.id || null,
      expires_on: expires_on || null
    });

    req.flash && req.flash('success', 'Watch entry saved.');
    res.redirect('/staff/attendance/watchlist');
  } catch (e) {
    console.error('[watchlist:addManual]', e);
    req.flash && req.flash('error', 'Failed to save watch entry.');
    res.redirect('/staff/attendance/watchlist');
  }
}

export async function removeManual(req, res) {
  try {
    const staff_id = Number(req.body.staff_id);
    if (!staff_id) {
      req.flash && req.flash('error', 'Staff is required.');
      return res.redirect('/staff/attendance/watchlist');
    }
    await removeManualEntry(staff_id);
    req.flash && req.flash('success', 'Removed from manual watch.');
    res.redirect('/staff/attendance/watchlist');
  } catch (e) {
    console.error('[watchlist:removeManual]', e);
    req.flash && req.flash('error', 'Failed to remove manual watch.');
    res.redirect('/staff/attendance/watchlist');
  }
}
