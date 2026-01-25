import { pool } from "../../core/db.js";

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function safeInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

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
  // Expected: staff table has school_id, department_id
  const [rows] = await conn.query(
    `SELECT id, school_id, department_id FROM staff WHERE id = ? LIMIT 1`,
    [staffId]
  );
  const row = rows?.[0] || {};
  return {
    school_id: safeInt(row.school_id),
    department_id: safeInt(row.department_id),
  };
}

function stageForRole(role) {
  // You can tweak these if your workflow differs.
  // Based on earlier locked statuses you mentioned.
  if (role === "hod") {
    return {
      canSeeFrom: ["UPLOADED", "HOD_REJECTED"],
      approveTo: "HOD_APPROVED",
      rejectTo: "HOD_REJECTED",
    };
  }
  if (role === "dean") {
    return {
      canSeeFrom: ["HOD_APPROVED", "DEAN_REJECTED"],
      approveTo: "DEAN_APPROVED",
      rejectTo: "DEAN_REJECTED",
    };
  }
  if (role === "bursary") {
    return {
      canSeeFrom: ["DEAN_APPROVED", "BUSINESS_REJECTED"],
      approveTo: "BUSINESS_APPROVED",
      rejectTo: "BUSINESS_REJECTED",
    };
  }
  if (role === "registry") {
    return {
      canSeeFrom: ["BUSINESS_APPROVED", "REGISTRY_REJECTED"],
      approveTo: "FINAL",
      rejectTo: "REGISTRY_REJECTED",
    };
  }
  // admin/ict can see all & act as registry final gate
  if (role === "admin" || role === "ict") {
    return {
      canSeeFrom: [
        "UPLOADED",
        "HOD_APPROVED",
        "DEAN_APPROVED",
        "BUSINESS_APPROVED",
        "HOD_REJECTED",
        "DEAN_REJECTED",
        "BUSINESS_REJECTED",
        "REGISTRY_REJECTED",
      ],
      approveTo: "FINAL",
      rejectTo: "REGISTRY_REJECTED",
    };
  }
  return null;
}

async function applyScopeWhere(conn, role, staffId) {
  // Scope by COURSE department/school (stable), not student_profiles (can be NULL)
  // courses.department_id -> departments.school_id
  if (role === "hod" || role === "dean") {
    const scope = await getStaffScope(conn, staffId);
    return {
      scope,
      whereSql:
        role === "hod"
          ? ` AND c.department_id = ? `
          : ` AND d.school_id = ? `,
      whereParams:
        role === "hod" ? [scope.department_id] : [scope.school_id],
    };
  }
  return { scope: null, whereSql: "", whereParams: [] };
}

export async function viewApproveResults(req, res) {
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);

    const stage = stageForRole(role);
    if (!stage) {
      return res.status(403).send("Not allowed");
    }

    // sessions list for dropdown
    const [sessions] = await pool.query(
      `SELECT id, name, is_current FROM sessions ORDER BY is_current DESC, id DESC`
    );

    res.render("results/approve-results", {
      pageTitle: "Approve Result",
      role,
      staffId,
      sessions: sessions || [],
      semesters: [
        { value: "FIRST", label: "First" },
        { value: "SECOND", label: "Second" },
      ],
      levels: ["ND1", "ND2", "HND1", "HND2"],
      stage,
    });
  } catch (e) {
    console.error("viewApproveResults error:", e);
    res.status(500).send("Server error");
  }
}

export async function apiListBatches(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);
    const stage = stageForRole(role);
    if (!stage) return res.status(403).json({ ok: false, message: "Not allowed" });

    const sessionId = safeInt(req.query.sessionId);
    const semester = safeStr(req.query.semester).toUpperCase();
    const level = safeStr(req.query.level).toUpperCase();
    const courseId = safeInt(req.query.courseId);
    const status = safeStr(req.query.status).toUpperCase();

    const { whereSql: scopeSql, whereParams: scopeParams } = await applyScopeWhere(
      conn,
      role,
      staffId
    );

    let where = ` WHERE 1=1 `;
    const params = [];

    // Stage status visibility
    if (status) {
      where += ` AND rb.status = ? `;
      params.push(status);
    } else {
      where += ` AND rb.status IN (?) `;
      params.push(stage.canSeeFrom);
    }

    if (sessionId) {
      where += ` AND rb.session_id = ? `;
      params.push(sessionId);
    }
    if (semester === "FIRST" || semester === "SECOND") {
      where += ` AND rb.semester = ? `;
      params.push(semester);
    }
    if (level) {
      where += ` AND rb.level = ? `;
      params.push(level);
    }
    if (courseId) {
      where += ` AND rb.course_id = ? `;
      params.push(courseId);
    }

    const sql = `
      SELECT
        rb.id,
        rb.status,
        rb.uploaded_at,
        rb.session_id,
        rb.semester,
        rb.level,
        rb.batch_id,
        rb.course_id,
        c.code AS course_code,
        c.title AS course_title,
        d.name AS department_name,
        s.name AS school_name,
        (
          SELECT COUNT(*)
          FROM course_results cr
          WHERE cr.result_batch_id = rb.id
        ) AS rows_in_results
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN schools s ON s.id = d.school_id
      ${where}
      ${scopeSql}
      ORDER BY rb.uploaded_at DESC, rb.id DESC
      LIMIT 500
    `;

    const [rows] = await conn.query(sql, [...params, ...scopeParams]);

    res.json({ ok: true, data: rows || [] });
  } catch (e) {
    console.error("apiListBatches error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  } finally {
    conn.release();
  }
}

export async function apiTakeAction(req, res) {
  const conn = await pool.getConnection();
  try {
    const role = getRole(req, res);
    const staffId = getStaffId(req, res);
    const stage = stageForRole(role);
    if (!stage) return res.status(403).json({ ok: false, message: "Not allowed" });

    const batchId = safeInt(req.body.batchId);
    const action = safeStr(req.body.action).toLowerCase(); // approve|reject
    const remark = safeStr(req.body.remark);

    if (!batchId || (action !== "approve" && action !== "reject")) {
      return res.status(400).json({ ok: false, message: "Invalid request" });
    }

    // Load batch + enforce scope
    const [bRows] = await conn.query(
      `
      SELECT rb.*, c.department_id, d.school_id
      FROM result_batches rb
      JOIN courses c ON c.id = rb.course_id
      LEFT JOIN departments d ON d.id = c.department_id
      WHERE rb.id = ?
      LIMIT 1
      `,
      [batchId]
    );
    const batch = bRows?.[0];
    if (!batch) return res.status(404).json({ ok: false, message: "Batch not found" });

    // Scope check (HOD: dept only, Dean: school only)
    if (role === "hod" || role === "dean") {
      const scope = await getStaffScope(conn, staffId);
      if (role === "hod" && scope.department_id && safeInt(batch.department_id) !== scope.department_id) {
        return res.status(403).json({ ok: false, message: "Not allowed (dept scope)" });
      }
      if (role === "dean" && scope.school_id && safeInt(batch.school_id) !== scope.school_id) {
        return res.status(403).json({ ok: false, message: "Not allowed (school scope)" });
      }
    }

    // Must be in allowed "from" status (unless admin/ict override)
    const curStatus = safeStr(batch.status).toUpperCase();
    const isOverride = role === "admin" || role === "ict";
    if (!isOverride && !stage.canSeeFrom.includes(curStatus)) {
      return res.status(400).json({
        ok: false,
        message: `Batch is ${curStatus}, not in allowed stage`,
      });
    }

    const nextStatus = action === "approve" ? stage.approveTo : stage.rejectTo;

    // Update
    await conn.query(
      `UPDATE result_batches SET status = ?, updated_at = NOW() WHERE id = ?`,
      [nextStatus, batchId]
    );

    // Optional audit log (won't break if table doesn't exist)
    try {
      await conn.query(
        `
        CREATE TABLE IF NOT EXISTS result_batch_actions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          result_batch_id INT NOT NULL,
          actor_staff_id INT NULL,
          actor_role VARCHAR(50) NULL,
          action VARCHAR(20) NOT NULL,
          from_status VARCHAR(50) NULL,
          to_status VARCHAR(50) NULL,
          remark TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        `
      );
      await conn.query(
        `
        INSERT INTO result_batch_actions
          (result_batch_id, actor_staff_id, actor_role, action, from_status, to_status, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [batchId, staffId, role, action.toUpperCase(), curStatus, nextStatus, remark || null]
      );
    } catch (_) {}

    res.json({ ok: true, message: `Batch ${nextStatus}` });
  } catch (e) {
    console.error("apiTakeAction error:", e);
    res.status(500).json({ ok: false, message: e.message || "Server error" });
  } finally {
    conn.release();
  }
}
