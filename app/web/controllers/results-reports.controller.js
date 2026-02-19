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
  const map = { ND1: "100L", ND2: "200L", HND1: "300L", HND2: "400L", "100L": "100L", "200L": "200L", "300L": "300L", "400L": "400L" };
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

/**
 * IMPORTANT:
 * Your portal’s “Approved only” should include the workflow states you already use.
 * This keeps the “works now” behaviour (HOD approved shows under Approved only).
 */
const APPROVED_STATUS_SQL =
  " AND rb.status IN ('UPLOADED','HOD_APPROVED','DEAN_APPROVED','BUSINESS_APPROVED','REGISTRY_APPROVED','FINAL') ";

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
 * Non-breaking scope:
 * - HOD: scoped to department_id (if found)
 * - Dean/School roles: scoped to school_id (if found)
 * - Admin/Registry/etc: no scope
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
    if ((role.includes("DEAN") || role.includes("SCHOOL")) && s.school_id) {
      // need dept join for school scope
      return { sql: " AND d.school_id = ? ", params: [s.school_id] };
    }
    return { sql: "", params: [] };
  } catch {
    return { sql: "", params: [] };
  }
}

function asCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const out = [];
  out.push(headers.join(","));
  for (const r of rows) {
    out.push(headers.map((h) => esc(r?.[h])).join(","));
  }
  return out.join("\n");
}

function sendExcel(res, sheetName, rows, headers, filename) {
  const data = [headers, ...(rows || []).map((r) => headers.map((h) => r?.[h] ?? ""))];
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(data);
  xlsx.utils.book_append_sheet(wb, ws, sheetName);
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buf);
}

async function getSessions() {
  const [rows] = await pool.query(`SELECT id, name FROM sessions ORDER BY id DESC`);
  return rows || [];
}

function baseLists() {
  const semesters = ["FIRST", "SECOND"];
  const levels = ["ND1", "ND2", "HND1", "HND2"];
  return { semesters, levels };
}

/* -------- batch lookup (NO GUESSWORK: uses DB if table exists) -------- */

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(`SHOW TABLES LIKE ?`, [tableName]);
  return (rows || []).length > 0;
}

async function getTableColumns(conn, tableName) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
  return (cols || []).map((c) => c.Field);
}

function pickExisting(cols, candidates, fallback) {
  const lower = new Set(cols.map((c) => String(c).toLowerCase()));
  for (const c of candidates) {
    if (lower.has(String(c).toLowerCase())) return c;
  }
  return fallback;
}

function buildAZBatches() {
  const out = [];
  for (let i = 1; i <= 26; i++) out.push({ id: i, name: String.fromCharCode(64 + i) });
  return out;
}

async function getBatchesList(conn) {
  // Prefer result_batches_lookup if present
  const exists = await tableExists(conn, "result_batches_lookup");
  if (!exists) return buildAZBatches();

  const cols = await getTableColumns(conn, "result_batches_lookup");
  const idCol = pickExisting(cols, ["id", "batch_id"], "id");
  const nameCol = pickExisting(cols, ["name", "label", "batch", "code"], null);

  if (!nameCol) return buildAZBatches();

  const [rows] = await conn.query(
    `SELECT \`${idCol}\` AS id, \`${nameCol}\` AS name FROM result_batches_lookup ORDER BY \`${idCol}\` ASC`
  );
  if (!rows?.length) return buildAZBatches();
  return rows.map((r) => ({ id: safeInt(r.id), name: String(r.name || "").trim() || String(r.id) }));
}

async function resolveBatchLabel(conn, batchId) {
  if (!batchId) return "";
  try {
    const list = await getBatchesList(conn);
    const found = list.find((b) => safeInt(b.id) === safeInt(batchId));
    if (found?.name) return String(found.name).trim();
  } catch {
    // ignore
  }
  // fallback: numeric -> A-Z
  const n = safeInt(batchId);
  if (n >= 1 && n <= 26) return String.fromCharCode(64 + n);
  return String(batchId);
}

/* ---------------- HOME ---------------- */

export async function reportsHome(req, res) {
  res.render("results/reports/home", { pageTitle: "Result Reports" });
}

/* ---------------- A) MASTER MARK SHEET ---------------- */
/* (left intact; included here so your routes keep working) */

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
    const rbCols = await getTableColumns(conn, "result_batches");
    const rbBatchCol = pickExisting(rbCols, ["batch_id", "batch"], "batch_id");

    let extraSql = "";
    const params = [sessionId, semester, level, courseId];

    if (batchId) {
      extraSql += ` AND rb.\`${rbBatchCol}\` = ? `;
      params.push(batchId);
    }
    if (statusMode === "approved") {
      extraSql += APPROVED_STATUS_SQL;
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
        ${extraSql}
        ${scopeSql}
      ORDER BY pu.matric_number ASC
    `;
    const [rows] = await conn.query(sql, [...params, ...scopeParams]);

    return { rows: rows || [], meta: { printedAt: nowStamp(), statusMode, batchId } };
  } finally {
    conn.release();
  }
}

export async function viewMasterMarkSheet(req, res) {
  const sessions = await getSessions();
  const { semesters, levels } = baseLists();

  // courses list
  const [courses] = await pool.query(`SELECT id, code, title FROM courses ORDER BY code ASC`);

  // batches (optional)
  let batches = [];
  let conn;
  try {
    conn = await pool.getConnection();
    batches = await getBatchesList(conn);
  } catch {
    batches = buildAZBatches();
  } finally {
    if (conn) conn.release();
  }

  res.render("results/reports/master-mark-sheet", {
    pageTitle: "Master Mark Sheet",
    sessions,
    semesters,
    levels,
    courses: courses || [],
    batches,
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
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "reg_type", "ca1", "ca2", "ca3", "exam", "total", "grade", "gp", "units"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="master_mark_sheet.csv"`);
  res.send(asCsv(rows, headers));
}

export async function exportMasterMarkSheetExcel(req, res) {
  const out = await fetchMasterMarkSheet(req);
  const rows = out.rows || [];
  const headers = ["matric", "full_name", "reg_type", "ca1", "ca2", "ca3", "exam", "total", "grade", "gp", "units"];
  sendExcel(res, "MasterMarkSheet", rows, headers, "master_mark_sheet.xlsx");
}

export async function printMasterMarkSheet(req, res) {
  const out = await fetchMasterMarkSheet(req);
  res.render("results/reports/print-master-mark-sheet", { layout: false, ...out });
}

/* ---------------- B) SEMESTER RESULT ---------------- */

async function fetchSemesterResult(req) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req);
    const staffId = getStaffId(req);

    const sessionId = safeInt(req.query.sessionId);
    const semester = safeStr(req.query.semester).toUpperCase();
    const level = safeStr(req.query.level).toUpperCase();
    const statusMode = safeStr(req.query.statusMode).toLowerCase(); // approved|all
    const batchId = safeInt(req.query.batchId);

    if (!sessionId || !semester || !level) {
      return { rows: [], meta: { message: "Pick session, semester and level." }, sheet: null };
    }

    const { sql: scopeSql, params: scopeParams } = await scopeSqlForRole(conn, role, staffId);

    // detect actual batch column (batch_id vs batch)
    const rbCols = await getTableColumns(conn, "result_batches");
    const rbBatchCol = pickExisting(rbCols, ["batch_id", "batch"], "batch_id");

    let statusSql = "";
    if (statusMode === "approved") statusSql += APPROVED_STATUS_SQL;

    let batchSql = "";
    const batchParams = [];
    if (batchId) {
      batchSql = ` AND rb.\`${rbBatchCol}\` = ? `;
      batchParams.push(batchId);
    }

    const batchLabel = await resolveBatchLabel(conn, batchId);

    // 1) If a batch is selected but NOTHING has been uploaded for it -> required alert message
    if (batchId) {
      const [[cntRow]] = await conn.query(
        `
        SELECT COUNT(*) AS cnt
        FROM result_batches rb
        JOIN courses c ON c.id = rb.course_id
        LEFT JOIN departments d ON d.id = c.department_id
        WHERE rb.session_id = ?
          AND rb.semester = ?
          AND rb.level = ?
          ${batchSql}
          ${scopeSql}
        `,
        [sessionId, semester, level, ...batchParams, ...scopeParams]
      );

      if (!safeInt(cntRow?.cnt)) {
        return {
          rows: [],
          meta: {
            institutionName: INSTITUTION_NAME,
            sessionId,
            semester,
            semesterLabel: normalizeSemesterLabel(semester),
            level,
            levelLabel: levelToL(level),
            statusMode,
            batchId,
            batchLabel,
            message: "No result(s) found for the selected batch",
            printedAt: nowStamp(),
          },
          sheet: null,
        };
      }
    }

    const [[sessionRow]] = await conn.query(
      `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId]
    );

    // Programme name (best effort)
    const [[progRow]] = await conn.query(
      `
      SELECT si.programme AS programme
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN public_users pu ON pu.id = cr.student_id
      LEFT JOIN student_imports si ON si.student_email = pu.username
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${batchSql}
        ${statusSql}
        ${scopeSql}
      AND si.programme IS NOT NULL AND si.programme <> ''
      LIMIT 1
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );
    const programmeName = progRow?.programme || "";

    // Header school/department (best effort from courses)
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
        ${batchSql}
        ${statusSql}
        ${scopeSql}
      LIMIT 1
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );

    // 1) courses in this sheet
    const [courseCols] = await conn.query(
      `
      SELECT DISTINCT c.id, c.code, c.title, c.units
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${batchSql}
        ${statusSql}
        ${scopeSql}
      ORDER BY c.code ASC
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );

    const courses = (courseCols || []).map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title || "",
      units: safeFloat(c.units),
    }));
    const sheetTotalUnits = courses.reduce((a, c) => a + safeFloat(c.units), 0);

    if (!courses.length) {
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
          programmeName,
          statusMode,
          batchId,
          batchLabel,
          message: statusMode === "approved" ? "No approved results found for the selected filters." : "No results found.",
          printedAt: nowStamp(),
        },
        sheet: null,
      };
    }

    // 2) CURRENT totals (this semester)
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
        ${batchSql}
        ${statusSql}
        ${scopeSql}
      GROUP BY pu.id, pu.matric_number
      ORDER BY pu.matric_number ASC
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );

    // Map student -> current totals
    const currentMap = new Map();
    for (const r of currentAgg || []) currentMap.set(safeInt(r.student_id), r);

    // 3) PREVIOUS semester totals (only for SECOND semester within same session)
    const prevSem = semester === "SECOND" ? "FIRST" : "";
    const prevMap = new Map();
    if (prevSem) {
      const [prevAgg] = await conn.query(
        `
        SELECT
          pu.id AS student_id,
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
          ${batchSql}
          ${statusSql}
          ${scopeSql}
        GROUP BY pu.id
        `,
        [sessionId, prevSem, level, ...batchParams, ...scopeParams]
      );
      for (const r of prevAgg || []) prevMap.set(safeInt(r.student_id), r);
    }

    // 4) CARRY totals (all sessions before current session) - best effort cumulative base
    const carryMap = new Map();
    const [carryAgg] = await conn.query(
      `
      SELECT
        pu.id AS student_id,
        SUM(c.units) AS tlu,
        SUM(c.units * cr.points) AS tup,
        SUM(CASE WHEN cr.points > 0 THEN c.units ELSE 0 END) AS tcp
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN public_users pu ON pu.id = cr.student_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id < ?
        ${statusSql}
        ${scopeSql}
      GROUP BY pu.id
      `,
      [sessionId, ...scopeParams]
    );
    for (const r of carryAgg || []) carryMap.set(safeInt(r.student_id), r);

    // 5) Grade map for current sheet courses
    const gradeMap = new Map(); // student_id -> Map(course_id -> grade)
    const [gradeRows] = await conn.query(
      `
      SELECT
        cr.student_id,
        rb.course_id,
        cr.grade
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${batchSql}
        ${statusSql}
        ${scopeSql}
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );
    for (const r of gradeRows || []) {
      const sid = safeInt(r.student_id);
      const cid = safeInt(r.course_id);
      if (!gradeMap.has(sid)) gradeMap.set(sid, new Map());
      gradeMap.get(sid).set(cid, String(r.grade || "").toUpperCase());
    }

    // 6) Failed lists (carry over/outstanding)
    const currentFailedMap = new Map(); // sid -> [ "CODE units", ... ]
    const [curFailRows] = await conn.query(
      `
      SELECT
        cr.student_id,
        c.code AS code,
        c.units AS units
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.session_id = ?
        AND rb.semester = ?
        AND rb.level = ?
        ${batchSql}
        ${statusSql}
        ${scopeSql}
        AND (cr.points <= 0 OR cr.grade = 'F')
      `,
      [sessionId, semester, level, ...batchParams, ...scopeParams]
    );
    for (const r of curFailRows || []) {
      const sid = safeInt(r.student_id);
      if (!currentFailedMap.has(sid)) currentFailedMap.set(sid, []);
      currentFailedMap.get(sid).push(`${r.code} ${safeFloat(r.units)}`);
    }

    const prevOutstandingMap = new Map(); // sid -> [ "CODE units", ... ]
    // outstanding: any fails before current session (plus previous semester if SECOND)
    const [prevFailRows] = await conn.query(
      `
      SELECT
        cr.student_id,
        c.code AS code,
        c.units AS units
      FROM course_results cr
      JOIN result_batches rb ON rb.id = cr.result_batch_id
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE (
          rb.session_id < ?
          ${prevSem ? " OR (rb.session_id = ? AND rb.semester = ? AND rb.level = ?)" : ""}
        )
        ${statusSql}
        ${scopeSql}
        AND (cr.points <= 0 OR cr.grade = 'F')
      `,
      prevSem
        ? [sessionId, sessionId, prevSem, level, ...scopeParams]
        : [sessionId, ...scopeParams]
    );
    for (const r of prevFailRows || []) {
      const sid = safeInt(r.student_id);
      if (!prevOutstandingMap.has(sid)) prevOutstandingMap.set(sid, []);
      prevOutstandingMap.get(sid).push(`${r.code} ${safeFloat(r.units)}`);
    }

    // 7) Detail rows for print (and summary rows for screen)
    const detailRows = (currentAgg || []).map((r, idx) => {
      const sid = safeInt(r.student_id);

      const cur = {
        tcp: safeFloat(r.tcp),
        tlu: safeFloat(r.tlu),
        tup: safeFloat(r.tup),
      };
      const curGpa = cur.tlu > 0 ? cur.tup / cur.tlu : 0;

      const p = prevMap.get(sid) || { tcp: 0, tlu: 0, tup: 0 };
      const prev = {
        tcp: safeFloat(p.tcp),
        tlu: safeFloat(p.tlu),
        tup: safeFloat(p.tup),
      };
      const prevGpa = prev.tlu > 0 ? prev.tup / prev.tlu : 0;

      const ca = carryMap.get(sid) || { tcp: 0, tlu: 0, tup: 0 };
      const carry = {
        tcp: safeFloat(ca.tcp),
        tlu: safeFloat(ca.tlu),
        tup: safeFloat(ca.tup),
      };

      const cum = {
        tcp: carry.tcp + (semester === "SECOND" ? prev.tcp : 0) + cur.tcp,
        tlu: carry.tlu + (semester === "SECOND" ? prev.tlu : 0) + cur.tlu,
        tup: carry.tup + (semester === "SECOND" ? prev.tup : 0) + cur.tup,
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

    const summaryRows = detailRows.map((r) => ({
      sn: r.sn,
      matric: r.matric,
      full_name: r.full_name,
      total_units: r.current.tlu,
      gpa: r.current.gpa,
    }));

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
        batchId,
        batchLabel,
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

  let conn;
  let batches = [];
  try {
    conn = await pool.getConnection();
    batches = await getBatchesList(conn);
  } catch {
    batches = buildAZBatches();
  } finally {
    if (conn) conn.release();
  }

  res.render("results/reports/semester-result", {
    pageTitle: "Semester Result Report",
    sessions,
    semesters,
    levels,
    batches,
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
/* (kept intact enough for routes; not part of your requested change) */

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
    if (statusMode === "approved") statusSql += APPROVED_STATUS_SQL;

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

    return { rows: outRows, meta: { printedAt: nowStamp(), statusMode } };
  } finally {
    conn.release();
  }
}

export async function viewGraduatingList(req, res) {
  const { levels } = baseLists();
  res.render("results/reports/graduating-list", { pageTitle: "Graduating List", levels });
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
