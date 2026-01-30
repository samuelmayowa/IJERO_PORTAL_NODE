// app/web/controllers/results-reports.controller.js

import xlsx from "xlsx";
import pool from "../../core/db.js";

/* ---------------- helpers ---------------- */

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
function levelToL(levelRaw) {
  const level = String(levelRaw || "").toUpperCase();
  const map = {
    ND1: "100L",
    ND2: "200L",
    HND1: "300L",
    HND2: "400L",
    "100L": "100L",
    "200L": "200L",
    "300L": "300L",
    "400L": "400L",
  };
  return map[level] || level;
}
function normalizeSemesterLabel(sem) {
  const s = String(sem || "").toUpperCase();
  if (s === "FIRST") return "FIRST SEMESTER";
  if (s === "SECOND") return "SECOND SEMESTER";
  return s;
}

const INSTITUTION_NAME =
  "EKITI STATE COLLEGE OF HEALTH SCIENCES AND TECHNOLOGY, IJERO-EKITI";

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
 * Non-breaking scope: if your original file had stricter scoping, you can replace this.
 * This implementation only scopes when we can resolve staff department/school.
 */
async function scopeSqlForRole(conn, roleRaw, staffId) {
  const role = String(roleRaw || "").toUpperCase();
  const wideRoles = new Set([
    "ADMIN",
    "SUPERADMIN",
    "REGISTRY",
    "ICT",
    "BURSARY",
    "RESULTS_ADMIN",
  ]);
  if (wideRoles.has(role) || !staffId) return { sql: "", params: [] };

  try {
    const [srows] = await conn.query(
      `SELECT department_id, school_id FROM staff WHERE id = ? LIMIT 1`,
      [staffId]
    );
    const s = srows?.[0];
    if (!s) return { sql: "", params: [] };

    if ((role.includes("HOD") || role.includes("DEPARTMENT")) && s.department_id) {
      return { sql: " AND c.department_id = ? ", params: [s.department_id] };
    }

    // school scope (if departments table has school_id)
    if (role.includes("SCHOOL") && s.school_id) {
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

async function fetchMasterMarkSheet(req) {
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

    const [[sessionRow]] = await conn.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );
    const [[courseRow]] = await conn.query(
      `
      SELECT
        c.id, c.code, c.title, c.units,
        d.name AS department_name,
        sc.name AS school_name
      FROM courses c
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN schools sc ON sc.id = d.school_id
      WHERE c.id = ? LIMIT 1
      `,
      [courseId]
    );

    // Simple summary for bottom block
    const examined = rows?.length || 0;
    const fail = (rows || []).filter((r) => safeFloat(r.gp) <= 0).length;
    const pass = examined - fail;

    const gradeCounts = {};
    for (const r of rows || []) {
      const g = String(r.grade || "").toUpperCase() || "N/A";
      gradeCounts[g] = (gradeCounts[g] || 0) + 1;
    }

    return {
      rows: rows || [],
      meta: {
        institutionName: INSTITUTION_NAME,
        sessionId,
        sessionName: sessionRow?.name || "",
        semester,
        semesterLabel: normalizeSemesterLabel(semester),
        level,
        levelLabel: levelToL(level),
        courseId,
        courseCode: courseRow?.code || "",
        courseTitle: courseRow?.title || "",
        courseUnits: courseRow?.units ?? "",
        schoolName: courseRow?.school_name || "",
        departmentName: courseRow?.department_name || "",
        batchId,
        statusMode,
        printedAt: nowStamp(),
        summary: { examined, pass, fail, gradeCounts },
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
    const out = await fetchMasterMarkSheet(req);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiMasterMarkSheet error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportMasterMarkSheetCsv(req, res) {
  const out = await fetchMasterMarkSheet(req);
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
  const headers = [
    "matric",
    "full_name",
    "reg_type",
    "units",
    "ca1",
    "ca2",
    "ca3",
    "exam",
    "total",
    "grade",
    "gp",
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="master_mark_sheet.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportMasterMarkSheetExcel(req, res) {
  const out = await fetchMasterMarkSheet(req);
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
  const headers = [
    "matric",
    "full_name",
    "reg_type",
    "units",
    "ca1",
    "ca2",
    "ca3",
    "exam",
    "total",
    "grade",
    "gp",
  ];
  sendExcel(res, "MasterMarkSheet", rows, headers, "master_mark_sheet.xlsx");
}

export async function printMasterMarkSheet(req, res) {
  const out = await fetchMasterMarkSheet(req);
  res.render("results/reports/print-master-mark-sheet", { layout: false, ...out });
}

/* ---------------- B) SEMESTER RESULT ---------------- */

/**
 * Previous definition (your clarified rule):
 * - If printing FIRST semester:
 *     Previous = cumulative of all earlier sessions for that student/level (if none => 0)
 * - If printing SECOND semester:
 *     Previous = FIRST semester totals of the same session+level
 * Cumulative always includes earlier sessions + (FIRST of current session if SECOND) + CURRENT.
 */
async function fetchSemesterResult(req) {
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
    if (statusMode === "approved") {
      statusSql += " AND rb.status IN ('BUSINESS_APPROVED','FINAL','REGISTRY_APPROVED') ";
    }

    const [[sessionRow]] = await conn.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );

    // Header school/department (best-effort from courses)
    const [[hdrRow]] = await conn.query(
      `
      SELECT
        sc.name AS school_name,
        d.name AS department_name
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN schools sc ON sc.id = d.school_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
        ${scopeSql}
      LIMIT 1
      `,
      [sessionId, semester, level, ...scopeParams]
    );

    // 1) course columns (include title for bottom course list)
    const [courseCols] = await conn.query(
      `
      SELECT DISTINCT c.id, c.code, c.title, c.units
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
      title: c.title || "",
      units: safeFloat(c.units),
    }));
    const sheetTotalUnits = courses.reduce((a, c) => a + safeFloat(c.units), 0);

    // 2) CURRENT totals
    const [currentAgg] = await conn.query(
      `
      SELECT
        pu.id AS student_id,
        pu.username AS student_username,
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
        meta: {
          institutionName: INSTITUTION_NAME,
          sessionId,
          sessionName: sessionRow?.name || "",
          semester,
          semesterLabel: normalizeSemesterLabel(semester),
          level,
          levelLabel: levelToL(level),
          schoolName: hdrRow?.school_name || "",
          departmentName: hdrRow?.department_name || "",
          programmeName: "",
          statusMode,
          printedAt: nowStamp(),
        },
        sheet: { courses, detailRows: [], totalUnits: sheetTotalUnits, summary: null },
      };
    }

    // Programme best-effort: from student_imports (if consistent)
    const [progRows] = await conn.query(
      `
      SELECT DISTINCT si.programme
      FROM public_users pu
      JOIN student_imports si ON si.student_email = pu.username
      WHERE pu.id IN (${studentIds.map(() => "?").join(",")})
        AND si.programme IS NOT NULL AND si.programme <> ''
      LIMIT 2
      `,
      studentIds
    );
    const programmeName =
      (progRows || []).length === 1 ? (progRows[0]?.programme || "") : "";

    // 3) CURRENT per-course grade + points
    const [currentGrades] = await conn.query(
      `
      SELECT
        cr.student_id,
        rb.course_id,
        c.code,
        c.units,
        cr.grade,
        cr.points
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${statusSql}
        AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
      `,
      [sessionId, semester, level, ...studentIds]
    );

    const gradeMap = new Map(); // sid -> Map(courseId -> grade)
    const currentFailedMap = new Map(); // sid -> [{code, units}]
    for (const g of currentGrades || []) {
      if (!gradeMap.has(g.student_id)) gradeMap.set(g.student_id, new Map());
      gradeMap.get(g.student_id).set(g.course_id, g.grade || "");

      if (safeFloat(g.points) <= 0) {
        if (!currentFailedMap.has(g.student_id)) currentFailedMap.set(g.student_id, []);
        currentFailedMap.get(g.student_id).push({
          code: g.code,
          units: safeFloat(g.units),
        });
      }
    }

    // 4) Previous carry (all earlier sessions totals) => used for FIRST semester Previous + cumulative
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

    // 5) Previous semester totals (FIRST of same session+level) => used for SECOND semester Previous + cumulative
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

    // 6) Outstanding (previous failures BEFORE current semester):
    // FIRST: earlier sessions only
    // SECOND: earlier sessions + FIRST semester of current session
    const prevWhere =
      semester === "SECOND"
        ? "(rb.session_id < ? OR (rb.session_id = ? AND rb.semester = 'FIRST'))"
        : "(rb.session_id < ?)";

    const prevParams =
      semester === "SECOND" ? [sessionId, sessionId, ...studentIds] : [sessionId, ...studentIds];

    const [prevFails] = await conn.query(
      `
      SELECT
        cr.student_id,
        c.code,
        c.units
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      WHERE ${prevWhere}
        ${statusSql}
        AND cr.points <= 0
        AND cr.student_id IN (${studentIds.map(() => "?").join(",")})
      ORDER BY c.code ASC
      `,
      prevParams
    );

    const prevOutstandingMap = new Map();
    for (const r of prevFails || []) {
      if (!prevOutstandingMap.has(r.student_id)) prevOutstandingMap.set(r.student_id, []);
      const arr = prevOutstandingMap.get(r.student_id);
      if (!arr.some((x) => x.code === r.code)) {
        arr.push({ code: r.code, units: safeFloat(r.units) });
      }
    }

    // Summary rows (existing behavior: matric, full_name, total_units, gpa)
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

    // detail rows for print
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

      const prev = semester === "SECOND" ? ps : carry;
      const prevGpa = prev.tlu > 0 ? prev.tup / prev.tlu : 0;

      const cum = {
        tcp: carry.tcp + (semester === "SECOND" ? ps.tcp : 0) + cur.tcp,
        tlu: carry.tlu + (semester === "SECOND" ? ps.tlu : 0) + cur.tlu,
        tup: carry.tup + (semester === "SECOND" ? ps.tup : 0) + cur.tup,
      };
      const cumGpa = cum.tlu > 0 ? cum.tup / cum.tlu : 0;

      const gForStudent = gradeMap.get(sid) || new Map();
      const grades = courses.map((c) => gForStudent.get(c.id) || "");

      const carryOver = currentFailedMap.get(sid) || [];
      const outstanding = prevOutstandingMap.get(sid) || [];

      const passRepeat = carryOver.length || outstanding.length ? "FAIL" : "PASS";

      return {
        sn: idx + 1,
        matric: r.matric,
        full_name: r.full_name,
        grades,
        current: { ...cur, gpa: Number(curGpa.toFixed(2)) },
        previous: { ...prev, gpa: Number(prevGpa.toFixed(2)) },
        cumulative: { ...cum, gpa: Number(cumGpa.toFixed(2)) },
        carryOver,
        outstanding,
        passRepeat,
      };
    });

    // Summary-of-results block counts (based on CUMULATIVE GPA)
    const classifyCgpa = (cgpa) => {
      const g = safeFloat(cgpa);
      if (g >= 3.5) return "DISTINCTION";
      if (g >= 3.0) return "UPPER";
      if (g >= 2.5) return "LOWER";
      if (g >= 1.5) return "PASS";
      return "FAIL";
    };

    const summary = {
      examined: detailRows.length,
      distinction: 0,
      upper: 0,
      lower: 0,
      pass: 0,
      fail: 0,
      total: detailRows.length,
    };
    for (const r of detailRows) {
      const cat = classifyCgpa(r.cumulative.gpa);
      if (cat === "DISTINCTION") summary.distinction += 1;
      else if (cat === "UPPER") summary.upper += 1;
      else if (cat === "LOWER") summary.lower += 1;
      else if (cat === "PASS") summary.pass += 1;
      else summary.fail += 1;
    }

    return {
      rows: summaryRows,
      meta: {
        institutionName: INSTITUTION_NAME,
        sessionId,
        sessionName: sessionRow?.name || "",
        semester,
        semesterLabel: normalizeSemesterLabel(semester),
        level,
        levelLabel: levelToL(level),
        schoolName: hdrRow?.school_name || "",
        departmentName: hdrRow?.department_name || "",
        programmeName,
        statusMode,
        printedAt: nowStamp(),
      },
      sheet: {
        courses,
        totalUnits: sheetTotalUnits,
        detailRows,
        summary,
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
    const out = await fetchSemesterResult(req);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiSemesterResult error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportSemesterResultCsv(req, res) {
  const out = await fetchSemesterResult(req);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "total_units", "gpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="semester_result.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportSemesterResultExcel(req, res) {
  const out = await fetchSemesterResult(req);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "total_units", "gpa"];
  sendExcel(res, "SemesterResult", rows, headers, "semester_result.xlsx");
}

export async function printSemesterResult(req, res) {
  const out = await fetchSemesterResult(req);
  res.render("results/reports/print-semester-result", { layout: false, ...out });
}

/* ---------------- C) GRADUATING LIST ---------------- */

async function fetchGraduatingList(req) {
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

    // meta header best-effort if consistent
    const schoolSet = new Set(outRows.map((r) => r.school).filter(Boolean));
    const deptSet = new Set(outRows.map((r) => r.department).filter(Boolean));
    const progSet = new Set(outRows.map((r) => r.programme).filter(Boolean));

    const schoolName = schoolSet.size === 1 ? [...schoolSet][0] : "";
    const departmentName = deptSet.size === 1 ? [...deptSet][0] : "";
    const programmeName = programmeText || (progSet.size === 1 ? [...progSet][0] : "");

    return {
      rows: outRows,
      meta: {
        institutionName: INSTITUTION_NAME,
        level,
        levelLabel: levelToL(level),
        schoolName,
        departmentName,
        programmeName,
        statusMode,
        printedAt: nowStamp(),
      },
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
    const out = await fetchGraduatingList(req);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("apiGraduatingList error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  }
}

export async function exportGraduatingListCsv(req, res) {
  const out = await fetchGraduatingList(req);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "school", "department", "programme", "cgpa"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="graduating_list.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportGraduatingListExcel(req, res) {
  const out = await fetchGraduatingList(req);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "school", "department", "programme", "cgpa"];
  sendExcel(res, "GraduatingList", rows, headers, "graduating_list.xlsx");
}

export async function printGraduatingList(req, res) {
  const out = await fetchGraduatingList(req);
  res.render("results/reports/print-graduating-list", { layout: false, ...out });
}
