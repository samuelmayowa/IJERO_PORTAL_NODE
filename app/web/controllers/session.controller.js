// app/web/controllers/session.controller.js
import { getAll, setCurrent } from '../../services/session.service.js';
import { getCurrentSemester, setCurrentSemester } from '../../services/semester.service.js';

/**
 * VIEW: Manage Session
 * Renders the *manage-session.ejs* view which expects `data.list` (string[]),
 * `data.current` (string) and optional `data.previous`.
 */
export async function showSetCurrentSession(_req, res) {
  const { list, current } = await getAll();

  // Transform rows -> string list so the view can render options directly
  const names = (list || []).map(r => r.name);

  res.render('staff/manage-session', {
    title: 'Manage Session',
    pageTitle: 'Manage Session',
    data: {
      list: names,
      current: current?.name || null,
      previous: null, // you can supply a real previous later if you track history
    },
  });
}

/**
 * POST (form): set current session
 * The manage-session view posts `sessionName`
 */
export async function setSession(req, res) {
  try {
    const name = req.body.sessionName || req.body.session; // accept both
    await setCurrent(name);
    req.flash('success', 'Session updated');
  } catch (e) {
    req.flash('error', e.message || 'Could not set session');
  }
  res.redirect('/staff/session/current');
}

/**
 * VIEW: Switch Semester
 * Renders *manage-semester.ejs* which reads currentSemester/current.
 */
export async function showSwitchSemester(_req, res) {
  const current = await getCurrentSemester();
  res.render('staff/manage-semester', {
    title: 'Switch Semester',
    pageTitle: 'Switch Semester',
    currentSemester: current?.name || 'First',
  });
}

/**
 * POST (form): set current semester
 */
export async function setSemester(req, res) {
  try {
    await setCurrentSemester(req.body.semester);
    req.flash('success', 'Semester updated');
  } catch (e) {
    req.flash('error', e.message || 'Could not set semester');
  }
  res.redirect('/staff/session/semester');
}

/* ---------- JSON APIs (aliases kept for existing JS) ---------- */
export async function apiSetSession(req, res) {
  try {
    const name = req.body.sessionName || req.body.session;
    await setCurrent(name);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not set session' });
  }
}

export async function apiSetSemester(req, res) {
  try {
    await setCurrentSemester(req.body.semester);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not set semester' });
  }
}

// Legacy no-op used by the old UI
export function apiSwitchBack(_req, res) {
  res.json({ success: true });
}
