// app/web/controllers/studentAttendanceReport.controller.js
import pool from '../../core/db.js';

/**
 * Simple date formatting helper: yyyy-mm-dd
 * (used for exports / consistency)
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Helper: load select options for filters
 */
async function loadFilterData() {
  const [schools] = await pool.query(
    'SELECT id, name FROM schools ORDER BY name'
  );
  const [departments] = await pool.query(
    'SELECT id, name, school_id FROM departments ORDER BY name'
  );
  const [sessions] = await pool.query(
    'SELECT id, name FROM sessions ORDER BY id DESC'
  );

  return { schools, departments, sessions };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function int(v, d = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/**
 * Builds WHERE clause + params based on query + logged in staff role.
 * This is your original logic, reused for both data + exports.
 */
function buildWhereClause(req) {
  const q = req.query || {};
  const where = [];
  const params = [];

  // Date range
  if (q.from_date) {
    where.push('sar.attendance_date >= ?');
    params.push(q.from_date);
  }
  if (q.to_date) {
    where.push('sar.attendance_date <= ?');
    params.push(q.to_date);
  }

  // Session / semester
  if (q.session_id && q.session_id !== 'all') {
    where.push('sar.session_id = ?');
    params.push(q.session_id);
  }
  if (q.semester && q.semester !== 'all') {
    where.push('sar.semester = ?');
    params.push(q.semester);
  }

  // School / department
  if (q.school_id && q.school_id !== 'all') {
    where.push('sp.school_id = ?');
    params.push(q.school_id);
  }
  if (q.department_id && q.department_id !== 'all') {
    where.push('sp.department_id = ?');
    params.push(q.department_id);
  }

  // Status filter
  if (q.status && q.status !== 'all') {
    where.push('sar.status = ?');
    params.push(q.status);
  }

  // Course code filter
  if (q.course_code) {
    where.push('c.code = ?');
    params.push(q.course_code.trim().toUpperCase());
  }

  // Free text search (matric / name / email)
  if (q.search) {
    const like = `%${q.search.trim()}%`;
    where.push(
      '(pu.matric_num LIKE ? OR pu.username LIKE ? OR pu.first_name LIKE ? OR pu.last_name LIKE ?)'
    );
    params.push(like, like, like, like);
  }

  // ---------- Role-based visibility ----------
  const sessionUser = req.session.user || {};
  const activeRole = (sessionUser.role || sessionUser.currentRole || '').toLowerCase();
  const staffProfile = req.session.staffProfile || {};

  // HOD: only students in their department
  if (activeRole === 'hod') {
    const deptId = staffProfile.department_id || req.session.staffDepartmentId || null;
    if (deptId) {
      where.push('sp.department_id = ?');
      params.push(deptId);
    }
  }

  // Lecturer: only attendance for courses assigned to them
  if (activeRole === 'lecturer') {
    const staffId = staffProfile.id || req.session.staffId || null;
    if (staffId) {
      // course_assignments aliased as ca in the main query
      where.push('ca.staff_id = ?');
      params.push(staffId);
    }
  }

  // Admin / registry / bursary / ict / others: see everything

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

// Base FROM clause reused by all queries
const BASE_FROM = `
  FROM student_attendance_records sar
  JOIN public_users pu
    ON pu.id = sar.student_id
  JOIN sessions s
    ON s.id = sar.session_id
  JOIN student_profiles sp
    ON sp.user_id = pu.id
  JOIN schools sc
    ON sc.id = sp.school_id
  JOIN departments d
    ON d.id = sp.department_id
  JOIN courses c
    ON c.id = sar.course_id
  LEFT JOIN lecture_times lt
    ON lt.id = sar.lecture_time_id
  LEFT JOIN course_assignments ca
    ON ca.id = lt.course_assignment_id
`;

/**
 * PAGE: GET /staff/student-attendance/report
 * Renders the shell (filters + empty table). Data loads via AJAX.
 */
export async function listPage(req, res, next) {
  try {
    // Match how you do it in course-registration-report
    res.locals.layout = 'layouts/adminlte';

    const { schools, departments, sessions } = await loadFilterData();
    const q = req.query || {};

    const filters = {
      from_date: q.from_date || '',
      to_date: q.to_date || '',
      session_id: q.session_id || '',
      semester: q.semester || '',
      school_id: q.school_id || '',
      department_id: q.department_id || '',
      status: q.status || 'all',
      course_code: q.course_code || '',
      search: q.search || '',
    };

    res.render('student-attendance/report', {
      title: 'Student Attendance Report',
      pageTitle: 'Student Attendance Report',
      sessions,
      schools,
      departments,
      filters,
    });
  } catch (err) {
    console.error('[student-attendance-report:listPage]', err);
    next(err);
  }
}

/**
 * DATA: GET /staff/student-attendance/report/data
 * Returns JSON with rows + summary + pagination (AJAX).
 */
export async function fetchData(req, res) {
  try {
    // Sensible defaults if caller doesn't pass dates
    if (!req.query.from_date) req.query.from_date = todayISO();
    if (!req.query.to_date) req.query.to_date = todayISO();

    const page = int(req.query.page || '1', 1);
    const pageSize = int(req.query.pageSize || '50', 50);
    const offset = (page - 1) * pageSize;

    const { whereSql, params } = buildWhereClause(req);

    const rowsSql = `
      SELECT
        sar.id,
        sar.attendance_date,
        sar.check_in_time,
        sar.status,
        sar.session_id,
        sar.semester,
        pu.matric_num,
        CONCAT(pu.first_name, ' ', pu.last_name) AS student_name,
        s.name AS session_name,
        sc.name AS school_name,
        d.name  AS department_name,
        c.code  AS course_code,
        c.title AS course_title,
        lt.venue
      ${BASE_FROM}
      ${whereSql}
      ORDER BY sar.attendance_date DESC, sar.check_in_time DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(rowsSql, [...params, pageSize, offset]);

    const countSql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN sar.status = 'PRESENT' THEN 1 ELSE 0 END) AS present_count,
        SUM(CASE WHEN sar.status = 'ON_LEAVE' THEN 1 ELSE 0 END) AS on_leave_count,
        SUM(CASE WHEN sar.status = 'ABSENT' THEN 1 ELSE 0 END) AS absent_count
      ${BASE_FROM}
      ${whereSql}
    `;
    const [countRows] = await pool.query(countSql, params);
    const stats = countRows[0] || {
      total: 0,
      present_count: 0,
      on_leave_count: 0,
      absent_count: 0,
    };

    const totalPages = Math.max(1, Math.ceil(stats.total / pageSize));

    res.json({
      ok: true,
      rows,
      summary: {
        total: stats.total || 0,
        present: stats.present_count || 0,
        onleave: stats.on_leave_count || 0,
        absent: stats.absent_count || 0,
      },
      pagination: {
        page,
        pageSize,
        total: stats.total || 0,
        totalPages,
      },
    });
  } catch (err) {
    console.error('[student-attendance-report:fetchData]', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch student attendance data.' });
  }
}

/**
 * Helper for exports (no pagination, big limit)
 */
async function runQueryForExport(req) {
  // We use the same filters as fetchData
  if (!req.query.from_date) req.query.from_date = todayISO();
  if (!req.query.to_date) req.query.to_date = todayISO();

  const { whereSql, params } = buildWhereClause(req);

  const sql = `
    SELECT
      sar.attendance_date,
      sar.check_in_time,
      sar.status,
      sar.session_id,
      sar.semester,
      pu.matric_num,
      CONCAT(pu.first_name, ' ', pu.last_name) AS student_name,
      s.name AS session_name,
      sc.name AS school_name,
      d.name  AS department_name,
      c.code  AS course_code,
      c.title AS course_title,
      lt.venue
    ${BASE_FROM}
    ${whereSql}
    ORDER BY sar.attendance_date DESC, sar.check_in_time DESC
    LIMIT 50000
  `;

  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * CSV export: GET /staff/student-attendance/report/export.csv
 */
export async function exportCsv(req, res) {
  try {
    const rows = await runQueryForExport(req);

    const headers = [
      'Date',
      'Time In',
      'Status',
      'Matric No',
      'Student Name',
      'Session',
      'Semester',
      'School',
      'Department',
      'Course Code',
      'Course Title',
      'Venue',
    ];

    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const lines = [headers.join(',')];

    for (const r of rows) {
      lines.push([
        formatDate(r.attendance_date),
        r.check_in_time || '',
        r.status || '',
        r.matric_num || '',
        r.student_name || '',
        r.session_name || '',
        r.semester || '',
        r.school_name || '',
        r.department_name || '',
        r.course_code || '',
        r.course_title || '',
        r.venue || '',
      ].map(escape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="student_attendance_report.csv"'
    );
    res.send('\uFEFF' + lines.join('\r\n')); // BOM for Excel UTF-8
  } catch (err) {
    console.error('[student-attendance-report:exportCsv]', err);
    res.status(500).send('CSV export failed.');
  }
}

/**
 * Excel export: GET /staff/student-attendance/report/export.xlsx
 */
export async function exportXlsx(req, res) {
  try {
    const rows = await runQueryForExport(req);
    const xlsx = await import('xlsx'); // npm i xlsx

    const data = rows.map((r) => ({
      Date: formatDate(r.attendance_date),
      'Time In': r.check_in_time || '',
      Status: r.status || '',
      'Matric No': r.matric_num || '',
      'Student Name': r.student_name || '',
      Session: r.session_name || '',
      Semester: r.semester || '',
      School: r.school_name || '',
      Department: r.department_name || '',
      'Course Code': r.course_code || '',
      'Course Title': r.course_title || '',
      Venue: r.venue || '',
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Student Attendance');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="student_attendance_report.xlsx"'
    );
    res.send(buf);
  } catch (err) {
    console.error('[student-attendance-report:exportXlsx]', err);
    res.status(500).send('XLSX export failed. Ensure package "xlsx" is installed.');
  }
}

/**
 * PDF export: GET /staff/student-attendance/report/export.pdf
 */
export async function exportPdf(req, res) {
  try {
    const rows = await runQueryForExport(req);
    const PDFDocument = (await import('pdfkit')).default; // npm i pdfkit

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="student_attendance_report.pdf"'
    );
    doc.pipe(res);

    doc.fontSize(14).text('Student Attendance Report', { align: 'center' });
    doc.moveDown(0.5);

    const headers = [
      'Date',
      'Matric No',
      'Student Name',
      'Session',
      'Semester',
      'School',
      'Department',
      'Course',
      'Status',
      'Time In',
      'Venue',
    ];

    doc.fontSize(9).text(headers.join(' | '), { align: 'left' });
    doc.moveDown(0.5);
    doc.moveTo(24, doc.y).lineTo(820, doc.y).stroke();
    doc.moveDown(0.3);

    rows.forEach((r) => {
      const line = [
        formatDate(r.attendance_date),
        r.matric_num || '',
        r.student_name || '',
        r.session_name || '',
        r.semester || '',
        r.school_name || '',
        r.department_name || '',
        `${r.course_code || ''} - ${r.course_title || ''}`,
        r.status || '',
        r.check_in_time || '',
        r.venue || '',
      ].join(' | ');

      doc.text(line, { width: 820 - 48 });
      if (doc.y > 560) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 24 });
      }
    });

    doc.end();
  } catch (err) {
    console.error('[student-attendance-report:exportPdf]', err);
    res.status(500).send('PDF export failed. Ensure package "pdfkit" is installed.');
  }
}
