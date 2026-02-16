// app/web/controllers/results-approval.controller.js
import pool from "../../core/db.js";

/**
 * Small schema-safety layer:
 * - Your DB differs between environments (some columns exist in one but not another).
 * - We query INFORMATION_SCHEMA once per table and build SQL using only existing columns.
 */
const _columnsCache = new Map();

async function getTableColumns(tableName) {
  if (_columnsCache.has(tableName)) return _columnsCache.get(tableName);

  const sql = `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
  `;
  const [rows] = await pool.query(sql, [tableName]);
  const set = new Set(rows.map((r) => r.COLUMN_NAME));
  _columnsCache.set(tableName, set);
  return set;
}

function pickExisting(cols, candidates, fallback = null) {
  for (const c of candidates) if (cols.has(c)) return c;
  return fallback;
}

function getSessionUser(req) {
  // try common shapes used in typical express-session setups
  return req?.session?.user || req?.session?.staff || req?.user || {};
}

function normalizeRole(roleLike) {
  const r = String(roleLike || "").toUpperCase();
  if (r.includes("HOD")) return "HOD";
  if (r.includes("DEAN")) return "DEAN";
  if (r.includes("BUSINESS")) return "BUSINESS";
  if (r.includes("ADMIN")) return "ADMIN";
  return r || "STAFF";
}

function getScope(user) {
  // these keys commonly exist in session user object in your project
  const departmentId =
    user.department_id ?? user.departmentId ?? user.dept_id ?? user.deptId ?? null;

  const schoolId = user.school_id ?? user.schoolId ?? null;

  return { departmentId, schoolId };
}

function allowedStatusesForRole(role) {
  // what each role can SEE in the approval queue
  switch (role) {
    case "HOD":
      return ["UPLOADED", "HOD_REJECTED"];
    case "DEAN":
      return ["HOD_APPROVED", "DEAN_REJECTED"];
    case "BUSINESS":
      return ["DEAN_APPROVED", "BUSINESS_REJECTED"];
    case "ADMIN":
      // admin can see all pending-ish statuses
      return ["UPLOADED", "HOD_REJECTED", "HOD_APPROVED", "DEAN_REJECTED", "DEAN_APPROVED", "BUSINESS_REJECTED"];
    default:
      return ["UPLOADED"];
  }
}

function nextStatusFor(role, action) {
  const a = String(action || "").toLowerCase();
  if (a !== "approve" && a !== "reject") return null;

  if (role === "HOD") return a === "approve" ? "HOD_APPROVED" : "HOD_REJECTED";
  if (role === "DEAN") return a === "approve" ? "DEAN_APPROVED" : "DEAN_REJECTED";
  if (role === "BUSINESS") return a === "approve" ? "BUSINESS_APPROVED" : "BUSINESS_REJECTED";
  if (role === "ADMIN") return a === "approve" ? "FINAL" : "ADMIN_REJECTED";

  // fallback (shouldn’t happen)
  return a === "approve" ? "APPROVED" : "REJECTED";
}

function parseFilter(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || v.toUpperCase() === "ALL") return null;
  return v;
}

/**
 * GET /staff/results/approve
 */
export async function viewApproveResults(req, res) {
  const user = getSessionUser(req);
  const role = normalizeRole(user.role || user.user_role || user.userType);
  let sessions = [];

  // sessions are used by the page dropdown
  // try a few common schema variants
  try {
    const [rows] = await pool.query(
      "SELECT id, name, is_current AS isCurrent FROM sessions ORDER BY is_current DESC, id DESC"
    );
    sessions = rows;
  } catch {
    try {
      const [rows] = await pool.query("SELECT id, name FROM sessions ORDER BY id DESC");
      sessions = rows.map((r) => ({ ...r, isCurrent: 0 }));
    } catch {
      sessions = [];
    }
  }

  return res.render("results/approve-results", {
    pageTitle: "Approve Result",
    sessions,
    role,
  });
}

/**
 * GET /staff/results/approve/api/courses
 * Returns only courses that currently have batches in the approval queue (for this staff scope).
 */
export async function apiListCourses(req, res) {
  try {
    const user = getSessionUser(req);
    const role = normalizeRole(user.role || user.user_role || user.userType);
    const { departmentId, schoolId } = getScope(user);

    const sessionId = parseFilter(req.query.sessionId);
    const semester = parseFilter(req.query.semester);
    const level = parseFilter(req.query.level);

    const statuses = allowedStatusesForRole(role);

    // scope filtering (safe and optional)
    const where = [];
    const params = [];

    where.push(`rb.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);

    if (sessionId) {
      where.push("rb.session_id = ?");
      params.push(Number(sessionId));
    }
    if (semester) {
      where.push("rb.semester = ?");
      params.push(semester);
    }
    if (level) {
      where.push("rb.level = ?");
      params.push(level);
    }

    if (departmentId) {
      where.push("d.id = ?");
      params.push(Number(departmentId));
    } else if (schoolId) {
      where.push("s.id = ?");
      params.push(Number(schoolId));
    }

    const sql = `
      SELECT DISTINCT c.id, c.code, c.title
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      JOIN departments d ON d.id = c.department_id
      JOIN schools s ON s.id = d.school_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.code ASC
      LIMIT 500
    `;

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error("apiListCourses error:", err);
    return res.status(500).json({ error: "Failed to load courses" });
  }
}

/**
 * GET /staff/results/approve/api/list
 * Main queue list.
 */
export async function apiListBatches(req, res) {
  try {
    const user = getSessionUser(req);
    const role = normalizeRole(user.role || user.user_role || user.userType);
    const { departmentId, schoolId } = getScope(user);

    const sessionId = parseFilter(req.query.sessionId);
    const semester = parseFilter(req.query.semester);
    const level = parseFilter(req.query.level);
    const courseId = parseFilter(req.query.courseId);

    const statuses = allowedStatusesForRole(role);

    const rbCols = await getTableColumns("result_batches");
    const crCols = await getTableColumns("course_results");

    const rbBatchCol = pickExisting(rbCols, ["batch_id", "batch"], "batch_id");
    const rbUploadedAtCol = pickExisting(rbCols, ["uploaded_at", "created_at", "updated_at"], "uploaded_at");
    const rbRowsCol = pickExisting(rbCols, ["rows_in_results", "rows", "row_count", "results_count"], null);

    const crBatchRefCol = pickExisting(crCols, ["result_batch_id", "batch_id"], "result_batch_id");

    const where = [];
    const params = [];

    where.push(`rb.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);

    if (sessionId) {
      where.push("rb.session_id = ?");
      params.push(Number(sessionId));
    }
    if (semester) {
      where.push("rb.semester = ?");
      params.push(semester);
    }
    if (level) {
      where.push("rb.level = ?");
      params.push(level);
    }
    if (courseId) {
      where.push("rb.course_id = ?");
      params.push(Number(courseId));
    }

    if (departmentId) {
      where.push("d.id = ?");
      params.push(Number(departmentId));
    } else if (schoolId) {
      where.push("s.id = ?");
      params.push(Number(schoolId));
    }

    const rowsExpr = rbRowsCol
      ? `rb.${rbRowsCol} AS rows_in_results`
      : `(SELECT COUNT(*) FROM course_results cr WHERE cr.${crBatchRefCol} = rb.id) AS rows_in_results`;

    // IMPORTANT FIX: use rb.batch_id (or rb.batch if that’s what exists), never assume rb.batch.
    const sql = `
      SELECT
        rb.id,
        rb.session_id,
        rb.semester,
        rb.level,
        rb.${rbBatchCol} AS batch_id,
        ${rowsExpr},
        rb.status,
        rb.${rbUploadedAtCol} AS uploaded_at,
        rb.course_id,
        c.code AS courseCode,
        c.title AS courseTitle,
        s.name AS schoolName,
        d.name AS deptName
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      JOIN departments d ON d.id = c.department_id
      JOIN schools s ON s.id = d.school_id
      WHERE ${where.join(" AND ")}
      ORDER BY rb.${rbUploadedAtCol} DESC, rb.id DESC
      LIMIT 500
    `;

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error("apiListBatches error:", err);
    return res.status(500).json({ error: "Failed to load approval list" });
  }
}

/**
 * GET /staff/results/approve/view?batchId=123
 * VIEW page (scrollable preview) – used before approving.
 */
export async function viewBatchPreview(req, res) {
  try {
    const batchId = Number(req.query.batchId);
    if (!batchId) return res.status(400).send("Invalid batchId");

    const crCols = await getTableColumns("course_results");
    const crBatchRefCol = pickExisting(crCols, ["result_batch_id", "batch_id"], "result_batch_id");

    const [batchRows] = await pool.query(
      `
        SELECT rb.id, rb.session_id, rb.semester, rb.level, rb.course_id, rb.status,
               c.code AS courseCode, c.title AS courseTitle,
               d.name AS deptName, s.name AS schoolName
        FROM result_batches rb
        JOIN courses c ON c.id = rb.course_id
        JOIN departments d ON d.id = c.department_id
        JOIN schools s ON s.id = d.school_id
        WHERE rb.id = ?
        LIMIT 1
      `,
      [batchId]
    );

    if (!batchRows.length) return res.status(404).send("Batch not found");

    const batch = batchRows[0];

    // Pull rows (safe: select * and render a known subset if present)
    const [rows] = await pool.query(
      `SELECT * FROM course_results WHERE ${crBatchRefCol} = ? ORDER BY id ASC LIMIT 5000`,
      [batchId]
    );

    // pick columns to display (based on what exists)
    const preferred = [
      "matric_no",
      "matric",
      "matricNo",
      "full_name",
      "fullName",
      "reg_type",
      "regType",
      "ca1",
      "ca2",
      "ca3",
      "exam",
      "exam_score",
      "total",
      "grade",
      "gp",
      "remark",
    ];

    const available = rows.length ? Object.keys(rows[0]) : [];
    const displayCols = preferred.filter((c) => available.includes(c));
    // fallback: show first 15 columns if we couldn't match
    const finalCols = displayCols.length ? displayCols : available.slice(0, 15);

    const escapeHtml = (v) =>
      String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const head = finalCols
      .map((c) => `<th>${escapeHtml(c)}</th>`)
      .join("");

    const body = rows
      .map((r, idx) => {
        const tds = finalCols.map((c) => `<td>${escapeHtml(r[c])}</td>`).join("");
        return `<tr><td>${idx + 1}</td>${tds}</tr>`;
      })
      .join("");

    // simple HTML page with both scrollbars
    return res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Batch Preview</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 16px; }
          .meta { margin-bottom: 10px; font-size: 14px; }
          .meta b { display:inline-block; min-width:110px; }
          .wrap { border: 1px solid #ddd; padding: 8px; overflow: auto; max-height: 80vh; }
          table { border-collapse: collapse; width: max-content; min-width: 100%; }
          th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; white-space: nowrap; }
          th { background: #f3f3f3; position: sticky; top: 0; z-index: 2; }
        </style>
      </head>
      <body>
        <h3>Uploaded Result Preview</h3>
        <div class="meta">
          <div><b>School:</b> ${escapeHtml(batch.schoolName)}</div>
          <div><b>Department:</b> ${escapeHtml(batch.deptName)}</div>
          <div><b>Course:</b> ${escapeHtml(batch.courseCode)} — ${escapeHtml(batch.courseTitle)}</div>
          <div><b>Session ID:</b> ${escapeHtml(batch.session_id)}</div>
          <div><b>Semester:</b> ${escapeHtml(batch.semester)}</div>
          <div><b>Level:</b> ${escapeHtml(batch.level)}</div>
          <div><b>Status:</b> ${escapeHtml(batch.status)}</div>
          <div><b>Rows:</b> ${rows.length}</div>
        </div>

        <div class="wrap">
          <table>
            <thead>
              <tr><th>#</th>${head}</tr>
            </thead>
            <tbody>
              ${rows.length ? body : `<tr><td colspan="${finalCols.length + 1}">No rows found.</td></tr>`}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("viewBatchPreview error:", err);
    return res.status(500).send("Failed to load preview");
  }
}

/**
 * POST /staff/results/approve/api/action
 * Body: { batchId, action: "approve"|"reject", remark?: string }
 */
export async function apiTakeAction(req, res) {
  try {
    const user = getSessionUser(req);
    const role = normalizeRole(user.role || user.user_role || user.userType);

    const batchId = Number(req.body.batchId);
    const action = String(req.body.action || "").toLowerCase();
    const remark = req.body.remark == null ? null : String(req.body.remark);

    if (!batchId || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ ok: false, error: "Invalid batchId or action" });
    }

    const newStatus = nextStatusFor(role, action);
    if (!newStatus) {
      return res.status(400).json({ ok: false, error: "Unsupported action" });
    }

    const rbCols = await getTableColumns("result_batches");
    const crCols = await getTableColumns("course_results");

    const rbRemarkCol = pickExisting(rbCols, ["remark", "approval_remark", "note"], null);
    const rbUpdatedAtCol = pickExisting(rbCols, ["updated_at"], null);

    const crStatusCol = pickExisting(crCols, ["status"], null);
    const crBatchRefCol = pickExisting(crCols, ["result_batch_id", "batch_id"], "result_batch_id");

    await pool.query("START TRANSACTION");

    // Update batch status (+ optional remark)
    const sets = ["status = ?"];
    const params = [newStatus];

    if (rbRemarkCol) {
      sets.push(`${rbRemarkCol} = ?`);
      params.push(remark);
    }
    if (rbUpdatedAtCol) {
      sets.push(`${rbUpdatedAtCol} = NOW()`);
    }

    params.push(batchId);

    await pool.query(`UPDATE result_batches SET ${sets.join(", ")} WHERE id = ?`, params);

    // If course_results has a status column, update it too (keeps “INTERIM → APPROVED” style workflows consistent)
    if (crStatusCol) {
      await pool.query(
        `UPDATE course_results SET ${crStatusCol} = ? WHERE ${crBatchRefCol} = ?`,
        [newStatus, batchId]
      );
    }

    await pool.query("COMMIT");
    return res.json({ ok: true, batchId, status: newStatus });
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    console.error("apiTakeAction error:", err);
    return res.status(500).json({ ok: false, error: "Approval action failed" });
  }
}
