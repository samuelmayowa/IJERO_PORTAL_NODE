import pool from "../../core/db.js";

/**
 * RESULTS APPROVAL CONTROLLER
 * - Pending batches list (per role scope)
 * - Recently approved list (per role scope)
 * - Courses dropdown for filtering
 * - Approve/Reject action (JSON response)
 * - View uploaded batch preview
 */

function safeInt(v) {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}
function normStr(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
function isAll(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return !s || s === "ALL";
}

function getActor(req) {
  return (
    req?.session?.user ||
    req?.user ||
    req?.session?.currentUser ||
    req?.session?.staff ||
    req?.locals?.user ||
    null
  );
}
function getActorRole(actor) {
  const r =
    actor?.role ||
    actor?.role_name ||
    actor?.roleName ||
    actor?.staff_role ||
    actor?.staffRole ||
    actor?.user_role ||
    actor?.userRole ||
    "";
  return String(r).toUpperCase();
}
function getActorStaffId(actor) {
  return safeInt(actor?.staff_id) ?? safeInt(actor?.staffId) ?? safeInt(actor?.id);
}
function getScopeFromActor(actor) {
  const departmentId =
    safeInt(actor?.department_id) ??
    safeInt(actor?.departmentId) ??
    safeInt(actor?.dept_id) ??
    safeInt(actor?.deptId);

  const schoolId = safeInt(actor?.school_id) ?? safeInt(actor?.schoolId);

  return { departmentId: departmentId ?? null, schoolId: schoolId ?? null };
}

async function loadStaffScope(staffId) {
  if (!staffId) return { departmentId: null, schoolId: null };
  try {
    const [rows] = await pool.query(
      `SELECT id, department_id, school_id FROM staff WHERE id = ? LIMIT 1`,
      [staffId]
    );
    const s = rows?.[0];
    return {
      departmentId: safeInt(s?.department_id),
      schoolId: safeInt(s?.school_id),
    };
  } catch {
    return { departmentId: null, schoolId: null };
  }
}

function pendingStatusesForRole(role) {
  if (role === "HOD") return ["UPLOADED", "HOD_REJECTED"];
  if (role === "DEAN") return ["HOD_APPROVED", "DEAN_REJECTED"];
  if (role === "BUSINESS") return ["DEAN_APPROVED", "BUSINESS_REJECTED"];
  if (role === "ADMIN") return ["BUSINESS_APPROVED"];
  return ["UPLOADED", "HOD_APPROVED", "DEAN_APPROVED", "BUSINESS_APPROVED"];
}
function recentApprovedStatusesForRole(role) {
  if (role === "HOD") return ["HOD_APPROVED", "DEAN_APPROVED", "BUSINESS_APPROVED", "FINAL"];
  if (role === "DEAN") return ["DEAN_APPROVED", "BUSINESS_APPROVED", "FINAL"];
  if (role === "BUSINESS") return ["BUSINESS_APPROVED", "FINAL"];
  if (role === "ADMIN") return ["FINAL"];
  return ["HOD_APPROVED", "DEAN_APPROVED", "BUSINESS_APPROVED", "FINAL"];
}

function nextStatusForAction(role, action, override) {
  const a = String(action || "").toLowerCase();
  const ov = normStr(override);
  if (ov) return ov;

  if (role === "HOD") return a === "reject" ? "HOD_REJECTED" : "HOD_APPROVED";
  if (role === "DEAN") return a === "reject" ? "DEAN_REJECTED" : "DEAN_APPROVED";
  if (role === "BUSINESS") return a === "reject" ? "BUSINESS_REJECTED" : "BUSINESS_APPROVED";
  if (role === "ADMIN") return a === "reject" ? "ADMIN_REJECTED" : "FINAL";
  return a === "reject" ? "REJECTED" : "APPROVED";
}
function commentColumnForRole(role) {
  if (role === "HOD") return "hod_comment";
  if (role === "DEAN") return "dean_comment";
  if (role === "BUSINESS") return "business_comment";
  return null;
}

async function tableColumns(tableName) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `,
    [tableName]
  );
  return new Set((rows || []).map((r) => r.COLUMN_NAME));
}
function pickFirstExisting(colsSet, candidates, fallback) {
  for (const c of candidates) {
    if (colsSet.has(c)) return c;
  }
  return fallback;
}

/** PAGE */
export async function viewApproveResults(req, res) {
  try {
    const [sessions] = await pool.query(
      `SELECT id, name, is_current FROM sessions ORDER BY is_current DESC, id DESC LIMIT 100`
    );

    let semesters = [
      { value: "ALL", label: "All" },
      { value: "FIRST", label: "First" },
      { value: "SECOND", label: "Second" },
    ];

    try {
      const [semRows] = await pool.query(`SELECT code, name FROM semesters ORDER BY id ASC`);
      if (Array.isArray(semRows) && semRows.length) {
        semesters = [{ value: "ALL", label: "All" }].concat(
          semRows.map((s) => ({
            value: String(s.code || s.name || "").toUpperCase(),
            label: s.name || s.code,
          }))
        );
      }
    } catch {}

    let levels = [{ value: "ALL", label: "All" }];
    try {
      const [lvlRows] = await pool.query(
        `SELECT DISTINCT level FROM result_batches WHERE level IS NOT NULL AND level <> '' ORDER BY level ASC`
      );
      levels = levels.concat(
        (lvlRows || []).map((r) => ({ value: String(r.level), label: String(r.level) }))
      );
    } catch {
      levels = levels.concat(
        ["ND1", "ND2", "HND1", "HND2", "100L", "200L", "300L", "400L"].map((l) => ({
          value: l,
          label: l,
        }))
      );
    }

    res.render("results/approve-results", {
      title: "Approve Result",
      sessions: sessions || [],
      semesters,
      levels,
    });
  } catch (e) {
    console.error("viewApproveResults error:", e);
    res.status(500).send("Error loading approval page");
  }
}

/** COURSES DROPDOWN */
export async function apiListCourses(req, res) {
  try {
    const actor = getActor(req);
    const role = getActorRole(actor);
    const staffId = getActorStaffId(actor);

    const directScope = getScopeFromActor(actor);
    const dbScope = await loadStaffScope(staffId);
    const departmentId = directScope.departmentId ?? dbScope.departmentId;
    const schoolId = directScope.schoolId ?? dbScope.schoolId;

    const sessionId = safeInt(req.query.sessionId);
    const semester = normStr(req.query.semester);
    const level = normStr(req.query.level);

    const statuses = Array.from(
      new Set([...pendingStatusesForRole(role), ...recentApprovedStatusesForRole(role)])
    );

    const buildSql = (useScope) => {
      const where = [];
      const params = [];

      where.push(`rb.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);

      if (useScope) {
        // Scope tries BOTH rb.department_id and course.department_id to survive data mismatch
        if (role === "HOD" && departmentId) {
          where.push(`(rb.department_id = ? OR d.id = ?)`);
          params.push(departmentId, departmentId);
        }
        if (role === "DEAN" && schoolId) {
          where.push(`(rb.school_id = ? OR s.id = ?)`);
          params.push(schoolId, schoolId);
        }
      }

      if (sessionId) {
        where.push("rb.session_id = ?");
        params.push(sessionId);
      }
      if (semester && !isAll(semester)) {
        where.push("rb.semester = ?");
        params.push(String(semester).toUpperCase());
      }
      if (level && !isAll(level)) {
        where.push("rb.level = ?");
        params.push(String(level));
      }

      const sql = `
        SELECT DISTINCT
          c.id,
          c.code,
          c.title
        FROM result_batches rb
        JOIN courses c ON c.id = rb.course_id
        JOIN departments d ON d.id = c.department_id
        JOIN schools s ON s.id = d.school_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY c.code ASC
        LIMIT 500
      `;
      return { sql, params };
    };

    // 1) scoped try
    const scoped = buildSql(true);
    let [rows] = await pool.query(scoped.sql, scoped.params);

    // 2) fallback (prevents blank dropdown if scope data mismatch)
    if ((!rows || rows.length === 0) && (role === "HOD" || role === "DEAN")) {
      const unscoped = buildSql(false);
      [rows] = await pool.query(unscoped.sql, unscoped.params);
    }

    res.json(
      (rows || []).map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        label: `${r.code} — ${r.title}`,
      }))
    );
  } catch (e) {
    console.error("apiListCourses error:", e);
    res.status(500).json({ error: "Failed to load courses" });
  }
}

/** BATCH LIST (pending + recent) */
export async function apiListBatches(req, res) {
  try {
    const actor = getActor(req);
    const role = getActorRole(actor);
    const staffId = getActorStaffId(actor);

    const directScope = getScopeFromActor(actor);
    const dbScope = await loadStaffScope(staffId);
    const departmentId = directScope.departmentId ?? dbScope.departmentId;
    const schoolId = directScope.schoolId ?? dbScope.schoolId;

    const mode = String(req.query.mode || "").toLowerCase();
    const isRecent = mode === "recent" || mode === "approved";

    const sessionId = safeInt(req.query.sessionId);
    const semester = normStr(req.query.semester);
    const level = normStr(req.query.level);
    const courseId = safeInt(req.query.courseId);

    const rbCols = await tableColumns("result_batches");
    const rbBatchCol = pickFirstExisting(rbCols, ["batch_id", "batch"], "batch_id");
    const rbUploadedAtCol = pickFirstExisting(rbCols, ["uploaded_at", "created_at"], "uploaded_at");
    const rbApprovedAtCol = pickFirstExisting(rbCols, ["updated_at", "approved_at"], "updated_at");

    // rows count from student_results (your DB supports batch_id there)
    let rowsCountExpr = `0`;
    try {
      const srCols = await tableColumns("student_results");
      if (srCols.has("batch_id")) {
        rowsCountExpr = `(SELECT COUNT(*) FROM student_results sr WHERE sr.batch_id = rb.id)`;
      }
    } catch {}

    const statuses = isRecent ? recentApprovedStatusesForRole(role) : pendingStatusesForRole(role);

    const buildSql = (useScope) => {
      const where = [];
      const params = [];

      where.push(`rb.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);

      if (useScope) {
        if (role === "HOD" && departmentId) {
          // match either rb.department_id OR course.department_id (d.id)
          where.push(`(rb.department_id = ? OR d.id = ?)`);
          params.push(departmentId, departmentId);
        }
        if (role === "DEAN" && schoolId) {
          where.push(`(rb.school_id = ? OR s.id = ?)`);
          params.push(schoolId, schoolId);
        }
      }

      if (sessionId) {
        where.push("rb.session_id = ?");
        params.push(sessionId);
      }
      if (semester && !isAll(semester)) {
        where.push("rb.semester = ?");
        params.push(String(semester).toUpperCase());
      }
      if (level && !isAll(level)) {
        where.push("rb.level = ?");
        params.push(String(level));
      }
      if (courseId) {
        where.push("rb.course_id = ?");
        params.push(courseId);
      }

      const orderCol = isRecent ? rbApprovedAtCol : rbUploadedAtCol;

      const sql = `
        SELECT
          rb.id,
          rb.session_id,
          rb.semester,
          rb.level,
          rb.${rbBatchCol} AS batch_id,
          ${rowsCountExpr} AS rows_in_results,
          rb.status,
          rb.${rbUploadedAtCol} AS uploaded_at,
          rb.${rbApprovedAtCol} AS approved_at,
          rb.course_id,
          c.code AS courseCode,
          c.title AS courseTitle
        FROM result_batches rb
        JOIN courses c ON c.id = rb.course_id
        JOIN departments d ON d.id = c.department_id
        JOIN schools s ON s.id = d.school_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY rb.${orderCol} DESC, rb.id DESC
        LIMIT 500
      `;
      return { sql, params };
    };

    // 1) scoped try
    const scoped = buildSql(true);
    let [rows] = await pool.query(scoped.sql, scoped.params);

    // 2) fallback for HOD/DEAN if scope mismatch would blank the page
    if ((!rows || rows.length === 0) && (role === "HOD" || role === "DEAN")) {
      const unscoped = buildSql(false);
      [rows] = await pool.query(unscoped.sql, unscoped.params);
    }

    res.json(
      (rows || []).map((r) => ({
        id: r.id,
        courseId: r.course_id,
        courseCode: r.courseCode,
        courseTitle: r.courseTitle,
        sessionId: r.session_id,
        semester: r.semester,
        level: r.level,
        batchId: r.batch_id,
        rows: r.rows_in_results ?? 0,
        status: r.status,
        uploadedAt: r.uploaded_at,
        approvedAt: r.approved_at,
      }))
    );
  } catch (e) {
    console.error("apiListBatches error:", e);
    res.status(500).json({ error: "Failed to load batches" });
  }
}

/** APPROVE / REJECT */
export async function apiTakeAction(req, res) {
  try {
    const actor = getActor(req);
    const role = getActorRole(actor);

    const batchId = safeInt(req.body?.batchId);
    const action = normStr(req.body?.action);
    const remark = normStr(req.body?.remark);
    const statusOverride = normStr(req.body?.statusOverride);

    if (!batchId || !action) {
      return res.status(400).json({ error: "batchId and action are required" });
    }

    const nextStatus = nextStatusForAction(role, action, statusOverride);
    const commentCol = commentColumnForRole(role);

    if (commentCol) {
      await pool.query(
        `UPDATE result_batches SET status = ?, ${commentCol} = ?, updated_at = NOW() WHERE id = ?`,
        [nextStatus, remark, batchId]
      );
    } else {
      await pool.query(
        `UPDATE result_batches SET status = ?, updated_at = NOW() WHERE id = ?`,
        [nextStatus, batchId]
      );
    }

    // Update dependent tables if they exist with batch_id + status
    for (const t of ["student_results", "course_results", "exam_results"]) {
      try {
        const cols = await tableColumns(t);
        if (cols.has("batch_id") && cols.has("status")) {
          await pool.query(`UPDATE ${t} SET status = ? WHERE batch_id = ?`, [nextStatus, batchId]);
        }
      } catch {}
    }

    res.json({ ok: true, batchId, status: nextStatus });
  } catch (e) {
    console.error("apiTakeAction error:", e);
    res.status(500).json({ error: "Failed to perform approval action" });
  }
}

/** VIEW PREVIEW */
export async function viewBatchPreview(req, res) {
  try {
    const batchId = safeInt(req.query.batchId);
    if (!batchId) return res.status(400).send("batchId is required");

    const [metaRows] = await pool.query(
      `
        SELECT
          rb.id,
          rb.session_id,
          rb.semester,
          rb.level,
          rb.status,
          rb.uploaded_at,
          c.code AS courseCode,
          c.title AS courseTitle,
          d.name AS deptName,
          s.name AS schoolName
        FROM result_batches rb
        JOIN courses c ON c.id = rb.course_id
        JOIN departments d ON d.id = c.department_id
        JOIN schools s ON s.id = d.school_id
        WHERE rb.id = ?
        LIMIT 1
      `,
      [batchId]
    );

    const meta = metaRows?.[0];
    if (!meta) return res.status(404).send("Batch not found");

    let rows = [];
    try {
      const cols = await tableColumns("student_results");
      const candidates = ["matric_no", "reg_type", "ca1", "ca2", "ca3", "exam", "total", "grade"];
      const selected = candidates.filter((c) => cols.has(c));
      const selectSql = selected.length ? selected.join(", ") : "*";

      const [r] = await pool.query(
        `SELECT ${selectSql} FROM student_results WHERE batch_id = ? ORDER BY id ASC LIMIT 1000`,
        [batchId]
      );
      rows = r || [];
    } catch {
      rows = [];
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Uploaded Result Preview</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 16px; }
          .meta { display: grid; grid-template-columns: 140px 1fr; gap: 6px 14px; max-width: 900px; }
          .box { border: 1px solid #ddd; padding: 10px; border-radius: 6px; }
          .tblWrap { margin-top: 14px; border: 1px solid #ddd; border-radius: 6px; overflow: auto; max-height: 70vh; }
          table { border-collapse: collapse; min-width: 900px; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 12px; white-space: nowrap; }
          th { position: sticky; top: 0; background: #f7f7f7; z-index: 2; }
          h2 { margin: 0 0 10px; }
        </style>
      </head>
      <body>
        <h2>Uploaded Result Preview</h2>
        <div class="box meta">
          <div><b>School:</b></div><div>${meta.schoolName ?? ""}</div>
          <div><b>Department:</b></div><div>${meta.deptName ?? ""}</div>
          <div><b>Course:</b></div><div>${meta.courseCode ?? ""} — ${meta.courseTitle ?? ""}</div>
          <div><b>Session ID:</b></div><div>${meta.session_id ?? ""}</div>
          <div><b>Semester:</b></div><div>${meta.semester ?? ""}</div>
          <div><b>Level:</b></div><div>${meta.level ?? ""}</div>
          <div><b>Status:</b></div><div>${meta.status ?? ""}</div>
        </div>

        <div class="tblWrap">
          <table>
            <thead>
              <tr>
                ${
                  rows?.[0]
                    ? Object.keys(rows[0]).map((k) => `<th>${k}</th>`).join("")
                    : "<th>No data</th>"
                }
              </tr>
            </thead>
            <tbody>
              ${
                rows?.length
                  ? rows
                      .map(
                        (r) =>
                          `<tr>${Object.keys(r).map((k) => `<td>${r[k] ?? ""}</td>`).join("")}</tr>`
                      )
                      .join("")
                  : `<tr><td style="padding:14px;">No rows found for this batch.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.error("viewBatchPreview error:", e);
    res.status(500).send("Failed to load preview");
  }
}
