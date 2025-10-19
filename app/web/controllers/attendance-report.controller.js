import {
  queryAttendance,
  summarizeCounts,
  listSchools,
  listDepartments,
  isAdminUser,
  normalizeStatusFilter,
} from '../../services/attendance-report.service.js';

// Helpers
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function int(v, d = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function oneFlash(req, key) {
  if (!req.flash) return '';
  const arr = req.flash(key);
  return Array.isArray(arr) && arr.length ? String(arr[0]) : '';
}

// Render page (filters + empty table; data loads via AJAX)
export async function listPage(req, res) {
  try {
    const user = req.session?.user || {};
    const admin = isAdminUser(user);

    const from = req.query.from || todayISO();
    const to = req.query.to || todayISO();

    // Default filter behavior
    const schoolId = admin ? (req.query.schoolId || '') : (user.school_id || '');
    const departmentId = admin ? (req.query.departmentId || '') : (user.department_id || '');
    const staffId = req.query.staffId || '';
    const status = normalizeStatusFilter(req.query.status || '');
    const onlyMyDept = admin ? (req.query.onlyMyDept === '1') : true; // force for non-admin

    // Dropdown data
    const schools = await listSchools();
    const departments = await listDepartments(schoolId || null);

    const messages = {
      success: oneFlash(req, 'success'),
      error: oneFlash(req, 'error'),
    };

    res.render('attendance/report', {
      title: 'Attendance Report',
      filters: { from, to, schoolId, departmentId, staffId, status, onlyMyDept },
      admin,
      schools,
      departments,
      messages,
      user,
    });
  } catch (e) {
    console.error('[attendance-report:listPage] ', e);
    req.flash && req.flash('error', 'Failed to load report page.');
    res.redirect('/staff/dashboard');
  }
}

// Data endpoint (AJAX, server-side pagination)
export async function fetchData(req, res) {
  try {
    const user = req.session?.user || {};
    const admin = isAdminUser(user);

    const from = req.query.from || todayISO();
    const to = req.query.to || todayISO();
    const page = int(req.query.page || 1, 1);
    const pageSize = int(req.query.pageSize || 10, 10);

    // Respect access scope
    let schoolId = req.query.schoolId || '';
    let departmentId = req.query.departmentId || '';
    const staffId = req.query.staffId || '';
    const status = normalizeStatusFilter(req.query.status || '');
    const onlyMyDept = admin ? (req.query.onlyMyDept === '1') : true;

    if (!admin) {
      schoolId = user.school_id || '';
      departmentId = user.department_id || '';
    } else if (onlyMyDept) {
      // Admin narrowed to their department (if they have one in session)
      if (user.school_id) schoolId = user.school_id;
      if (user.department_id) departmentId = user.department_id;
    }

    const result = await queryAttendance({
      from, to, schoolId, departmentId, staffId, status, page, pageSize,
    });

    const summary = await summarizeCounts({
      from, to, schoolId, departmentId, staffId, status,
    });

    res.json({
      ok: true,
      rows: result.rows,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
      summary,
    });
  } catch (e) {
    console.error('[attendance-report:fetchData] ', e);
    res.status(500).json({ ok: false, error: 'Failed to fetch report data.' });
  }
}

// Exports (same filters, no pagination)
async function runQueryForExport(req) {
  const user = req.session?.user || {};
  const admin = isAdminUser(user);

  const from = req.query.from || todayISO();
  const to = req.query.to || todayISO();

  let schoolId = req.query.schoolId || '';
  let departmentId = req.query.departmentId || '';
  const staffId = req.query.staffId || '';
  const status = normalizeStatusFilter(req.query.status || '');
  const onlyMyDept = admin ? (req.query.onlyMyDept === '1') : true;

  if (!admin) {
    schoolId = user.school_id || '';
    departmentId = user.department_id || '';
  } else if (onlyMyDept) {
    if (user.school_id) schoolId = user.school_id;
    if (user.department_id) departmentId = user.department_id;
  }

  // Big page size to fetch all in-range rows
  const result = await queryAttendance({
    from, to, schoolId, departmentId, staffId, status,
    page: 1, pageSize: 50000,
  });

  return { rows: result.rows, filters: { from, to, schoolId, departmentId, staffId, status } };
}

export async function exportCsv(req, res) {
  try {
    const { rows } = await runQueryForExport(req);

    const headers = [
      'Date','Staff ID','Staff Name','School','Department',
      'Time In','Time Out','Status','Reason','Checkout By'
    ];
    const csv = [
      headers.join(','),
      ...rows.map(r => ([
        r.date,
        `"${r.staff_no || ''}"`,
        `"${r.full_name || ''}"`,
        `"${r.school_name || r.school_id || ''}"`,
        `"${r.department_name || r.department_id || ''}"`,
        r.check_in_time || '',
        r.check_out_time || '',
        `"${r.status || ''}"`,
        `"${r.leave_reason || ''}"`,
        r.check_out_time ? (r.marked_by_system ? 'System' : 'Staff') : ''
      ].join(',')))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
    return res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (e) {
    console.error('[attendance-report:exportCsv] ', e);
    res.status(500).send('CSV export failed.');
  }
}

export async function exportXlsx(req, res) {
  try {
    const { rows } = await runQueryForExport(req);
    const xlsx = await import('xlsx'); // requires: npm i xlsx

    const data = rows.map(r => ({
      Date: r.date,
      'Staff ID': r.staff_no || '',
      'Staff Name': r.full_name || '',
      School: r.school_name || r.school_id || '',
      Department: r.department_name || r.department_id || '',
      'Time In': r.check_in_time || '',
      'Time Out': r.check_out_time || '',
      Status: r.status || '',
      Reason: r.leave_reason || '',
      'Checkout By': r.check_out_time ? (r.marked_by_system ? 'System' : 'Staff') : ''
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.xlsx"');
    return res.send(buf);
  } catch (e) {
    console.error('[attendance-report:exportXlsx] ', e);
    res.status(500).send('XLSX export failed. Ensure package "xlsx" is installed.');
  }
}

export async function exportPdf(req, res) {
  try {
    const { rows } = await runQueryForExport(req);
    const PDFDocument = (await import('pdfkit')).default; // requires: npm i pdfkit

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.pdf"');
    doc.pipe(res);

    doc.fontSize(14).text('Attendance Report', { align: 'center' });
    doc.moveDown(0.5);

    // simple compact table
    const headers = ['Date','Staff ID','Staff Name','School','Department','Time In','Time Out','Status','Reason','Checkout By'];
    const colW = [80,60,130,90,100,60,60,110,110,80];
    let x = 24, y = 60;

    doc.fontSize(9).fillColor('#000').text(headers.join(' | '), x, y);
    y += 14;
    doc.moveTo(24, y).lineTo(820, y).stroke();
    y += 6;

    rows.forEach(r => {
      const line = [
        r.date,
        r.staff_no || '',
        r.full_name || '',
        r.school_name || r.school_id || '',
        r.department_name || r.department_id || '',
        r.check_in_time || '',
        r.check_out_time || '',
        r.status || '',
        r.leave_reason || '',
        r.check_out_time ? (r.marked_by_system ? 'System' : 'Staff') : ''
      ].join(' | ');
      doc.text(line, x, y, { width: 820 - 24 - 24 });
      y += 12;
      if (y > 560) { doc.addPage({ size:'A4', layout:'landscape', margin:24 }); y = 40; }
    });

    doc.end();
  } catch (e) {
    console.error('[attendance-report:exportPdf] ', e);
    res.status(500).send('PDF export failed. Ensure package "pdfkit" is installed.');
  }
}
