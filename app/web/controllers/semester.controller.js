// app/web/controllers/semester.controller.js
import { getCurrentSemester, setCurrentSemester } from '../../services/semester.service.js';

export async function showSemester(_req, res) {
  const current = await getCurrentSemester();
  res.render('staff/session-semester', {
    title: 'Switch Semester',
    pageTitle: 'Switch Semester',
    currentSemester: current?.name || 'First',
    semesters: ['First', 'Second', 'Summer / Carry Over'],
  });
}

export async function updateSemester(req, res) {
  try {
    await setCurrentSemester(req.body.semester);
    req.flash('success', 'Semester updated');
  } catch (e) {
    req.flash('error', e.message || 'Could not set semester');
  }
  res.redirect('/staff/session/semester');
}

export async function apiSetSemester(req, res) {
  try {
    await setCurrentSemester(req.body.semester);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not set semester' });
  }
}
