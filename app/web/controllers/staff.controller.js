// app/web/controllers/staff.controller.js
import { pool } from '../../core/db.js';
import bcrypt from 'bcryptjs';

/* -------------------- Dashboard -------------------- */
export const transcriptsMenu = (_req,res)=>res.render('pages/staff-transcripts');
export const resultsMenu     = (_req,res)=>res.render('pages/staff-results');
export const recordsMenu     = (_req,res)=>res.render('pages/staff-records');

export const dashboard = async (req, res) => {
  const user = req.session?.user || null;

  // sidebar (unchanged)
  const sidebar = [
    { label: 'Dashboard', href: '/staff/dashboard', icon: 'fas fa-tachometer-alt', active: true },
    { label: 'Student Academic Records', href: '/records', icon: 'fas fa-table' },
    { label: 'Result Computation', href: '/results', icon: 'fas fa-calculator' },
    { label: 'Generate Transcript', href: '/transcripts/generate', icon: 'far fa-file-alt' },
    { label: 'View / Download Transcript', href: '/transcripts/view', icon: 'far fa-file-pdf' },
    { label: 'Send Transcript', href: '/transcripts/send', icon: 'fas fa-paper-plane' }
  ];

  try {
    // 1) Real staff total
    const [[{ cnt: staffTotal }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM staff'
    ); // staff schema in clean DB. :contentReference[oaicite:4]{index=4}

    // 2) Last 5 attendance activities (newest first)
    const [rows] = await pool.query(
      `SELECT
         ar.staff_id,
         s.staff_no,
         s.full_name,
         ar.status,
         ar.check_in_time,
         ar.check_out_time,
         ar.created_at
       FROM attendance_records ar
       JOIN staff s ON s.id = ar.staff_id
       ORDER BY ar.created_at DESC
       LIMIT 5`
    ); // tables + columns from clean DB dump. :contentReference[oaicite:5]{index=5}

    // Map DB rows to what the dashboard table renders now
    const attendance = rows.map(r => {
      const raw = String(r.status || '');
      let status = raw;
      const upper = raw.toUpperCase();
      if (upper.startsWith('PRESENT')) status = 'Online';
      else if (upper === 'ON LEAVE')   status = 'On-Leave';
      else if (upper === 'ABSENT')     status = 'Absent';

      return {
        staffId: r.staff_no,                         // dashboard “ID” col
        name:    r.full_name,
        status,
        time:    r.check_in_time || r.check_out_time || '' // dashboard “Time” col
      };
    });

    // (Optional) Current session name for the blue box; fall back to static if not found
    let sessionName = '2025/2026';
    try {
      const [[cur]] = await pool.query(
        'SELECT name FROM sessions WHERE is_current = 1 LIMIT 1'
      );
      if (cur && cur.name) sessionName = cur.name;
    } catch (_) { /* non-fatal */ } // sessions table exists in clean DB. :contentReference[oaicite:6]{index=6}

    // Render page, feeding the variables your EJS expects today
    res.render('pages/staff-dashboard', {
      title: 'Staff Dashboard',
      pageTitle: 'Dashboard',
      role: user?.role,
      user,
      sidebar,

      // boxes: only the red box absolutely needs live data
      stats: {
        sessionName,
        totalApplicants: 1157,  // keep existing dummy until you wire real source
        totalStudents:   2310,  // keep existing dummy until you wire real source
        totalStaff:      staffTotal
      },

      // attendance table data (what the EJS iterates)
      attendance,

      // existing demo chart payload left as-is
      performanceData: {
        labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
        area:  [28,48,40,19,86,27,90],
        donut: [40,30,30],
        line:  [10,20,30,40,50,60,70]
      }
    });
  } catch (err) {
    console.error('dashboard error:', err);
    // render with safe fallbacks so the page never 500s
    res.render('pages/staff-dashboard', {
      title: 'Staff Dashboard',
      pageTitle: 'Dashboard',
      role: user?.role, user, sidebar,
      stats: { sessionName: '2025/2026', totalApplicants: 1157, totalStudents: 2310, totalStaff: 0 },
      attendance: [],
      performanceData: {
        labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
        area:  [28,48,40,19,86,27,90],
        donut: [40,30,30],
        line:  [10,20,30,40,50,60,70]
      }
    });
  }
};

/* -------------------- Password Reset page + APIs -------------------- */
export async function passwordResetPage(_req, res){
  try { res.render('staff/password-reset', { title:'Password Reset' }); }
  catch(e){ console.error(e); res.status(500).send('Failed to load page'); }
}

// GET /staff/api/password/users
export async function listUsersForPasswordReset(req, res) {
  try {
    const {
      page = 1, pageSize = 10, staffNumber = '',
      department = '', school = '', email = '', name = ''
    } = req.query;

    const limit  = Math.max(1, Number(pageSize));
    const offset = Math.max(0, (Number(page) - 1) * limit);

    const filters = []; const params = [];
    if (staffNumber) { filters.push('s.staff_no LIKE ?');       params.push(`%${staffNumber}%`); }
    if (department)  { filters.push('d.name LIKE ?');           params.push(`%${department}%`); }
    if (school)      { filters.push('sc.name LIKE ?');          params.push(`%${school}%`); }
    if (email)       { filters.push('s.email LIKE ?');          params.push(`%${email}%`); }
    if (name)        { filters.push('(s.full_name LIKE ? OR s.username LIKE ?)'); params.push(`%${name}%`, `%${name}%`); }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const dataSql = `
      SELECT
        s.id, s.staff_no, s.username, s.email, s.status, s.full_name AS name,
        COALESCE(d.name,'')  AS department_name,
        COALESCE(sc.name,'') AS school_name
      FROM staff s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN schools     sc ON sc.id = s.school_id
      ${where}
      ORDER BY s.full_name ASC, s.id ASC
      LIMIT ? OFFSET ?`;

    const countSql = `
      SELECT COUNT(*) AS cnt
      FROM staff s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN schools     sc ON sc.id = s.school_id
      ${where}`;

    const [rows]      = await pool.query(dataSql, [...params, limit, offset]);
    const [[{ cnt }]] = await pool.query(countSql, params);

    return res.json({
      ok: true, rows, page: Number(page), pageSize: limit,
      total: Number(cnt) || 0,
      totalPages: Math.max(1, Math.ceil((Number(cnt) || 0) / limit)),
    });
  } catch (err) {
    console.error('listUsersForPasswordReset', err);
    return res.status(500).json({ ok: false, error: 'Failed to load users.' });
  }
}

export async function resetPasswordToCollege1(req, res){
  try{
    const id = Number(req.params.id || 0);
    if(!id) return res.status(400).json({ success:false, message:'Missing id' });

    const hash = await bcrypt.hash('College1', 10);
    await pool.query('UPDATE staff SET password_hash=? WHERE id=? LIMIT 1', [hash, id]);

    res.json({ success:true });
  }catch(e){
    console.error('resetPasswordToCollege1', e);
    res.status(500).json({ success:false, message:'Reset failed' });
  }
}

export async function changePasswordByAdmin(req, res){
  try{
    const { staff_id, password } = req.body || {};
    if(!staff_id || !password) return res.status(400).json({ success:false, message:'Missing fields' });

    const hash = await bcrypt.hash(String(password), 10);
    await pool.query('UPDATE staff SET password_hash=? WHERE id=? LIMIT 1', [hash, Number(staff_id)]);

    res.json({ success:true });
  }catch(e){
    console.error('changePasswordByAdmin', e);
    res.status(500).json({ success:false, message:'Change failed' });
  }
}
