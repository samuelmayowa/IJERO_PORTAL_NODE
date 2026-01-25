import xlsx from "xlsx";
import { pool } from "../../core/db.js";

function safeStr(v) { return (v ?? "").toString().trim(); }
function safeInt(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function safeFloat(v) { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : 0; }

function getRole(req, res) {
  const r =
    safeStr(req?.session?.staffUser?.role) ||
    safeStr(req?.session?.user?.role) ||
    safeStr(res?.locals?.user?.role);
  return r.toLowerCase();
}
function getStaffId(req, res) {
  return (
    safeInt(req?.session?.staffUser?.id) ||
    safeInt(req?.session?.user?.id) ||
    safeInt(res?.locals?.user?.id)
  );
}

async function getStaffScope(conn, staffId) {
  const [rows] = await conn.query(
    `SELECT id, school_id, department_id FROM staff WHERE id = ? LIMIT 1`,
    [staffId]
  );
  const row = rows?.[0] || {};
  return { school_id: safeInt(row.school_id), department_id: safeInt(row.department_id) };
}

async function scopeSqlForRole(conn, role, staffId) {
  // scope by course department/school
  if (role === "hod") {
    const s = await getStaffScope(conn, staffId);
    return { sql: ` AND c.department_id = ? `, params: [s.department_id] };
  }
  if (role === "dean") {
    const s = await getStaffScope(conn, staffId);
    return { sql: ` AND d.school_id = ? `, params: [s.school_id] };
  }
  return { sql: "", params: [] };
}

async function getSessions() {
  const [sessions] = await pool.query(
    `SELECT id, name, is_current FROM sessions ORDER BY is_current DESC, id DESC`
  );
  return sessions || [];
}

function baseLists() {
  return {
    semesters: [
      { value: "FIRST", label: "First" },
      { value: "SECOND", label: "Second" },
    ],
    levels: ["ND1", "ND2", "HND1", "HND2"],
    // Approved statuses (tweak if needed)
    approvedStatuses: ["BUSINESS_APPROVED", "FINAL", "REGISTRY_APPROVED"],
  };
}

function asCsv(rows, headers) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => esc(r[h])).join(","));
  }
  return lines.join("\n");
}

function sendExcel(res, sheetName, rows, headerOrder, fileName) {
  const wsData = [headerOrder, ...rows.map(r => headerOrder.map(h => r[h]))];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  xlsx.utils.book_append_sheet(wb, ws, sheetName);
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buf);
}

/* ---------------- HOME ---------------- */
export async function reportsHome(req, res) {
  res.render("results/reports/home", { pageTitle: "Result Reports" });
}

/* ---------------- A) MASTER MARK SHEET ---------------- */
async function fetchMasterMarkSheet(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);

    const sessionId = safeInt(req.query.sessionId);
    const semester = safeStr(req.query.semester).toUpperCase();
    const level = safeStr(req.query.level).toUpperCase();
    const courseId = safeInt(req.query.courseId);
    const batchId = safeInt(req.query.batchId);
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all

    if (!sessionId || !semester || !level || !courseId) {
      return { rows: [], meta: { message: "Pick session, semester, level, course." } };
    }

    const { sql: scopeSql, params: scopeParams } = await scopeSqlForRole(conn, role, staffId);

    let statusSql = "";
    const params = [sessionId, semester, level, courseId];
    if (batchId) {
      statusSql += " AND rb.batch_id = ? ";
      params.push(batchId);
    }

    if (statusMode === "approved") {
      statusSql += " AND rb.status IN ('BUSINESS_APPROVED','FINAL','REGISTRY_APPROVED') ";
    }

    const sql = `
      SELECT
        pu.matric_number AS matric,
        CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS full_name,
        cr.reg_type AS reg_type,
        cr.ca1 AS ca1,
        cr.ca2 AS ca2,
        cr.ca3 AS ca3,
        cr.exam_score AS exam,
        cr.total_score AS total,
        cr.grade AS grade,
        cr.points AS gp,
        c.units AS units
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN public_users pu ON pu.id = cr.student_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        AND rb.course_id = ?
        ${statusSql}
        ${scopeSql}
      ORDER BY pu.matric_number ASC
    `;

    const [rows] = await conn.query(sql, [...params, ...scopeParams]);

    return { rows: rows || [], meta: { sessionId, semester, level, courseId, batchId, statusMode } };
  } finally {
    conn.release();
  }
}

export async function viewMasterMarkSheet(req, res) {
  const sessions = await getSessions();
  const { semesters, levels } = baseLists();
  res.render("results/reports/master-mark-sheet", {
    pageTitle: "Master Mark Sheet",
    sessions,
    semesters,
    levels,
  });
}

export async function apiMasterMarkSheet(req, res) {
  try {
    const out = await fetchMasterMarkSheet(req, res);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiMasterMarkSheet error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportMasterMarkSheetCsv(req, res) {
  const out = await fetchMasterMarkSheet(req, res);
  const rows = (out.rows || []).map(r => ({
    matric: r.matric,
    full_name: r.full_name,
    reg_type: r.reg_type,
    units: r.units,
    ca1: r.ca1,
    ca2: r.ca2,
    ca3: r.ca3,
    exam: r.exam,
    total: r.total,
    grade: r.grade,
    gp: r.gp,
  }));
  const headers = ["matric","full_name","reg_type","units","ca1","ca2","ca3","exam","total","grade","gp"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="master_mark_sheet.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportMasterMarkSheetExcel(req, res) {
  const out = await fetchMasterMarkSheet(req, res);
  const rows = (out.rows || []).map(r => ({
    matric: r.matric,
    full_name: r.full_name,
    reg_type: r.reg_type,
    units: r.units,
    ca1: r.ca1,
    ca2: r.ca2,
    ca3: r.ca3,
    exam: r.exam,
    total: r.total,
    grade: r.grade,
    gp: r.gp,
  }));
  const headers = ["matric","full_name","reg_type","units","ca1","ca2","ca3","exam","total","grade","gp"];
  sendExcel(res, "MasterMarkSheet", rows, headers, "master_mark_sheet.xlsx");
}

export async function printMasterMarkSheet(req, res) {
  const out = await fetchMasterMarkSheet(req, res);
  res.render("results/reports/print-master-mark-sheet", { layout: false, ...out });
}

/* ---------------- B) SEMESTER RESULT ---------------- */
async function fetchSemesterResult(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);

    const sessionId = safeInt(req.query.sessionId);
    const semester = safeStr(req.query.semester).toUpperCase();
    const level = safeStr(req.query.level).toUpperCase();
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all

    if (!sessionId || !semester || !level) {
      return { rows: [], meta: { message: "Pick session, semester and level." } };
    }

    const { sql: scopeSql, params: scopeParams } = await scopeSqlForRole(conn, role, staffId);

    let statusSql = "";
    if (statusMode === "approved") {
      statusSql += " AND rb.status IN ('BUSINESS_APPROVED','FINAL','REGISTRY_APPROVED') ";
    }

    const sql = `
      SELECT
        pu.matric_number AS matric,
        CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS full_name,
        SUM(c.units) AS total_units,
        SUM(c.units * cr.points) AS total_points
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN public_users pu ON pu.id = cr.student_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
        ${scopeSql}
      GROUP BY pu.id, pu.matric_number
      ORDER BY pu.matric_number ASC
    `;
    const [rows] = await conn.query(sql, [sessionId, semester, level, ...scopeParams]);

    const outRows = (rows || []).map(r => {
      const units = safeFloat(r.total_units);
      const pts = safeFloat(r.total_points);
      const gpa = units > 0 ? (pts / units) : 0;
      return {
        matric: r.matric,
        full_name: r.full_name,
        total_units: units,
        gpa: Number(gpa.toFixed(2)),
      };
    });

    return { rows: outRows, meta: { sessionId, semester, level, statusMode } };
  } finally {
    conn.release();
  }
}

export async function viewSemesterResult(req, res) {
  const sessions = await getSessions();
  const { semesters, levels } = baseLists();
  res.render("results/reports/semester-result", {
    pageTitle: "Semester Result Report",
    sessions,
    semesters,
    levels,
  });
}

export async function apiSemesterResult(req, res) {
  try {
    const out = await fetchSemesterResult(req, res);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiSemesterResult error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportSemesterResultCsv(req, res) {
  const out = await fetchSemesterResult(req, res);
  const rows = out.rows || [];
  const headers = ["matric","full_name","total_units","gpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="semester_result.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportSemesterResultExcel(req, res) {
  const out = await fetchSemesterResult(req, res);
  const rows = out.rows || [];
  const headers = ["matric","full_name","total_units","gpa"];
  sendExcel(res, "SemesterResult", rows, headers, "semester_result.xlsx");
}

export async function printSemesterResult(req, res) {
  const out = await fetchSemesterResult(req, res);
  res.render("results/reports/print-semester-result", { layout: false, ...out });
}

/* ---------------- C) GRADUATING LIST ---------------- */
async function fetchGraduatingList(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);

    const level = safeStr(req.query.level).toUpperCase();
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all
    const programmeText = safeStr(req.query.programme); // from student_imports

    if (!level) {
      return { rows: [], meta: { message: "Pick final level (e.g ND2/HND2)." } };
    }

    const { sql: scopeSql, params: scopeParams } = await scopeSqlForRole(conn, role, staffId);

    let statusSql = "";
    if (statusMode === "approved") {
      statusSql += " AND rb.status IN ('BUSINESS_APPROVED','FINAL','REGISTRY_APPROVED') ";
    }

    let progSql = "";
    const params = [level];
    if (programmeText) {
      progSql = " AND si.programme = ? ";
      params.push(programmeText);
    }

    const sql = `
      SELECT
        pu.matric_number AS matric,
        CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS full_name,
        si.school AS school,
        si.department AS department,
        si.programme AS programme,
        SUM(c.units) AS total_units,
        SUM(c.units * cr.points) AS total_points
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      JOIN public_users pu ON pu.id = cr.student_id
      LEFT JOIN student_imports si ON si.student_email = pu.username
      WHERE rb.level = ?
        ${statusSql}
        ${progSql}
        ${scopeSql}
      GROUP BY pu.id, pu.matric_number
      ORDER BY pu.matric_number ASC
    `;

    const [rows] = await conn.query(sql, [...params, ...scopeParams]);

    const outRows = (rows || []).map(r => {
      const units = safeFloat(r.total_units);
      const pts = safeFloat(r.total_points);
      const cgpa = units > 0 ? (pts / units) : 0;
      return {
        matric: r.matric,
        full_name: r.full_name,
        school: r.school || "",
        department: r.department || "",
        programme: r.programme || "",
        cgpa: Number(cgpa.toFixed(2)),
      };
    });

    return { rows: outRows, meta: { level, programme: programmeText, statusMode } };
  } finally {
    conn.release();
  }
}

export async function viewGraduatingList(req, res) {
  const { levels } = baseLists();
  res.render("results/reports/graduating-list", {
    pageTitle: "Graduating List",
    levels,
  });
}

export async function apiGraduatingList(req, res) {
  try {
    const out = await fetchGraduatingList(req, res);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiGraduatingList error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportGraduatingListCsv(req, res) {
  const out = await fetchGraduatingList(req, res);
  const rows = out.rows || [];
  const headers = ["matric","full_name","school","department","programme","cgpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="graduating_list.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportGraduatingListExcel(req, res) {
  const out = await fetchGraduatingList(req, res);
  const rows = out.rows || [];
  const headers = ["matric","full_name","school","department","programme","cgpa"];
  sendExcel(res, "GraduatingList", rows, headers, "graduating_list.xlsx");
}

export async function printGraduatingList(req, res) {
  const out = await fetchGraduatingList(req, res);
  res.render("results/reports/print-graduating-list", { layout: false, ...out });
}
