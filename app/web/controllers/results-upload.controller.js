import xlsx from "xlsx";
import pool from "../../core/db.js";

// -------------------------
// Small helpers
// -------------------------
function getStaffId(req) {
  return (
    req.session?.staff?.id ||
    req.session?.user?.id ||
    req.session?.staffId ||
    req.user?.id ||
    null
  );
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function parseNumber(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function mapSemesterNameToKey(label) {
  const s = String(label || "").toLowerCase();
  if (s.includes("first") || s.includes("1st")) return "FIRST";
  if (s.includes("second") || s.includes("2nd")) return "SECOND";
  if (s.includes("summer")) return "SUMMER";
  return String(label || "").toUpperCase().trim() || "FIRST";
}

function escapeCsvCell(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildAZBatches() {
  const out = [];
  for (let i = 0; i < 26; i++) {
    out.push({ id: i + 1, label: String.fromCharCode(65 + i) });
  }
  return out;
}

function normalizeRegType(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return ""; // means "not provided"

  const s = raw.toUpperCase().replace(/\s+/g, " ").trim();

  if (s === "MAIN" || s === "M") return "MAIN";
  if (s === "ELECTIVE" || s === "ELEC" || s === "E") return "ELECTIVE";

  // Accept a few variants but normalize to CARRYOVER (no space)
  if (
    s === "CARRYOVER" ||
    s === "CARRY OVER" ||
    s === "CARRY-OVER" ||
    s === "CO" ||
    s === "C/O"
  ) {
    return "CARRYOVER";
  }

  // Unknown value
  return "__INVALID__";
}

async function getColumns(conn, table) {
  const [rows] = await conn.query(
    `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [table]
  );
  return new Set((rows || []).map((r) => String(r.COLUMN_NAME)));
}

async function pickLabelColumn(conn, table, candidates) {
  const cols = await getColumns(conn, table);
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
}

async function getGradeScales(conn) {
  // expects: min_score, max_score, grade, points
  const [rows] = await conn.query(
    `SELECT min_score, max_score, grade, points
     FROM grade_scales
     ORDER BY min_score DESC`
  );
  return rows || [];
}

function computeGrade(scales, total) {
  const t = Number(total);
  for (const r of scales) {
    const min = Number(r.min_score);
    const max = Number(r.max_score);
    if (Number.isFinite(min) && Number.isFinite(max) && t >= min && t <= max) {
      return { grade: r.grade ?? null, points: r.points ?? null };
    }
  }
  return { grade: null, points: null };
}

function clampAndValidateScores(ca1, ca2, ca3, exam) {
  // Strict-ish validation based on your spec
  const n1 = Number(ca1);
  const n2 = Number(ca2);
  const n3 = Number(ca3);
  const ne = Number(exam);

  const ok =
    Number.isFinite(n1) &&
    Number.isFinite(n2) &&
    Number.isFinite(n3) &&
    Number.isFinite(ne) &&
    n1 >= 0 &&
    n2 >= 0 &&
    n3 >= 0 &&
    ne >= 0 &&
    n1 <= 10 &&
    n2 <= 10 &&
    n3 <= 10 &&
    ne <= 70;

  return { ok, ca1: n1, ca2: n2, ca3: n3, exam: ne };
}

// -------------------------
// Excel parsing that supports title row + header row
// -------------------------
function parseUploadSheet(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) throw new Error("No sheet found in upload file.");

  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (!Array.isArray(rows) || !rows.length) return [];

  // Find header row (supports a title row above)
  let headerRowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const joined = r.map((x) => String(x || "").toLowerCase()).join(" | ");
    if (joined.includes("matric") && (joined.includes("ca1") || joined.includes("exam"))) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex < 0) {
    throw new Error(
      "Header row not found. Ensure your sheet contains: MATRIC NO, FULL NAME, CA1, CA2, CA3, EXAM SCORE, REG_TYPE."
    );
  }

  const header = rows[headerRowIndex].map((h) => String(h || "").trim().toLowerCase());

  const colIndex = (pred) => header.findIndex(pred);

  const idxMatric = colIndex((h) => h.includes("matric"));
  const idxName = colIndex((h) => h.includes("full") && h.includes("name")) >= 0
    ? colIndex((h) => h.includes("full") && h.includes("name"))
    : colIndex((h) => h === "name" || h.includes("student") && h.includes("name"));

  const idxCA1 = colIndex((h) => h.includes("ca1"));
  const idxCA2 = colIndex((h) => h.includes("ca2"));
  const idxCA3 = colIndex((h) => h.includes("ca3"));
  const idxExam = colIndex((h) => h.includes("exam"));

  // Prefer REG_TYPE, but accept old STATUS / REG TYPE
  let idxReg = colIndex((h) => h.replace(/\s+/g, "").includes("reg_type"));
  if (idxReg < 0) idxReg = colIndex((h) => h.includes("reg") && h.includes("type"));
  if (idxReg < 0) idxReg = colIndex((h) => h.includes("status")); // legacy fallback

  if (idxMatric < 0) throw new Error("MATRIC NO column not found.");
  if (idxCA1 < 0 || idxCA2 < 0 || idxCA3 < 0 || idxExam < 0) {
    throw new Error("CA1/CA2/CA3/EXAM columns not found.");
  }

  const out = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const matric = safeStr(r[idxMatric]).toUpperCase();
    const fullName = idxName >= 0 ? safeStr(r[idxName]) : "";

    const ca1 = parseNumber(r[idxCA1]);
    const ca2 = parseNumber(r[idxCA2]);
    const ca3 = parseNumber(r[idxCA3]);
    const exam = parseNumber(r[idxExam]);

    const regRaw = idxReg >= 0 ? safeStr(r[idxReg]) : "";
    const reg_type = regRaw;

    // Ignore fully empty lines
    const hasAny =
      matric ||
      fullName ||
      String(r[idxCA1] || "").trim() ||
      String(r[idxCA2] || "").trim() ||
      String(r[idxCA3] || "").trim() ||
      String(r[idxExam] || "").trim() ||
      regRaw;

    if (!hasAny) continue;

    out.push({
      rowNum: i + 1, // Excel-like row number
      matric_number: matric,
      full_name: fullName,
      ca1,
      ca2,
      ca3,
      exam,
      reg_type,
    });
  }

  return out;
}

// -------------------------
// Page
// -------------------------
export async function showUploadPage(req, res) {
  const staffId = getStaffId(req);

  let conn;
  try {
    conn = await pool.getConnection();

    const sessionsLabelCol =
      (await pickLabelColumn(conn, "sessions", ["name", "session", "title", "label"])) || "id";
    const semestersLabelCol =
      (await pickLabelColumn(conn, "semesters", ["name", "semester", "title", "label"])) || "id";
    const schoolsLabelCol =
      (await pickLabelColumn(conn, "schools", ["name", "title", "label"])) || "id";

    const [sessions] = await conn.query(
      `SELECT id, ${sessionsLabelCol} AS label FROM sessions ORDER BY id DESC`
    );
    const [semesters] = await conn.query(
      `SELECT id, ${semestersLabelCol} AS label FROM semesters ORDER BY id ASC`
    );
    const [schools] = await conn.query(
      `SELECT id, ${schoolsLabelCol} AS label FROM schools ORDER BY id ASC`
    );

    // batches lookup is optional; fallback to A–Z
    let batches = [];
    try {
      const batchLabelCol =
        (await pickLabelColumn(conn, "result_batches_lookup", ["code", "name", "label", "title", "batch"])) || null;
      if (batchLabelCol) {
        const [b] = await conn.query(
          `SELECT id, ${batchLabelCol} AS label FROM result_batches_lookup ORDER BY id ASC`
        );
        batches = b || [];
      }
    } catch (_) {
      batches = [];
    }

    if (!batches.length) batches = buildAZBatches();

    return res.render("results/upload", {
      pageTitle: "Upload Student Result",
      staffId,
      sessions: sessions || [],
      semesters: semesters || [],
      schools: schools || [],
      batches,
    });
  } catch (err) {
    console.error("showUploadPage error:", err);
    return res.render("results/upload", {
      pageTitle: "Upload Student Result",
      staffId: getStaffId(req),
      sessions: [],
      semesters: [],
      schools: [],
      batches: buildAZBatches(),
      pageError: err.message || "Failed to load page",
    });
  } finally {
    if (conn) conn.release();
  }
}

// -------------------------
// APIs: dropdown data
// -------------------------
export async function apiDepartmentsBySchool(req, res) {
  const schoolId = req.query.schoolId;
  if (!schoolId) return res.json({ ok: true, items: [] });

  let conn;
  try {
    conn = await pool.getConnection();
    const depLabelCol =
      (await pickLabelColumn(conn, "departments", ["name", "title", "label"])) || "id";

    const [rows] = await conn.query(
      `SELECT id, ${depLabelCol} AS label FROM departments WHERE school_id = ? ORDER BY id ASC`,
      [schoolId]
    );
    res.json({ ok: true, items: rows || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
}

export async function apiProgrammesByDepartment(req, res) {
  const departmentId = req.query.departmentId;
  if (!departmentId) return res.json({ ok: true, items: [] });

  let conn;
  try {
    conn = await pool.getConnection();
    const progLabelCol =
      (await pickLabelColumn(conn, "programmes", ["name", "title", "label"])) || "id";

    const [rows] = await conn.query(
      `SELECT id, ${progLabelCol} AS label FROM programmes WHERE department_id = ? ORDER BY id ASC`,
      [departmentId]
    );
    res.json({ ok: true, items: rows || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
}

export async function apiAssignedCourses(req, res) {
  const staffId = getStaffId(req);
  if (!staffId) return res.status(401).json({ ok: false, message: "Not logged in" });

  const sessionId = req.query.sessionId;
  const semesterId = req.query.semesterId;

  if (!sessionId || !semesterId) return res.json({ ok: true, items: [] });

  let conn;
  try {
    conn = await pool.getConnection();

    // semester label -> key
    const semLabelCol =
      (await pickLabelColumn(conn, "semesters", ["name", "semester", "title", "label"])) || "id";
    const [semRows] = await conn.query(
      `SELECT id, ${semLabelCol} AS label FROM semesters WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    const semesterKey = mapSemesterNameToKey(semRows?.[0]?.label ?? semesterId);

    const caCols = await getColumns(conn, "course_assignments");
    const hasSemId = caCols.has("semester_id");
    const hasSemText = caCols.has("semester");

    let semWhere = "1=1";
    let semParams = [];
    if (hasSemId) {
      semWhere = "ca.semester_id = ?";
      semParams = [semesterId];
    } else if (hasSemText) {
      semWhere = "(LOWER(ca.semester) = LOWER(?) OR ca.semester = ?)";
      semParams = [semesterKey, String(semesterId)];
    }

    const [rows] = await conn.query(
      `
      SELECT
        c.id,
        c.code,
        c.title,
        COALESCE(c.units, c.unit) AS units,
        c.level
      FROM course_assignments ca
      JOIN courses c ON c.id = ca.course_id
      WHERE ca.staff_id = ?
        AND ca.session_id = ?
        AND ${semWhere}
      ORDER BY c.code
      `,
      [staffId, sessionId, ...semParams]
    );

    res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("apiAssignedCourses error:", err);
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
}

export async function apiFetchCourse(req, res) {
  const courseId = req.query.courseId;
  if (!courseId) return res.status(400).json({ ok: false, message: "Missing courseId" });

  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(
      `SELECT id, code, title, COALESCE(units, unit) AS units, level FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );
    res.json({ ok: true, item: rows?.[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
}

// -------------------------
// Template + Rejections CSV
// -------------------------
export async function downloadUploadTemplate(req, res) {
  const headers = [
    ["S/N", "MATRIC NO", "FULL NAME", "CA1 10%", "CA2 10%", "CA3 10%", "EXAM SCORE 70%", "REG_TYPE"],
    [1, "LOCALTEST/CHT/25/CH/001", "Student Name", 10, 10, 10, 50, "MAIN"],
  ];

  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet(headers);
  xlsx.utils.book_append_sheet(wb, ws, "Upload");

  const out = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="results_upload_template.xlsx"`);
  return res.send(out);
}

export async function downloadRejectionsCsv(req, res) {
  const resultBatchId = req.params.resultBatchId;
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(
      `SELECT rejected_json FROM result_upload_rejections WHERE result_batch_id = ? LIMIT 1`,
      [resultBatchId]
    );
    const rejected = rows?.[0]?.rejected_json ? JSON.parse(rows[0].rejected_json) : [];

    const lines = [];
    lines.push(["row", "matric_number", "full_name", "reason"].map(escapeCsvCell).join(","));
    for (const r of rejected) {
      lines.push([r.row, r.matric_number, r.full_name || "", r.reason].map(escapeCsvCell).join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="rejections_${resultBatchId}.csv"`);
    return res.send(lines.join("\n"));
  } catch (err) {
    return res.status(500).send("Failed to build CSV");
  } finally {
    if (conn) conn.release();
  }
}

// -------------------------
// Upload API
// -------------------------
export async function apiUploadResults(req, res) {
  const staffId = getStaffId(req);
  if (!staffId) return res.status(401).json({ ok: false, message: "Not logged in" });

  const {
    sessionId,
    semesterId,
    schoolId,
    departmentId,
    programmeId,
    level,
    batchId,
    courseId,
    overrideExisting,
  } = req.body || {};

  if (!sessionId || !semesterId || !batchId || !courseId) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ ok: false, message: "No file uploaded" });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // semester label -> key
    const semLabelCol =
      (await pickLabelColumn(conn, "semesters", ["name", "semester", "title", "label"])) || "id";
    const [semRows] = await conn.query(
      `SELECT id, ${semLabelCol} AS label FROM semesters WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    const semesterKey = mapSemesterNameToKey(semRows?.[0]?.label ?? semesterId);

    // verify assignment (handles course_assignments.semester_id OR course_assignments.semester)
    const caCols = await getColumns(conn, "course_assignments");
    const hasSemId = caCols.has("semester_id");
    const hasSemText = caCols.has("semester");

    let semWhere = "1=1";
    let semParams = [];
    if (hasSemId) {
      semWhere = "ca.semester_id = ?";
      semParams = [semesterId];
    } else if (hasSemText) {
      semWhere = "(LOWER(ca.semester) = LOWER(?) OR ca.semester = ?)";
      semParams = [semesterKey, String(semesterId)];
    }

    const [assignRows] = await conn.query(
      `
      SELECT ca.id
      FROM course_assignments ca
      WHERE ca.staff_id = ?
        AND ca.session_id = ?
        AND ca.course_id = ?
        AND ${semWhere}
      LIMIT 1
      `,
      [staffId, sessionId, courseId, ...semParams]
    );

    if (!assignRows?.length) {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        message: "Course is not assigned to you for the selected session/semester.",
      });
    }

    // final level fallback from course if not supplied
    let finalLevel = safeStr(level);
    if (!finalLevel) {
      const [cRows] = await conn.query(`SELECT level FROM courses WHERE id = ? LIMIT 1`, [courseId]);
      finalLevel = safeStr(cRows?.[0]?.level);
    }

    // EXISTING batch — now includes school/department/programme uniqueness too
    const rbCols = await getColumns(conn, "result_batches");
    const hasSchool = rbCols.has("school_id");
    const hasDept = rbCols.has("department_id");
    const hasProg = rbCols.has("programme_id");

    const whereParts = [
      "rb.course_id = ?",
      "rb.uploader_staff_id = ?",
      "rb.session_id = ?",
      "LOWER(rb.semester) = LOWER(?)",
      "rb.batch_id = ?",
      "rb.level = ?",
    ];
    const whereParams = [courseId, staffId, sessionId, semesterKey, batchId, finalLevel || ""];

    if (hasSchool) {
      whereParts.push("rb.school_id <=> ?");
      whereParams.push(schoolId || null);
    }
    if (hasDept) {
      whereParts.push("rb.department_id <=> ?");
      whereParams.push(departmentId || null);
    }
    if (hasProg) {
      whereParts.push("rb.programme_id <=> ?");
      whereParams.push(programmeId || null);
    }

    const [existingBatchRows] = await conn.query(
      `
      SELECT
        rb.*,
        (SELECT COUNT(*) FROM course_results cr WHERE cr.result_batch_id = rb.id) AS results_count
      FROM result_batches rb
      WHERE ${whereParts.join("\n AND ")}
      LIMIT 1
      `,
      whereParams
    );

    const existing = existingBatchRows?.[0] || null;
    let resultBatchId = existing?.id || null;
    const resultsCount = Number(existing?.results_count || 0);

    const override = toBool(overrideExisting);

    // Strict lock after approval (HOD and beyond)
    const lockedStatuses = new Set([
      "HOD_APPROVED",
      "DEAN_APPROVED",
      "BUSINESS_APPROVED",
      "FINAL",
      "REGISTRY_APPROVED",
    ]);
    const existingStatus = String(existing?.status || "").toUpperCase().trim();
    if (resultBatchId && lockedStatuses.has(existingStatus)) {
      await conn.rollback();
      const when = existing?.uploaded_at || existing?.updated_at || "";
      return res.status(409).json({
        ok: false,
        message: `Result already ${existingStatus} and cannot be overwritten. ${when ? `Last updated: ${when}` : ""}`.trim(),
        resultBatchId,
      });
    }

    // If batch exists and has results, require override checkbox
    if (resultBatchId && resultsCount > 0 && !override) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        message:
          "A result upload already exists for this selection. Tick 'Override existing upload' to replace it.",
        resultBatchId,
      });
    }

    // override: clear old rows + rejections
    if (resultBatchId && (override || resultsCount === 0)) {
      await conn.query(`DELETE FROM course_results WHERE result_batch_id = ?`, [resultBatchId]);
      await conn.query(`DELETE FROM result_upload_rejections WHERE result_batch_id = ?`, [resultBatchId]);

      // Update tags for clarity
      await conn.query(
        `
        UPDATE result_batches
        SET uploaded_at = NOW(),
            school_id = ?,
            department_id = ?,
            programme_id = ?,
            level = ?,
            batch_id = ?,
            semester = ?,
            session_id = ?
        WHERE id = ?
        `,
        [
          schoolId || null,
          departmentId || null,
          programmeId || null,
          finalLevel || null,
          batchId || null,
          semesterKey,
          sessionId,
          resultBatchId,
        ]
      );
    }

    // Create if none
    if (!resultBatchId) {
      const [ins] = await conn.query(
        `
        INSERT INTO result_batches
          (course_id, uploader_staff_id, session_id, semester, school_id, department_id, programme_id, level, batch_id, status, uploaded_at, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED', NOW(), NOW())
        `,
        [
          courseId,
          staffId,
          sessionId,
          semesterKey,
          schoolId || null,
          departmentId || null,
          programmeId || null,
          finalLevel || null,
          batchId,
        ]
      );
      resultBatchId = ins.insertId;
    }

    const gradeScales = await getGradeScales(conn);

    // Parse file (supports title row + header row)
    const parsedRows = parseUploadSheet(req.file.buffer);

    // Build matric list
    const matricList = Array.from(
      new Set(
        parsedRows
          .map((r) => safeStr(r.matric_number).toUpperCase())
          .filter(Boolean)
      )
    );

    // Bulk fetch students
    // Bulk fetch students
    const studentsByMatric = new Map();
    if (matricList.length) {
      const [stuRows] = await conn.query(
        `
        SELECT
          id,
          matric_number,
          COALESCE(
            NULLIF(CONCAT_WS(' ', first_name, middle_name, last_name), ''),
            username,
            'Student'
          ) AS full_name
        FROM public_users
        WHERE role = 'student'
          AND matric_number IN (?)
        `,
        [matricList]
      );

      for (const s of stuRows || []) {
        const m = safeStr(s.matric_number).toUpperCase();
        studentsByMatric.set(m, { id: s.id, full_name: safeStr(s.full_name) });
      }
    }

    // Bulk fetch registrations for this course + session + semester (SUBMITTED only)
    const registeredStudentIds = new Set();
    const regTypeByStudentId = new Map();

    const studentIds = Array.from(new Set(Array.from(studentsByMatric.values()).map((x) => x.id)));
    if (studentIds.length) {
      const [regRows] = await conn.query(
        `
        SELECT student_id, reg_type
        FROM student_course_regs
        WHERE session_id = ?
          AND semester = ?
          AND course_id = ?
          AND status = 'SUBMITTED'
          AND student_id IN (?)
        `,
        [sessionId, semesterKey, courseId, studentIds]
      );

      for (const r of regRows || []) {
        registeredStudentIds.add(Number(r.student_id));
        regTypeByStudentId.set(Number(r.student_id), safeStr(r.reg_type).toUpperCase());
      }
    }

    const rejected = [];
    let inserted = 0;

    for (const r of parsedRows) {
      const matric = safeStr(r.matric_number).toUpperCase();
      const sheetName = safeStr(r.full_name);

      if (!matric) {
        rejected.push({ row: r.rowNum, matric_number: "", full_name: sheetName, reason: "Missing matric_number" });
        continue;
      }

      const stu = studentsByMatric.get(matric);
      if (!stu) {
        rejected.push({
          row: r.rowNum,
          matric_number: matric,
          full_name: sheetName,
          reason: "Student not found in public_users",
        });
        continue;
      }

      // Strict drop: must be registered for the course in student_course_regs (SUBMITTED)
      if (!registeredStudentIds.has(Number(stu.id))) {
        rejected.push({
          row: r.rowNum,
          matric_number: matric,
          full_name: stu.full_name || sheetName,
          reason: "STUDENT NOT REGISTERED",
        });
        continue;
      }

      // REG_TYPE rules (MAIN/ELECTIVE/CARRYOVER)
      const normalized = normalizeRegType(r.reg_type);
      if (normalized === "__INVALID__") {
        rejected.push({
          row: r.rowNum,
          matric_number: matric,
          full_name: stu.full_name || sheetName,
          reason: "INVALID REG_TYPE (use MAIN, ELECTIVE, or CARRYOVER)",
        });
        continue;
      }

      // If reg_type was provided, optionally ensure it matches registration
      // (If blank in sheet, we use the DB reg_type)
      const dbReg = regTypeByStudentId.get(Number(stu.id)) || "";
      const finalRegType = normalized ? normalized : dbReg || "MAIN";

      // If sheet provided reg_type and it conflicts with DB, treat as "not registered" (per your spec)
      if (normalized && dbReg && normalized !== dbReg) {
        rejected.push({
          row: r.rowNum,
          matric_number: matric,
          full_name: stu.full_name || sheetName,
          reason: "STUDENT NOT REGISTERED (REG_TYPE MISMATCH)",
        });
        continue;
      }

      // Validate scores
      const v = clampAndValidateScores(r.ca1, r.ca2, r.ca3, r.exam);
      if (!v.ok) {
        rejected.push({
          row: r.rowNum,
          matric_number: matric,
          full_name: stu.full_name || sheetName,
          reason: "INVALID SCORE (CA1/CA2/CA3 max 10, EXAM max 70)",
        });
        continue;
      }

      const total = Number(v.ca1) + Number(v.ca2) + Number(v.ca3) + Number(v.exam);
      const { grade, points } = computeGrade(gradeScales, total);

      await conn.query(
        `
        INSERT INTO course_results
          (result_batch_id, student_id, course_id, reg_type, ca1, ca2, ca3, exam, total, grade, points, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          reg_type = VALUES(reg_type),
          ca1 = VALUES(ca1),
          ca2 = VALUES(ca2),
          ca3 = VALUES(ca3),
          exam = VALUES(exam),
          total = VALUES(total),
          grade = VALUES(grade),
          points = VALUES(points),
          updated_at = NOW()
        `,
        [
          resultBatchId,
          stu.id,
          courseId,
          finalRegType,
          v.ca1,
          v.ca2,
          v.ca3,
          v.exam,
          total,
          grade,
          points,
        ]
      );

      inserted++;
    }

    if (rejected.length) {
      await conn.query(
        `
        INSERT INTO result_upload_rejections (result_batch_id, rejected_json, created_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE rejected_json = VALUES(rejected_json)
        `,
        [resultBatchId, JSON.stringify(rejected)]
      );
    }

    // Status: if no valid inserts, mark EMPTY to avoid treating as usable upload
    const newStatus = inserted > 0 ? "UPLOADED" : "EMPTY";
    await conn.query(`UPDATE result_batches SET status = ?, uploaded_at = NOW() WHERE id = ?`, [
      newStatus,
      resultBatchId,
    ]);

    await conn.commit();

    const severity = inserted > 0 ? (rejected.length > 0 ? "warning" : "success") : "danger";

    return res.json({
      ok: inserted > 0,
      severity,
      message: `Upload complete. Inserted: ${inserted}, Rejected: ${rejected.length}`,
      inserted,
      rejectedCount: rejected.length,
      resultBatchId,
      hasRejections: rejected.length > 0,
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    console.error("apiUploadResults error:", err);
    return res.status(500).json({ ok: false, message: err.message || "Upload failed" });
  } finally {
    if (conn) conn.release();
  }
}
