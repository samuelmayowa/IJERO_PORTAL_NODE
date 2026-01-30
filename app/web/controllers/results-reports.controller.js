// app/web/controllers/results-reports.controller.js

import xlsx from "xlsx";
import pool from "../../core/db.js";

/* ---------------- tiny utils ---------------- */

function safeInt(v) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}
function safeFloat(v) {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function safeStr(v) {
  return String(v ?? "").trim();
}
function nowStamp() {
  // readable “Printed @ …” format
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  let hh = d.getHours();
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 || 12;
  const mi = pad(d.getMinutes());
  return `${dd}/${mm}/${yy} ${hh}:${mi} ${ampm}`;
}

/**
 * NOTE:
 * Your original file already had getRole/getStaffId/scopeSqlForRole.
 * I’m keeping them “safe” here: if role data isn’t present, no scope is applied.
 * This preserves existing behavior for admins and avoids breaking if session shape differs.
 */
function getRole(req) {
  return (
    req.session?.staffUser?.role ||
    req.session?.staff?.role ||
    req.session?.admin?.role ||
    req.user?.role ||
    ""
  );
}

function getStaffId(req) {
  return (
    req.session?.staffUser?.id ||
    req.session?.staff?.id ||
    req.session?.admin?.staff_id ||
    req.user?.staff_id ||
    0
  );
}

/**
 * Scope by staff department/school (best-effort, non-breaking):
 * - If we can’t resolve staff scope, we return empty scope (show all allowed by route auth).
 * - If you already had a stricter scope in your old file, paste it back here.
 */
async function scopeSqlForRole(conn, roleRaw, staffId) {
  const role = String(roleRaw || "").toUpperCase();

  // roles that usually see everything
  const wideRoles = new Set([
    "ADMIN",
    "SUPERADMIN",
    "REGISTRY",
    "ICT",
    "BURSARY",
    "RESULTS_ADMIN",
  ]);
  if (wideRoles.has(role) || !staffId) return { sql: "", params: [] };

  // Try to scope by staff.department_id if available
  try {
    const [srows] = await conn.query(
      `SELECT department_id, school_id FROM staff WHERE id = ? LIMIT 1`,
      [staffId]
    );
    const s = srows?.[0];
    if (!s) return { sql: "", params: [] };

    // If HOD/DEPT staff: limit to department courses
    if (role.includes("HOD") || role.includes("DEPARTMENT")) {
      if (s.department_id) return { sql: " AND c.department_id = ? ", params: [s.department_id] };
      return { sql: "", params: [] };
    }

    // If school-level staff: limit to departments under school if schema supports it
    if (role.includes("SCHOOL") && s.school_id) {
      // departments.school_id is common; if your schema differs, adjust here
      return { sql: " AND d.school_id = ? ", params: [s.school_id] };
    }

    return { sql: "", params: [] };
  } catch {
    return { sql: "", params: [] };
  }
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
    approvedStatuses: ["BUSINESS_APPROVED", "FINAL", "REGISTRY_APPROVED"],
  };
}

function asCsv(rows, headers) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(","));
  return lines.join("\n");
}

function sendExcel(res, sheetName, rows, headerOrder, fileName) {
  const wsData = [headerOrder, ...rows.map((r) => headerOrder.map((h) => r[h]))];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(wsData);
  xlsx.utils.book_append_sheet(wb, ws, sheetName);
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
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
    const role = getRole(req);
    const staffId = getStaffId(req);

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

    // extra meta for print header
    const [[courseRow]] = await conn.query(
      `SELECT id, code, title, units FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );
    const [[sessionRow]] = await conn.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );

    return {
      rows: rows || [],
      meta: {
        sessionId,
        sessionName: sessionRow?.name || "",
        semester,
        level,
        courseId,
        courseCode: courseRow?.code || "",
        courseTitle: courseRow?.title || "",
        courseUnits: courseRow?.units ?? "",
        batchId,
        statusMode,
        printedAt: nowStamp(),
      },
    };
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
  const rows = (out.rows || []).map((r) => ({
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
  const headers = ["matric", "full_name", "reg_type", "units", "ca1", "ca2", "ca3", "exam", "total", "grade", "gp"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="master_mark_sheet.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportMasterMarkSheetExcel(req, res) {
  const out = await fetchMasterMarkSheet(req, res);
  const rows = (out.rows || []).map((r) => ({
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
  const headers = ["matric", "full_name", "reg_type", "units", "ca1", "ca2", "ca3", "exam", "total", "grade", "gp"];
  sendExcel(res, "MasterMarkSheet", rows, headers, "master_mark_sheet.xlsx");
}

export async function printMasterMarkSheet(req, res) {
  const out = await fetchMasterMarkSheet(req, res);
  res.render("results/reports/print-master-mark-sheet", { layout: false, ...out });
}

/* ---------------- B) SEMESTER RESULT ---------------- */

/**
 * Adds `sheet` details for printing without breaking existing `rows` summary:
 * rows: [{matric, full_name, total_units, gpa}]
 * sheet: { courses, detailRows, gradeScale }
 */
async function fetchSemesterResult(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req);
    const staffId = getStaffId(req);

    const sessionId = safeInt(req.query.sessionId);
    const semester = safeStr(req.query.semester).toUpperCase();
    const level = safeStr(req.query.level).toUpperCase();
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all

    if (!sessionId || !semester || !level) {
      return { rows: [], meta: { message: "Pick session, semester and level." }, sheet: null };
    }

    const { sql: scopeSql, params: scopeParams } = await scopeSqlForRole(conn, role, staffId);

    let statusSql = "";
    const approvedStatusSql = " AND rb.status IN ('BUSINESS_APPROVED','FINAL','REGISTRY_APPROVED') ";
    if (statusMode === "approved") statusSql += approvedStatusSql;

    // session display
    const [[sessionRow]] = await conn.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );
    const sessionName = sessionRow?.name || "";

    // 1) Courses in this semester/level/session (for dynamic columns)
    const [courseCols] = await conn.query(
      `
      SELECT DISTINCT c.id, c.code, c.units
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
        ${scopeSql}
      ORDER BY c.code ASC
      `,
      [sessionId, semester, level, ...scopeParams]
    );

    const courses = (courseCols || []).map((c) => ({
      id: c.id,
      code: c.code,
      units: safeFloat(c.units),
    }));

    // 2) CURRENT totals (also forms your existing summary rows)
    const [currentAgg] = await conn.query(
      `
      SELECT
        pu.id AS student_id,
        pu.matric_number AS matric,
        CONCAT_WS(' ', pu.first_name, pu.middle_name, pu.last_name) AS full_name,
        SUM(c.units) AS tlu,
        SUM(c.units * cr.points) AS tup,
        SUM(CASE WHEN cr.points > 0 THEN c.units ELSE 0 END) AS tcp
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
      `,
      [sessionId, semester, level, ...scopeParams]
    );

    const currentRows = currentAgg || [];
    const studentIds = currentRows.map((r) => r.student_id);
    if (!studentIds.length) {
      return {
        rows: [],
        meta: { sessionId, sessionName, semester, level, statusMode, printedAt: nowStamp() },
        sheet: { courses, detailRows: [], gradeScale: [] },
      };
    }

    // 3) CURRENT per-course grades (only current semester columns)
    const [currentGrades] = await conn.query(
      `
      SELECT
        cr.student_id,
        rb.course_id,
        cr.grade,
        cr.points
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
        AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
      `,
      [sessionId, semester, level, ...studentIds]
    );

    const gradeMap = new Map(); // studentId -> Map(courseId -> grade)
    for (const g of currentGrades || []) {
      if (!gradeMap.has(g.student_id)) gradeMap.set(g.student_id, new Map());
      gradeMap.get(g.student_id).set(g.course_id, g.grade || "");
    }

    // 4) PREVIOUS CARRY (all earlier sessions): used as Previous when printing FIRST semester,
    //    and also used in CUMULATIVE for SECOND semester
    const [prevCarryAgg] = await conn.query(
      `
      SELECT
        cr.student_id,
        SUM(c.units) AS tlu,
        SUM(c.units * cr.points) AS tup,
        SUM(CASE WHEN cr.points > 0 THEN c.units ELSE 0 END) AS tcp
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      WHERE rb.session_id < ?
        ${statusSql}
        AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
      GROUP BY cr.student_id
      `,
      [sessionId, ...studentIds]
    );

    const prevCarry = new Map();
    for (const r of prevCarryAgg || []) {
      prevCarry.set(r.student_id, {
        tcp: safeFloat(r.tcp),
        tlu: safeFloat(r.tlu),
        tup: safeFloat(r.tup),
      });
    }

    // 5) PREVIOUS SEMESTER totals (FIRST semester of same session+level) for when printing SECOND semester
    let prevSem = new Map();
    if (semester === "SECOND") {
      const [prevSemAgg] = await conn.query(
        `
        SELECT
          cr.student_id,
          SUM(c.units) AS tlu,
          SUM(c.units * cr.points) AS tup,
          SUM(CASE WHEN cr.points > 0 THEN c.units ELSE 0 END) AS tcp
        FROM course_results cr
        JOIN result_batches rb ON rb.id = cr.result_batch_id
        JOIN courses c ON c.id = rb.course_id
        WHERE rb.session_id = ?
          AND rb.semester = 'FIRST'
          AND rb.level = ?
          ${statusSql}
          AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
        GROUP BY cr.student_id
        `,
        [sessionId, level, ...studentIds]
      );

      prevSem = new Map();
      for (const r of prevSemAgg || []) {
        prevSem.set(r.student_id, {
          tcp: safeFloat(r.tcp),
          tlu: safeFloat(r.tlu),
          tup: safeFloat(r.tup),
        });
      }
    }

    // 6) OUTSTANDING (failed courses) up to this point:
    // - include all earlier sessions always
    // - include current session FIRST if printing SECOND
    // - include current session current semester always
    const includeFirstInCurrentSession = semester === "SECOND";
    const semesterWhere = includeFirstInCurrentSession
      ? " (rb.session_id < ? OR (rb.session_id = ? AND rb.semester IN ('FIRST','SECOND'))) "
      : " (rb.session_id < ? OR (rb.session_id = ? AND rb.semester = 'FIRST')) "; // for FIRST semester print, only FIRST in current session

    const [outstandingRows] = await conn.query(
      `
      SELECT
        cr.student_id,
        c.code,
        c.units
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      WHERE ${semesterWhere}
        ${statusSql}
        AND cr.points <= 0
        AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
      ORDER BY c.code ASC
      `,
      includeFirstInCurrentSession
        ? [sessionId, sessionId, ...studentIds]
        : [sessionId, sessionId, ...studentIds]
    );

    const outstandingMap = new Map(); // studentId -> [{code, units}]
    for (const r of outstandingRows || []) {
      if (!outstandingMap.has(r.student_id)) outstandingMap.set(r.student_id, []);
      const arr = outstandingMap.get(r.student_id);
      // de-dupe by code
      if (!arr.some((x) => x.code === r.code)) {
        arr.push({ code: r.code, units: safeFloat(r.units) });
      }
    }

    // 7) grade scale mapping from data (non-breaking, no dependency on grade_scales schema)
    const [gradeScaleRows] = await conn.query(
      `
      SELECT DISTINCT cr.grade, cr.points
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
      ORDER BY cr.points DESC
      `,
      [sessionId, semester, level]
    );
    const gradeScale = (gradeScaleRows || [])
      .filter((g) => g.grade)
      .map((g) => ({ grade: g.grade, points: safeFloat(g.points) }));

    // Build summary rows (existing behavior)
    const summaryRows = currentRows.map((r) => {
      const tlu = safeFloat(r.tlu);
      const tup = safeFloat(r.tup);
      const gpa = tlu > 0 ? tup / tlu : 0;
      return {
        matric: r.matric,
        full_name: r.full_name,
        total_units: tlu,
        gpa: Number(gpa.toFixed(2)),
      };
    });

    // Build detailed print rows
    const detailRows = currentRows.map((r, idx) => {
      const sid = r.student_id;

      const cur = {
        tcp: safeFloat(r.tcp),
        tlu: safeFloat(r.tlu),
        tup: safeFloat(r.tup),
      };
      const curGpa = cur.tlu > 0 ? cur.tup / cur.tlu : 0;

      const carry = prevCarry.get(sid) || { tcp: 0, tlu: 0, tup: 0 };
      const ps = prevSem.get(sid) || { tcp: 0, tlu: 0, tup: 0 };

      // Previous column rules
      const prev = semester === "SECOND" ? ps : carry;
      const prevGpa = prev.tlu > 0 ? prev.tup / prev.tlu : 0;

      // Cumulative is always: carry + (FIRST of current session if printing SECOND) + current
      const cum = {
        tcp: carry.tcp + (semester === "SECOND" ? ps.tcp : 0) + cur.tcp,
        tlu: carry.tlu + (semester === "SECOND" ? ps.tlu : 0) + cur.tlu,
        tup: carry.tup + (semester === "SECOND" ? ps.tup : 0) + cur.tup,
      };
      const cumGpa = cum.tlu > 0 ? cum.tup / cum.tlu : 0;

      const out = outstandingMap.get(sid) || [];
      const passRepeat = out.length ? "FAIL" : "PASS";

      const gForStudent = gradeMap.get(sid) || new Map();
      const grades = courses.map((c) => gForStudent.get(c.id) || "");

      return {
        sn: idx + 1,
        matric: r.matric,
        full_name: r.full_name,
        grades,
        current: { ...cur, gpa: Number(curGpa.toFixed(2)) },
        previous: { ...prev, gpa: Number(prevGpa.toFixed(2)) },
        cumulative: { ...cum, gpa: Number(cumGpa.toFixed(2)) },
        outstanding: out,
        passRepeat,
      };
    });

    return {
      rows: summaryRows,
      meta: { sessionId, sessionName, semester, level, statusMode, printedAt: nowStamp() },
      sheet: {
        courses,
        detailRows,
        gradeScale,
      },
    };
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
  const headers = ["matric", "full_name", "total_units", "gpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="semester_result.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportSemesterResultExcel(req, res) {
  const out = await fetchSemesterResult(req, res);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "total_units", "gpa"];
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
    const role = getRole(req);
    const staffId = getStaffId(req);

    const level = safeStr(req.query.level).toUpperCase();
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all
    const programmeText = safeStr(req.query.programme);

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

    const outRows = (rows || []).map((r) => {
      const units = safeFloat(r.total_units);
      const pts = safeFloat(r.total_points);
      const cgpa = units > 0 ? pts / units : 0;
      return {
        matric: r.matric,
        full_name: r.full_name,
        school: r.school || "",
        department: r.department || "",
        programme: r.programme || "",
        cgpa: Number(cgpa.toFixed(2)),
      };
    });

    return {
      rows: outRows,
      meta: { level, programme: programmeText, statusMode, printedAt: nowStamp() },
    };
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
  const headers = ["matric", "full_name", "school", "department", "programme", "cgpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="graduating_list.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportGraduatingListExcel(req, res) {
  const out = await fetchGraduatingList(req, res);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "school", "department", "programme", "cgpa"];
  sendExcel(res, "GraduatingList", rows, headers, "graduating_list.xlsx");
}

export async function printGraduatingList(req, res) {
  const out = await fetchGraduatingList(req, res);
  res.render("results/reports/print-graduating-list", { layout: false, ...out });
}
