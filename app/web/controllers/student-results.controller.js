// app/web/controllers/student-results.controller.js
import { pool } from '../../core/db.js';

function mapSemesterNameToKey(semesterName) {
  const n = String(semesterName || '').trim().toLowerCase();
  if (n.startsWith('first')) return 'FIRST';
  if (n.startsWith('second')) return 'SECOND';
  if (n.startsWith('summer')) return 'SUMMER';
  return String(semesterName || '').trim().toUpperCase();
}

function approvalLabel(batchStatus) {
  const s = String(batchStatus || '').toUpperCase();
  // Your rule: interim until DEAN clicks "APPROVED BY BUSINESS COMMITTEE"
  if (s === 'BUSINESS_APPROVED' || s === 'FINAL') return 'APPROVED';
  return 'RAW SCORE (INTERIM)';
}

export async function showSemesterResultPage(req, res) {
  try {
    const pu = req.session?.publicUser;
    if (!pu || pu.role !== 'student') return res.redirect('/login');

    const [sessions] = await pool.query(
      `SELECT id, name, is_current FROM sessions ORDER BY is_current DESC, id DESC`
    );
    const [semesters] = await pool.query(
      `SELECT id, name, is_current FROM semesters ORDER BY is_current DESC, id ASC`
    );

    const [levelsRaw] = await pool.query(
      `SELECT DISTINCT level FROM courses WHERE level IS NOT NULL AND level <> '' ORDER BY level ASC`
    );
    const levels = (levelsRaw || []).map((r) => r.level).filter(Boolean);

    const [[currentSession]] = await pool.query(
      `SELECT id, name FROM sessions WHERE is_current = 1 LIMIT 1`
    );
    const [[currentSemester]] = await pool.query(
      `SELECT id, name FROM semesters WHERE is_current = 1 LIMIT 1`
    );

    // pick student's current level (fallback to student_imports if profile level is NULL)
    const [[profile]] = await pool.query(
      `
      SELECT
        COALESCE(sp.level, si.student_level, '') AS level
      FROM public_users pu
      LEFT JOIN student_profiles sp ON sp.user_id = pu.id
      LEFT JOIN student_imports si ON si.student_email = pu.username
      WHERE pu.id = ?
      LIMIT 1
      `,
      [pu.id]
    );

    return res.render('results/student-semester', {
      title: 'Semester Result',
      pageTitle: 'Semester Result',
      sessions,
      semesters,
      levels,
      currentSession: currentSession || null,
      currentSemester: currentSemester || null,
      currentLevel: profile?.level || '',
    });
  } catch (err) {
    console.error('showSemesterResultPage error:', err);
    req.flash?.('error', 'Failed to load result page');
    return res.redirect('/student/dashboard');
  }
}

export async function apiGetSemesterResults(req, res) {
  try {
    const pu = req.session?.publicUser;
    if (!pu || pu.role !== 'student') return res.status(401).json({ ok: false });

    const sessionId = Number(req.query.sessionId || 0);
    const semesterId = Number(req.query.semesterId || 0);
    const level = String(req.query.level || '').trim();

    if (!sessionId || !semesterId || !level) {
      return res.json({ ok: true, rows: [], summary: null });
    }

    const [[sem]] = await pool.query(
      `SELECT id, name FROM semesters WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    if (!sem) return res.json({ ok: true, rows: [], summary: null });

    const semesterKey = mapSemesterNameToKey(sem.name);

    const [rows] = await pool.query(
      `
      SELECT
        c.code AS course_code,
        c.title AS course_title,
        COALESCE(c.units, scr.units) AS units,
        cr.ca1, cr.ca2, cr.ca3, cr.exam, cr.total,
        cr.grade, cr.points,
        rb.status AS batch_status,
        rb.uploaded_at
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = cr.course_id
      JOIN student_course_regs scr
        ON scr.student_id = cr.student_id
       AND scr.course_id = cr.course_id
       AND scr.session_id = rb.session_id
       AND scr.semester = rb.semester
       AND scr.status = 'SUBMITTED'
      WHERE cr.student_id = ?
        AND rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        AND rb.status <> 'REJECTED'
      ORDER BY c.code ASC
      `,
      [pu.id, sessionId, semesterKey, level]
    );

    let totalUnits = 0;
    let totalPoints = 0;

    const out = (rows || []).map((r) => {
      const units = Number(r.units || 0);
      totalUnits += units;
      totalPoints += units * Number(r.points || 0);

      return {
        course_code: r.course_code,
        course_title: r.course_title,
        units,
        ca1: Number(r.ca1),
        ca2: Number(r.ca2),
        ca3: Number(r.ca3),
        exam: Number(r.exam),
        total: Number(r.total),
        grade: r.grade,
        status: approvalLabel(r.batch_status),
        uploaded_at: r.uploaded_at,
      };
    });

    const gpaRaw = totalUnits ? (totalPoints / totalUnits) : 0;
    // IMPORTANT: return GPA as a formatted string so the UI prints "4.0" not "4"
    const gpa = totalUnits ? gpaRaw.toFixed(1) : '0.0';

    return res.json({
      ok: true,
      rows: out,
      summary: {
        totalUnits,
        gpa,            // e.g. "4.0"
        gpa_numeric: totalUnits ? Number(gpaRaw.toFixed(2)) : 0, // optional
      },
    });
  } catch (err) {
    console.error('apiGetSemesterResults error:', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
}

export async function printSemesterResultSlip(req, res) {
  try {
    const pu = req.session?.publicUser;
    if (!pu || pu.role !== 'student') return res.redirect('/login');

    const sessionId = Number(req.query.sessionId || 0);
    const semesterId = Number(req.query.semesterId || 0);
    const level = String(req.query.level || '').trim();

    if (!sessionId || !semesterId || !level) return res.redirect('/student/results/semester');

    const [[sessionRow]] = await pool.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );
    const [[sem]] = await pool.query(
      `SELECT id, name FROM semesters WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    if (!sessionRow || !sem) return res.redirect('/student/results/semester');

    const semesterKey = mapSemesterNameToKey(sem.name);

    const [rows] = await pool.query(
      `
      SELECT
        c.code AS course_code,
        c.title AS course_title,
        COALESCE(c.units, scr.units) AS units,
        cr.ca1, cr.ca2, cr.ca3, cr.exam, cr.total,
        cr.grade, cr.points,
        rb.status AS batch_status,
        rb.uploaded_at
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = cr.course_id
      JOIN student_course_regs scr
        ON scr.student_id = cr.student_id
       AND scr.course_id = cr.course_id
       AND scr.session_id = rb.session_id
       AND scr.semester = rb.semester
       AND scr.status = 'SUBMITTED'
      WHERE cr.student_id = ?
        AND rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        AND rb.status <> 'REJECTED'
      ORDER BY c.code ASC
      `,
      [pu.id, sessionId, semesterKey, level]
    );

    // student biodata (best-effort)
    // NOTE: student_profiles.*_id can be NULL, so we fallback to student_imports.* text fields
    const [[bio]] = await pool.query(
      `
      SELECT
        pu.first_name, pu.middle_name, pu.last_name,
        pu.username,
        pu.matric_number,
        COALESCE(sp.phone, pu.phone) AS phone,

        COALESCE(sc.name, si.school)       AS school_name,
        COALESCE(d.name,  si.department)   AS department_name,
        COALESCE(p.name,  si.programme)    AS programme_name,

        COALESCE(sp.level, si.student_level) AS level
      FROM public_users pu
      LEFT JOIN student_profiles sp ON sp.user_id = pu.id
      LEFT JOIN schools sc ON sc.id = sp.school_id
      LEFT JOIN departments d ON d.id = sp.department_id
      LEFT JOIN programmes p ON p.id = sp.programme_id
      LEFT JOIN student_imports si ON si.student_email = pu.username
      WHERE pu.id = ?
      LIMIT 1
      `,
      [pu.id]
    );

    let totalUnits = 0;
    let totalPoints = 0;

    const out = (rows || []).map((r) => {
      const units = Number(r.units || 0);
      totalUnits += units;
      totalPoints += units * Number(r.points || 0);

      return {
        ...r,
        units,
        statusLabel: approvalLabel(r.batch_status),
      };
    });

    const gpaRaw = totalUnits ? (totalPoints / totalUnits) : 0;
    const gpa = totalUnits ? gpaRaw.toFixed(1) : '0.0';

    return res.render('results/student-result-slip', {
      title: 'Result Slip',
      pageTitle: 'Result Slip',
      sessionName: sessionRow.name,
      semesterName: sem.name,
      level,
      bio: bio || {},
      rows: out,
      summary: {
        totalUnits,
        gpa, // "4.0"
        gpa_numeric: totalUnits ? Number(gpaRaw.toFixed(2)) : 0,
      },
    });
  } catch (err) {
    console.error('printSemesterResultSlip error:', err);
    req.flash?.('error', 'Failed to generate result slip');
    return res.redirect('/student/results/semester');
  }
}
