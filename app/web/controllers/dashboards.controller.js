// app/web/controllers/dashboards.controller.js
import { pool } from '../../core/db.js';

/** Helper: get scope (dept/school) from logged-in user */
function scopeFromUser(user) {
  const role = String(user && user.role ? user.role : '').toLowerCase();

  const school_id =
    user && (user.school_id || user.schoolId)
      ? (user.school_id || user.schoolId)
      : null;

  const department_id =
    user && (user.department_id || user.departmentId)
      ? (user.department_id || user.departmentId)
      : null;

  return { role, school_id, department_id };
}

/** Shared: get current session name (safe fallback) */
async function getCurrentSessionName() {
  try {
    const [[row]] = await pool.query(`SELECT name FROM sessions WHERE is_current=1 LIMIT 1`);
    return row && row.name ? row.name : '2025/2026';
  } catch {
    return '2025/2026';
  }
}

/** Shared: attendance list (scoped) */
async function getAttendanceRows({ school_id, department_id, scope = 'all' }) {
  const where = [];
  const params = [];

  if (scope === 'department' && department_id) { where.push('ar.department_id=?'); params.push(department_id); }
  if (scope === 'school'     && school_id)     { where.push('ar.school_id=?');     params.push(school_id);     }

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT ar.staff_id, s.staff_no, s.full_name, ar.status, ar.check_in_time, ar.check_out_time, ar.created_at
       FROM attendance_records ar
       JOIN staff s ON s.id = ar.staff_id
       ${w}
       ORDER BY ar.created_at DESC
       LIMIT 5`
  );

  return rows.map(r => {
    const raw = String(r.status || '');
    const upper = raw.toUpperCase();
    let status = raw;
    if (upper.startsWith('PRESENT')) status = 'Online';
    else if (upper === 'ON LEAVE')   status = 'On-Leave';
    else if (upper === 'ABSENT')     status = 'Absent';

    return {
      staffId: r.staff_no,
      name:    r.full_name,
      status,
      time:    r.check_in_time || r.check_out_time || ''
    };
  });
}

/** Shared: staff totals (scoped) */
async function getStaffTotal({ school_id, department_id, scope = 'all' }) {
  if (scope === 'department' && department_id) {
    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff WHERE department_id=?`, [department_id]);
    return Number(cnt) || 0;
  }
  if (scope === 'school' && school_id) {
    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff WHERE school_id=?`, [school_id]);
    return Number(cnt) || 0;
  }
  const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM staff`);
  return Number(cnt) || 0;
}

/** Shared: placeholder “recent course registrations”. Replace with real table when ready. */
async function getRecentCourseRegsScoped(_scope) {
  return [
    { date: '2025-10-20', matric: 'IJR/24/1001', name: 'A. Student', course: 'GNS101' },
    { date: '2025-10-21', matric: 'IJR/24/1002', name: 'B. Student', course: 'MTH101' },
    { date: '2025-10-22', matric: 'IJR/24/1003', name: 'C. Student', course: 'PHY101' },
    { date: '2025-10-23', matric: 'IJR/24/1004', name: 'D. Student', course: 'CHM101' },
    { date: '2025-10-24', matric: 'IJR/24/1005', name: 'E. Student', course: 'CSC101' },
  ];
}

/** Bursary: payments (top 5) using payment_invoices (fallback to general_payments if needed) */
async function getRecentPaymentsForSchool(school_id) {
  const [rows] = await pool.query(
    `SELECT pi.id, pi.rrr, pi.payee_fullname, pi.amount, pi.payment_type_id, pi.created_at, pt.name AS payment_type
       FROM payment_invoices pi
       LEFT JOIN payment_types pt ON pt.id = pi.payment_type_id
       ORDER BY pi.created_at DESC
       LIMIT 5`
  );
  return rows.map(r => ({
    payerName: r.payee_fullname,
    department: '-', // not available on invoice table; populate when schema allows
    amount: Number(r.amount || 0).toFixed(2),
    rrr: r.rrr || '',
    paymentType: r.payment_type || 'N/A',
    date: r.created_at
  }));
}

/** Shared renderer into the same dashboard EJS (keeps current “look”) */
async function renderDashboard(req, res, { scope, tailor = {} }) {
  const user = (req.session && req.session.user) ? req.session.user : null;
  const { school_id, department_id } = scopeFromUser(user);

  const sessionName = await getCurrentSessionName();
  const attendance = await getAttendanceRows({ school_id, department_id, scope: tailor.attendanceScope || 'all' });
  const totalStaff = await getStaffTotal({ school_id, department_id, scope: tailor.staffScope || 'all' });

  const stats = {
    sessionName,
    totalApplicants: (typeof tailor.totalApplicants === 'number') ? tailor.totalApplicants : 1157,
    totalStudents:   (typeof tailor.totalStudents === 'number')   ? tailor.totalStudents   : 2310,
    totalStaff:      totalStaff
  };

  const recentCourseRegs =
    tailor.recentPayments ? [] : await getRecentCourseRegsScoped({ school_id, department_id, scope: tailor.coursesScope || 'all' });

  const performanceData = {
    labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
    area:  [28,48,40,19,86,27,90],
    donut: [40,30,30],
    line:  [10,20,30,40,50,60,70]
  };

  let payments = [];
  if (tailor.recentPayments) {
    payments = await getRecentPaymentsForSchool(school_id);
  }

  res.render('pages/staff-dashboard', {
    title: tailor.title || 'Dashboard',
    pageTitle: 'Dashboard',
    role: user && user.role,
    user,
    stats,
    attendance,
    recentCourseRegs,
    payments,
    performanceData
  });
}

/* ─────────────────────────── Public handlers per role ─────────────────────────── */

export async function lecturerDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'department',
    tailor: {
      title: 'Lecturer Dashboard',
      attendanceScope: 'department',
      staffScope: 'department',
      coursesScope: 'department'
    }
  });
}

export async function hodDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'department',
    tailor: {
      title: 'HOD Dashboard',
      attendanceScope: 'department',
      staffScope: 'department',
      coursesScope: 'department'
    }
  });
}

export async function deanDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'school',
    tailor: {
      title: 'Dean Dashboard',
      attendanceScope: 'school',
      staffScope: 'school',
      coursesScope: 'school'
    }
  });
}

export async function bursaryDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'school',
    tailor: {
      title: 'Bursary Dashboard',
      attendanceScope: 'school',
      staffScope: 'school',
      recentPayments: true
    }
  });
}

export async function registryDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'school',
    tailor: {
      title: 'Registry Dashboard',
      attendanceScope: 'school',
      staffScope: 'school',
      coursesScope: 'all'
    }
  });
}

export async function admissionOfficerDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'school',
    tailor: {
      title: 'Admission Officer Dashboard',
      attendanceScope: 'school',
      staffScope: 'school',
      coursesScope: 'all'
    }
  });
}

export async function ictDashboard(req, res) {
  return renderDashboard(req, res, {
    scope: 'school',
    tailor: {
      title: 'ICT Dashboard',
      attendanceScope: 'school',
      staffScope: 'school',
      coursesScope: 'all'
    }
  });
}
