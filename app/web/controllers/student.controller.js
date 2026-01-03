import { pool } from '../../core/db.js';

/**
 * Small schema helper (prevents crashing if courses table columns differ:
 * e.g. code vs course_code, title vs name)
 */
const _columnsCache = new Map();

async function getTableColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);

  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME AS name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
    `,
    [tableName]
  );

  const set = new Set((rows || []).map((r) => r.name));
  _columnsCache.set(tableName, set);
  return set;
}

function mapSemesterNameToKey(semesterName) {
  const n = String(semesterName || '').trim().toLowerCase();
  if (n.startsWith('first')) return 'FIRST';
  if (n.startsWith('second')) return 'SECOND';
  if (n.startsWith('summer')) return 'SUMMER';
  return String(semesterName || '').trim().toUpperCase();
}

async function getCurrentSessionAndSemester() {
  const [sess] = await pool.query(
    `SELECT id, name FROM sessions WHERE is_current = 1 LIMIT 1`
  );
  const [sems] = await pool.query(
    `SELECT id, name FROM semesters WHERE is_current = 1 LIMIT 1`
  );

  const currentSession = sess?.[0] || null;
  const currentSemester = sems?.[0] || null;

  return {
    currentSession,
    currentSemester,
    semesterKey: mapSemesterNameToKey(currentSemester?.name),
  };
}

async function enrichWithCourseDetails(items, courseIdGetter) {
  // Pull course IDs
  const ids = Array.from(
    new Set(
      (items || [])
        .map((x) => courseIdGetter(x))
        .filter((v) => v !== null && v !== undefined)
    )
  );

  if (!ids.length) return items;

  // Detect columns safely
  let cols;
  try {
    cols = await getTableColumns('courses');
  } catch {
    return items;
  }

  const codeCol = cols.has('code')
    ? 'code'
    : cols.has('course_code')
      ? 'course_code'
      : null;

  const titleCol = cols.has('title')
    ? 'title'
    : cols.has('name')
      ? 'name'
      : cols.has('course_title')
        ? 'course_title'
        : null;

  // If we can't find any helpful columns, don't enrich
  if (!codeCol && !titleCol) return items;

  const selectParts = ['id'];
  if (codeCol) selectParts.push(`${codeCol} AS course_code`);
  else selectParts.push(`NULL AS course_code`);
  if (titleCol) selectParts.push(`${titleCol} AS course_title`);
  else selectParts.push(`NULL AS course_title`);

  const sql = `SELECT ${selectParts.join(', ')} FROM courses WHERE id IN (?)`;
  const [rows] = await pool.query(sql, [ids]);

  const map = new Map();
  (rows || []).forEach((r) => map.set(r.id, r));

  // attach to each item
  return (items || []).map((x) => {
    const cid = courseIdGetter(x);
    const c = map.get(cid);
    return {
      ...x,
      course_code: c?.course_code ?? null,
      course_title: c?.course_title ?? null,
    };
  });
}

// Student dashboard -> render your AdminLTE student page
export async function dashboard(req, res) {
  const publicUser = req.session?.publicUser || {};
  const studentId = publicUser?.id || null;
  let photo_path = publicUser.photo_path || null;

  // Fetch latest profile photo from DB if available
  if (studentId) {
    try {
      const [rows] = await pool.query(
        `SELECT file_path FROM student_photos
         WHERE student_id = ? AND photo_type = 'PROFILE'
         ORDER BY uploaded_at DESC LIMIT 1`,
        [studentId]
      );
      if (rows.length) photo_path = rows[0].file_path;
    } catch (err) {
      console.error('Error fetching student photo:', err);
    }
  }

  // ---- Dynamic dashboard data ----
  let currentSession = null;
  let currentSemester = null;
  let semesterKey = null;

  let totalRegisteredCourses = 0;
  let recentCourseRegistrations = [];
  let recentAttendance = [];

  try {
    const cur = await getCurrentSessionAndSemester();
    currentSession = cur.currentSession;
    currentSemester = cur.currentSemester;
    semesterKey = cur.semesterKey;

    // 1) Total Registered Courses (CURRENT session + semester)
    // NOTE: counting SUBMITTED only as "registered"
    if (studentId && currentSession?.id && semesterKey) {
      const [cnt] = await pool.query(
        `
          SELECT COUNT(*) AS total
          FROM student_course_regs
          WHERE student_id = ?
            AND session_id = ?
            AND semester = ?
            AND status = 'SUBMITTED'
        `,
        [studentId, currentSession.id, semesterKey]
      );

      totalRegisteredCourses = Number(cnt?.[0]?.total || 0);

      // 2) Recent 4 course registrations (CURRENT session + semester)
      const [regs] = await pool.query(
        `
          SELECT
            id,
            course_id,
            reg_type,
            units,
            status,
            created_at
          FROM student_course_regs
          WHERE student_id = ?
            AND session_id = ?
            AND semester = ?
            AND status = 'SUBMITTED'
          ORDER BY created_at DESC
          LIMIT 4
        `,
        [studentId, currentSession.id, semesterKey]
      );

      recentCourseRegistrations = await enrichWithCourseDetails(
        regs || [],
        (r) => r.course_id
      );
    }
  } catch (err) {
    console.error('Error building registration dashboard data:', err);
  }

  try {
    // 3) Recent 4 attendance across everything
    if (studentId) {
      const [att] = await pool.query(
        `
          SELECT
            id,
            course_id,
            status,
            check_in_at,
            created_at
          FROM student_attendance_records
          WHERE student_id = ?
          ORDER BY COALESCE(check_in_at, created_at) DESC
          LIMIT 4
        `,
        [studentId]
      );

      recentAttendance = await enrichWithCourseDetails(att || [], (a) => a.course_id);
    }
  } catch (err) {
    console.error('Error building attendance dashboard data:', err);
  }

  res.render('pages/student', {
    title: 'Student Dashboard',
    pageTitle: 'Dashboard',
    publicUser,
    photo_path,
    currentPage: 'dashboard',

    // NEW: used by your dashboard widgets
    currentSession,
    currentSemester,
    semesterKey,

    totalRegisteredCourses,
    recentCourseRegistrations,
    recentAttendance,
  });
}

// GET /student/uniform
export async function uniformForm(req, res) {
  const personRole = 'STUDENT';

  // Prefer public portal session → username as stable personId
  const pu = req.session?.publicUser || {};
  const personId = (
    pu.username ||
    req.user?.matricNumber ||
    req.session?.user?.matricNumber ||
    ''
  ).trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query(
      'SELECT id FROM sessions WHERE is_current=1 LIMIT 1'
    );
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  // existing record (if any)
  let data = {};
  try {
    const [rows] = await pool.query(
      `SELECT * FROM uniform_measurements WHERE person_role=? AND person_id=? AND session_id <=> ? LIMIT 1`,
      [personRole, personId, sessionId]
    );
    data = rows[0] || {};
  } catch {}

  // dropdown data
  let schools = [],
    departments = [];
  try {
    const [r1] = await pool.query('SELECT id, name FROM schools ORDER BY name');
    const [r2] = await pool.query(
      'SELECT id, name, school_id FROM departments ORDER BY name'
    );
    schools = r1;
    departments = r2;
  } catch {}

  res.render('uniform/uniform', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    mode: data?.id ? 'edit' : 'create',
    data,
    personRole,
    personId,
    sessionId,
    schools,
    departments,
  });
}

// POST /student/uniform
export async function saveUniform(req, res) {
  const b = req.body || {};
  const personRole = 'STUDENT';

  const pu = req.session?.publicUser || {};
  const personId = (
    pu.username ||
    req.user?.matricNumber ||
    req.session?.user?.matricNumber ||
    ''
  ).trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query(
      'SELECT id FROM sessions WHERE is_current=1 LIMIT 1'
    );
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const sql = `
    INSERT INTO uniform_measurements
      (person_role, person_id, session_id, school_id, department_id, programme, level, entry_year,
       gender, height_cm, weight_kg, cap_size_cm, neck_cm, chest_cm, bust_cm, waist_cm, hips_cm,
       shoulder_cm, sleeve_cm, top_length_cm, trouser_len_cm, skirt_len_cm, shoe_size,
       color_cap, color_top, color_bottom, color_tie, status)
    VALUES (?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      school_id=VALUES(school_id), department_id=VALUES(department_id), programme=VALUES(programme),
      level=VALUES(level), entry_year=VALUES(entry_year), gender=VALUES(gender),
      height_cm=VALUES(height_cm), weight_kg=VALUES(weight_kg), cap_size_cm=VALUES(cap_size_cm),
      neck_cm=VALUES(neck_cm), chest_cm=VALUES(chest_cm), bust_cm=VALUES(bust_cm), waist_cm=VALUES(waist_cm),
      hips_cm=VALUES(hips_cm), shoulder_cm=VALUES(shoulder_cm), sleeve_cm=VALUES(sleeve_cm),
      top_length_cm=VALUES(top_length_cm), trouser_len_cm=VALUES(trouser_len_cm), skirt_len_cm=VALUES(skirt_len_cm),
      shoe_size=VALUES(shoe_size), color_cap=VALUES(color_cap), color_top=VALUES(color_top),
      color_bottom=VALUES(color_bottom), color_tie=VALUES(color_tie), status=VALUES(status)
  `;

  const params = [
    personRole,
    personId,
    sessionId,
    b.school_id || null,
    b.department_id || null,
    b.programme || null,
    b.level || null,
    b.entry_year || null,
    b.gender || null,
    b.height_cm || null,
    b.weight_kg || null,
    b.cap_size_cm || null,
    b.neck_cm || null,
    b.chest_cm || null,
    b.bust_cm || null,
    b.waist_cm || null,
    b.hips_cm || null,
    b.shoulder_cm || null,
    b.sleeve_cm || null,
    b.top_length_cm || null,
    b.trouser_len_cm || null,
    b.skirt_len_cm || null,
    b.shoe_size || null,
    b.color_cap || null,
    b.color_top || null,
    b.color_bottom || null,
    b.color_tie || null,
    b.complete === '1' ? 'COMPLETED' : 'DRAFT',
  ];

  try {
    await pool.query(sql, params);
  } catch {}

  req.flash(
    'success',
    b.complete === '1'
      ? 'Uniform measurement submitted.'
      : 'Uniform measurement saved (draft).'
  );
  return res.redirect('/student/uniform');
}

// GET /student/uniform/print
export async function uniformPrint(req, res) {
  const personRole = 'STUDENT';

  // stable id + potential name from session
  const pu = req.session?.publicUser || {};
  const personId = (
    pu.username ||
    req.user?.matricNumber ||
    req.session?.user?.matricNumber ||
    ''
  ).trim();

  let sessionId = null;
  try {
    const [cur] = await pool.query(
      'SELECT id FROM sessions WHERE is_current=1 LIMIT 1'
    );
    sessionId = cur?.[0]?.id ?? null;
  } catch {}

  const [rows] = await pool.query(
    `SELECT um.*, s.name AS school_name, d.name AS department_name
     FROM uniform_measurements um
     LEFT JOIN schools s ON s.id = um.school_id
     LEFT JOIN departments d ON d.id = um.department_id
     WHERE um.person_role=? AND um.person_id=? AND um.session_id <=> ? LIMIT 1`,
    [personRole, personId, sessionId]
  );
  const rec = rows[0] || {};

  // Build name: session → DB fallback → staff session
  let personName =
    pu.first_name || pu.last_name
      ? [pu.first_name, pu.middle_name, pu.last_name].filter(Boolean).join(' ')
      : '';

  if (!personName && personId) {
    try {
      const [pr] = await pool.query(
        'SELECT first_name, middle_name, last_name FROM public_users WHERE username=? LIMIT 1',
        [personId]
      );
      if (pr[0])
        personName = [pr[0].first_name, pr[0].middle_name, pr[0].last_name]
          .filter(Boolean)
          .join(' ');
    } catch {}
  }
  if (!personName) {
    personName =
      req.user?.full_name ||
      req.user?.fullName ||
      req.session?.user?.name ||
      '';
  }

  res.render('uniform/print', {
    title: 'Uniform Measurement',
    pageTitle: 'Uniform Measurement',
    record: rec,
    personRole,
    personId,
    personName,
    sessionId,
  });
}
