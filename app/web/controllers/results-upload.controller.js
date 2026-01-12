// app/web/controllers/results-upload.controller.js
import { pool } from '../../core/db.js';
import * as XLSX from 'xlsx';

/* ---------------- helpers ---------------- */
function mapSemesterNameToKey(semesterName) {
  const n = String(semesterName || '').trim().toLowerCase();
  if (n.startsWith('first')) return 'FIRST';
  if (n.startsWith('second')) return 'SECOND';
  if (n.startsWith('summer')) return 'SUMMER';
  return String(semesterName || '').trim().toUpperCase();
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function extractField(rowObj, candidates) {
  const map = {};
  for (const [k, v] of Object.entries(rowObj || {})) map[normKey(k)] = v;

  for (const c of candidates) {
    const v = map[normKey(c)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getGradeScale() {
  const [rows] = await pool.query(
    `SELECT min_score, max_score, grade, points
     FROM grade_scales
     ORDER BY min_score DESC`
  );
  return rows || [];
}

function gradeFromTotal(total, scales) {
  const t = Number(total);
  for (const s of scales) {
    if (t >= Number(s.min_score) && t <= Number(s.max_score)) {
      return { grade: s.grade, points: Number(s.points) };
    }
  }
  return { grade: 'F', points: 0 };
}

function asCsv(rows) {
  const headers = [
    'MATRIC_NUMBER',
    'CA1',
    'CA2',
    'CA3',
    'EXAM',
    'TOTAL',
    'REASON',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        esc(r.matric_number),
        esc(r.ca1),
        esc(r.ca2),
        esc(r.ca3),
        esc(r.exam),
        esc(r.total),
        esc(r.reason),
      ].join(',')
    );
  }
  return lines.join('\n');
}
/* -------------- end helpers -------------- */

/**
 * GET /staff/results/upload
 */
export async function showUploadPage(req, res) {
  try {
    if (!req.session?.user) return res.redirect('/login');

    const [[currentSession]] = await pool.query(
      `SELECT id, name FROM sessions WHERE is_current = 1 LIMIT 1`
    );
    const [[currentSemester]] = await pool.query(
      `SELECT id, name FROM semesters WHERE is_current = 1 LIMIT 1`
    );

    const [sessions] = await pool.query(
      `SELECT id, name, is_current FROM sessions ORDER BY is_current DESC, id DESC`
    );
    const [semesters] = await pool.query(
      `SELECT id, name, is_current FROM semesters ORDER BY is_current DESC, id ASC`
    );
    const [schools] = await pool.query(
      `SELECT id, name FROM schools ORDER BY name ASC`
    );
    const [departments] = await pool.query(
      `SELECT id, name, school_id FROM departments ORDER BY name ASC`
    );
    const [programmes] = await pool.query(
      `SELECT id, name, school_id, department_id FROM programmes ORDER BY name ASC`
    );
    const [batches] = await pool.query(
      `SELECT id, code FROM result_batches_lookup ORDER BY code ASC`
    );

    // If you later create a levels table, swap this out.
    const [levelsRaw] = await pool.query(
      `SELECT DISTINCT level FROM courses WHERE level IS NOT NULL AND level <> '' ORDER BY level ASC`
    );
    const levels = (levelsRaw || []).map((r) => r.level).filter(Boolean);

    return res.render('results/upload', {
      title: 'Upload Student Result',
      pageTitle: 'Upload Student Result',
      sessions,
      semesters,
      schools,
      departments,
      programmes,
      batches,
      levels,
      currentSession: currentSession || null,
      currentSemester: currentSemester || null,
    });
  } catch (err) {
    console.error('showUploadPage error:', err);
    req.flash?.('error', 'Failed to load upload page');
    return res.redirect('/dashboard');
  }
}

/**
 * GET /staff/results/upload/api/course?code=GST101&sessionId=..&semesterId=..
 * - validates course exists
 * - validates that course is assigned to logged-in lecturer for that session+semester
 */
export async function apiFetchCourse(req, res) {
  try {
    const staff = req.session?.user;
    if (!staff) return res.status(401).json({ ok: false, message: 'Not logged in' });

    const code = String(req.query.code || '').trim();
    const sessionId = Number(req.query.sessionId || 0);
    const semesterId = Number(req.query.semesterId || 0);

    if (!code || !sessionId || !semesterId) {
      return res.status(400).json({ ok: false, message: 'Missing course code/session/semester' });
    }

    const [[sem]] = await pool.query(
      `SELECT id, name FROM semesters WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    if (!sem) return res.status(400).json({ ok: false, message: 'Invalid semester' });

    const semesterKey = mapSemesterNameToKey(sem.name);

    // course lookup (common columns: code/title/units)
    const [courseRows] = await pool.query(
      `SELECT id, code, title, units, level, department_id
       FROM courses
       WHERE code = ?
       LIMIT 1`,
      [code]
    );
    const course = courseRows?.[0];
    if (!course) return res.status(404).json({ ok: false, message: 'Course not found' });

    // assignment check
    const [asRows] = await pool.query(
      `SELECT id
       FROM course_assignments
       WHERE course_id = ?
         AND staff_id = ?
         AND session_id = ?
         AND semester = ?
       LIMIT 1`,
      [course.id, staff.id, sessionId, semesterKey]
    );

    if (!asRows?.length) {
      return res.status(403).json({
        ok: false,
        message: `Course (${code}) is not assigned to you for this session/semester.`,
      });
    }

    return res.json({
      ok: true,
      course: {
        id: course.id,
        code: course.code,
        title: course.title,
        units: course.units,
        level: course.level,
        department_id: course.department_id,
      },
      assignment_id: asRows[0].id,
      semesterKey,
    });
  } catch (err) {
    console.error('apiFetchCourse error:', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
}

/**
 * POST /staff/results/upload/api/upload
 * multipart form-data:
 * - sessionId, semesterId, schoolId, departmentId, programmeId, level, batchId, courseCode, override(0/1)
 * - file
 */
export async function apiUploadResults(req, res) {
  const staff = req.session?.user;
  if (!staff) return res.status(401).json({ ok: false, message: 'Not logged in' });

  const {
    sessionId,
    semesterId,
    schoolId,
    departmentId,
    programmeId,
    level,
    batchId,
    courseCode,
    override,
  } = req.body || {};

  const file = req.file;

  if (!file) return res.status(400).json({ ok: false, message: 'No file uploaded' });

  const sessId = Number(sessionId || 0);
  const semId = Number(semesterId || 0);
  const schId = schoolId ? Number(schoolId) : null;
  const deptId = departmentId ? Number(departmentId) : null;
  const progId = programmeId ? Number(programmeId) : null;
  const batchLookupId = Number(batchId || 0);
  const lvl = String(level || '').trim();
  const code = String(courseCode || '').trim();
  const doOverride = String(override || '0') === '1';

  if (!sessId || !semId || !batchLookupId || !lvl || !code) {
    return res.status(400).json({ ok: false, message: 'Missing required fields' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sem]] = await conn.query(
      `SELECT id, name FROM semesters WHERE id = ? LIMIT 1`,
      [semId]
    );
    if (!sem) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: 'Invalid semester' });
    }
    const semesterKey = mapSemesterNameToKey(sem.name);

    const [[course]] = await conn.query(
      `SELECT id, code, title, units FROM courses WHERE code = ? LIMIT 1`,
      [code]
    );
    if (!course) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: 'Course not found' });
    }

    // assignment check (same as fetch)
    const [asRows] = await conn.query(
      `SELECT id
       FROM course_assignments
       WHERE course_id = ?
         AND staff_id = ?
         AND session_id = ?
         AND semester = ?
       LIMIT 1`,
      [course.id, staff.id, sessId, semesterKey]
    );
    if (!asRows?.length) {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        message: `Course (${code}) is not assigned to you for this session/semester.`,
      });
    }

    // detect existing batch upload
    const [existingRows] = await conn.query(
      `SELECT id, status, uploaded_at
       FROM result_batches
       WHERE course_id = ?
         AND session_id = ?
         AND semester = ?
         AND programme_id <=> ?
         AND level = ?
         AND batch_id = ?
       LIMIT 1`,
      [course.id, sessId, semesterKey, progId, lvl, batchLookupId]
    );

    if (existingRows?.length) {
      const ex = existingRows[0];
      const lockedStatuses = new Set(['HOD_APPROVED', 'DEAN_APPROVED', 'BUSINESS_APPROVED', 'FINAL']);
      if (lockedStatuses.has(String(ex.status || '').toUpperCase())) {
        await conn.rollback();
        return res.json({
          ok: false,
          code: 'locked',
          message: `Result already approved (${ex.status}) on ${ex.uploaded_at}. Please select another batch.`,
        });
      }

      if (!doOverride) {
        await conn.rollback();
        return res.json({
          ok: false,
          code: 'exists',
          message: `Result already uploaded for this batch. Do you want to override?`,
          meta: { uploaded_at: ex.uploaded_at, status: ex.status },
        });
      }

      // override allowed => delete old scores + rejection + reset header
      await conn.query(`DELETE FROM course_results WHERE result_batch_id = ?`, [ex.id]);
      await conn.query(`DELETE FROM result_upload_rejections WHERE result_batch_id = ?`, [ex.id]);
      await conn.query(
        `UPDATE result_batches
         SET uploader_staff_id = ?, school_id=?, department_id=?, programme_id=?,
             status='UPLOADED', uploaded_at=NOW(), hod_comment=NULL, dean_comment=NULL, business_comment=NULL
         WHERE id = ?`,
        [staff.id, schId, deptId, progId, ex.id]
      );
    }

    let batchHeaderId = existingRows?.[0]?.id || null;

    if (!batchHeaderId) {
      const [ins] = await conn.query(
        `INSERT INTO result_batches
          (course_id, uploader_staff_id, session_id, semester, school_id, department_id, programme_id, level, batch_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED')`,
        [course.id, staff.id, sessId, semesterKey, schId, deptId, progId, lvl, batchLookupId]
      );
      batchHeaderId = ins.insertId;
    }

    // parse file using XLSX (supports xlsx + csv)
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: 'Invalid file (no sheet found)' });
    }
    const sheet = wb.Sheets[sheetName];

    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' }); // array of objects
    if (!rawRows.length) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: 'File is empty' });
    }

    const gradeScales = await getGradeScale();

    // normalize extracted input rows
    const parsed = [];
    for (const r of rawRows) {
      const matric = extractField(r, ['matric_number', 'matric no', 'matricno', 'matric', 'matric_no']);
      if (!matric) continue;

      const ca1 = toNum(extractField(r, ['ca1', 'ca 1']));
      const ca2 = toNum(extractField(r, ['ca2', 'ca 2']));
      const ca3 = toNum(extractField(r, ['ca3', 'ca 3']));
      const exam = toNum(extractField(r, ['exam', 'exam score', 'exam_score']));

      const total = ca1 + ca2 + ca3 + exam;

      parsed.push({
        matric_number: String(matric).trim(),
        ca1, ca2, ca3, exam,
        total,
      });
    }

    if (!parsed.length) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: 'No valid rows found (missing matric numbers)' });
    }

    // bulk student lookup
    const matricList = Array.from(new Set(parsed.map((x) => x.matric_number)));
    const studentMap = new Map();

    for (const ch of chunk(matricList, 800)) {
      const [stuRows] = await conn.query(
        `SELECT id, matric_number
         FROM public_users
         WHERE role = 'student' AND matric_number IN (?)`,
        [ch]
      );
      for (const s of stuRows || []) studentMap.set(String(s.matric_number), s);
    }

    // bulk registration lookup for this course+session+semester
    const studentIds = Array.from(new Set(Array.from(studentMap.values()).map((s) => s.id)));
    const regMap = new Map();

    for (const ch of chunk(studentIds, 800)) {
      const [regRows] = await conn.query(
        `SELECT student_id, reg_type, units
         FROM student_course_regs
         WHERE session_id = ?
           AND semester = ?
           AND course_id = ?
           AND status = 'SUBMITTED'
           AND student_id IN (?)`,
        [sessId, semesterKey, course.id, ch]
      );
      for (const rr of regRows || []) regMap.set(Number(rr.student_id), rr);
    }

    const acceptedValues = [];
    const rejected = [];

    for (const row of parsed) {
      // score validation
      if (row.ca1 < 0 || row.ca1 > 10 || row.ca2 < 0 || row.ca2 > 10 || row.ca3 < 0 || row.ca3 > 10 || row.exam < 0 || row.exam > 70) {
        rejected.push({ ...row, reason: 'Invalid score range (CA1-CA3 max 10 each, EXAM max 70)' });
        continue;
      }

      const st = studentMap.get(row.matric_number);
      if (!st) {
        rejected.push({ ...row, reason: 'Student not found (matric not in public_users)' });
        continue;
      }

      const reg = regMap.get(Number(st.id));
      if (!reg) {
        // per your simplified rule: DROP it, keep in rejected download
        rejected.push({ ...row, reason: 'Course not registered by student for this session/semester (SUBMITTED)' });
        continue;
      }

      const { grade, points } = gradeFromTotal(row.total, gradeScales);

      acceptedValues.push([
        batchHeaderId,
        st.id,
        course.id,
        reg.reg_type || null,
        row.ca1,
        row.ca2,
        row.ca3,
        row.exam,
        row.total,
        grade,
        points,
      ]);
    }

    if (acceptedValues.length) {
      // insert in chunks to avoid max packet issues
      for (const ch of chunk(acceptedValues, 500)) {
        await conn.query(
          `INSERT INTO course_results
            (result_batch_id, student_id, course_id, reg_type, ca1, ca2, ca3, exam, total, grade, points)
           VALUES ?`,
          [ch]
        );
      }
    }

    // store rejections as json for download
    if (rejected.length) {
      await conn.query(
        `INSERT INTO result_upload_rejections (result_batch_id, rejected_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE rejected_json = VALUES(rejected_json)`,
        [batchHeaderId, JSON.stringify(rejected)]
      );
    }

    await conn.commit();

    return res.json({
      ok: true,
      message: 'Upload processed',
      uploaded: acceptedValues.length,
      rejected: rejected.length,
      rejectedDownload: rejected.length
        ? `/staff/results/upload/rejections/${batchHeaderId}.csv`
        : null,
    });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('apiUploadResults error:', err);
    return res.status(500).json({ ok: false, message: 'Upload failed (server error)' });
  } finally {
    conn.release();
  }
}

/**
 * GET /staff/results/upload/rejections/:batchId.csv
 */
export async function downloadRejectionsCsv(req, res) {
  try {
    if (!req.session?.user) return res.redirect('/login');

    const batchId = Number(req.params.batchId || 0);
    if (!batchId) return res.status(400).send('Invalid batch id');

    const [[row]] = await pool.query(
      `SELECT rejected_json FROM result_upload_rejections WHERE result_batch_id = ? LIMIT 1`,
      [batchId]
    );

    if (!row) return res.status(404).send('No rejected rows found');

    const data = JSON.parse(row.rejected_json || '[]');
    const csv = asCsv(Array.isArray(data) ? data : []);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rejected_results_batch_${batchId}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('downloadRejectionsCsv error:', err);
    return res.status(500).send('Server error');
  }
}
