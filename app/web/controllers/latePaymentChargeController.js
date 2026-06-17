import db from "../../core/db.js";

function toRows(x) {
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSemester(value) {
  const raw = clean(value).toUpperCase();
  if (!raw || raw === "0" || raw === "ALL") return "ALL";
  if (raw === "1" || raw.startsWith("FIRST")) return "FIRST";
  if (raw === "2" || raw.startsWith("SECOND")) return "SECOND";
  return raw;
}

function normalizeScope(value) {
  const raw = clean(value).toUpperCase();
  if (["ALL", "SCHOOL", "DEPARTMENT", "PROGRAMME"].includes(raw)) return raw;
  return "ALL";
}

function getStaffUser(req, res) {
  return (
    req.user ||
    req.session?.user ||
    req.session?.staff ||
    res.locals?.user ||
    null
  );
}

function isAdmin(req, res) {
  const user = getStaffUser(req, res);
  const role = clean(user?.role || user?.role_name || user?.type).toLowerCase();
  return role === "admin" || role === "administrator" || role === "portal administrator";
}

function requireAdmin(req, res) {
  if (isAdmin(req, res)) return true;
  req.flash?.("error", "Only admin users can manage late payment charges.");
  res.redirect("/staff/dashboard");
  return false;
}

function flashMessages(req) {
  return req.flash
    ? {
        error: req.flash("error")?.[0] || "",
        success: req.flash("success")?.[0] || "",
      }
    : {};
}

function actionNotice(req) {
  if (req.query?.created) return "Late payment charge rule created successfully.";
  if (req.query?.updated) return "Late payment charge rule updated successfully.";
  if (req.query?.status) return "Late payment charge rule status updated.";
  return "";
}

async function loadLookups() {
  const [sessions] = await db.query(
    `SELECT id, name, is_current FROM sessions ORDER BY id DESC`
  );

  const [paymentTypes] = await db.query(
    `
      SELECT id, name, purpose, amount, portal_charge, scope, is_active
      FROM payment_types
      WHERE is_active = 1
      ORDER BY name ASC, purpose ASC
    `
  );

  const [schools] = await db.query(`SELECT id, name FROM schools ORDER BY name ASC`);
  const [departments] = await db.query(
    `SELECT id, school_id, name FROM departments ORDER BY name ASC`
  );
  const [programmes] = await db.query(
    `SELECT id, school_id, department_id, name FROM programmes ORDER BY name ASC`
  );

  return {
    sessions: sessions || [],
    paymentTypes: paymentTypes || [],
    schools: schools || [],
    departments: departments || [],
    programmes: programmes || [],
  };
}

async function loadRules() {
  const [rows] = await db.query(
    `
      SELECT
        r.*,
        s.name AS session_name,
        sch.name AS school_name,
        d.name AS department_name,
        p.name AS programme_name,
        GROUP_CONCAT(CONCAT(pt.name, ' — ', pt.purpose) ORDER BY pt.name SEPARATOR '||') AS payment_type_labels
      FROM tuition_late_fee_rules r
      LEFT JOIN sessions s ON s.id = r.session_id
      LEFT JOIN schools sch ON sch.id = r.school_id
      LEFT JOIN departments d ON d.id = r.department_id
      LEFT JOIN programmes p ON p.id = r.programme_id
      LEFT JOIN tuition_late_fee_rule_payment_types rpt ON rpt.rule_id = r.id
      LEFT JOIN payment_types pt ON pt.id = rpt.payment_type_id
      GROUP BY r.id
      ORDER BY r.id DESC
    `
  );

  return (rows || []).map((row) => ({
    ...row,
    payment_type_labels: clean(row.payment_type_labels)
      ? clean(row.payment_type_labels).split("||")
      : [],
  }));
}

async function loadRule(id) {
  const [rows] = await db.query(
    `SELECT * FROM tuition_late_fee_rules WHERE id = ? LIMIT 1`,
    [id]
  );

  const rule = rows?.[0] || null;
  if (!rule) return null;

  const [ptRows] = await db.query(
    `SELECT payment_type_id FROM tuition_late_fee_rule_payment_types WHERE rule_id = ?`,
    [id]
  );

  rule.payment_type_ids = (ptRows || []).map((row) => Number(row.payment_type_id));
  return rule;
}

function readPayload(req) {
  const body = req.body || {};
  const scopeType = normalizeScope(body.scope_type);

  const payload = {
    title: clean(body.title),
    session_id: Number(body.session_id || 0),
    semester: normalizeSemester(body.semester),
    deadline_at: clean(body.deadline_at),
    amount: money(body.amount),
    scope_type: scopeType,
    school_id: scopeType === "SCHOOL" ? Number(body.school_id || 0) || null : null,
    department_id:
      scopeType === "DEPARTMENT" ? Number(body.department_id || 0) || null : null,
    programme_id:
      scopeType === "PROGRAMME" ? Number(body.programme_id || 0) || null : null,
    notice_message: clean(body.notice_message),
    is_active: body.is_active === "1" || body.is_active === "on" ? 1 : 0,
    payment_type_ids: asArray(body.payment_type_ids)
      .map((v) => Number(v))
      .filter(Boolean),
  };

  return payload;
}

function validatePayload(payload) {
  if (!payload.title) return "Title is required.";
  if (!payload.session_id) return "Session is required.";
  if (!["ALL", "FIRST", "SECOND"].includes(payload.semester)) {
    return "Semester must be All, First or Second.";
  }
  if (!payload.deadline_at) return "Deadline date/time is required.";
  if (payload.amount <= 0) return "Late payment charge amount must be greater than zero.";
  if (!payload.payment_type_ids.length) {
    return "Select at least one affected payment type.";
  }
  if (payload.scope_type === "SCHOOL" && !payload.school_id) {
    return "Select a school for school-scoped late charge.";
  }
  if (payload.scope_type === "DEPARTMENT" && !payload.department_id) {
    return "Select a department for department-scoped late charge.";
  }
  if (payload.scope_type === "PROGRAMME" && !payload.programme_id) {
    return "Select a programme for programme-scoped late charge.";
  }
  return "";
}

async function savePaymentTypeLinks(ruleId, paymentTypeIds) {
  await db.query(
    `DELETE FROM tuition_late_fee_rule_payment_types WHERE rule_id = ?`,
    [ruleId]
  );

  const ids = Array.from(new Set(paymentTypeIds.map(Number).filter(Boolean)));

  for (const paymentTypeId of ids) {
    await db.query(
      `
        INSERT INTO tuition_late_fee_rule_payment_types
          (rule_id, payment_type_id)
        VALUES (?, ?)
      `,
      [ruleId, paymentTypeId]
    );
  }
}

export async function listLatePaymentCharges(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const lookups = await loadLookups();
    const rules = await loadRules();

    res.render("payment/late-payment-charges", {
      title: "Late Payment Charges",
      pageTitle: "Late Payment Charges",
      messages: flashMessages(req),
      notice: actionNotice(req),
      rules,
      editing: null,
      ...lookups,
    });
  } catch (err) {
    next(err);
  }
}

export async function editLatePaymentCharge(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id || 0);
    const editing = await loadRule(id);

    if (!editing) {
      req.flash?.("error", "Late payment rule not found.");
      return res.redirect("/staff/fees/late-payment-charges");
    }

    const lookups = await loadLookups();
    const rules = await loadRules();

    res.render("payment/late-payment-charges", {
      title: "Edit Late Payment Charge",
      pageTitle: "Edit Late Payment Charge",
      messages: flashMessages(req),
      notice: actionNotice(req),
      rules,
      editing,
      ...lookups,
    });
  } catch (err) {
    next(err);
  }
}

export async function createLatePaymentCharge(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const payload = readPayload(req);
    const error = validatePayload(payload);

    if (error) {
      req.flash?.("error", error);
      return res.redirect("/staff/fees/late-payment-charges");
    }

    const staff = getStaffUser(req, res);

    const [result] = await db.query(
      `
        INSERT INTO tuition_late_fee_rules
          (
            title,
            session_id,
            semester,
            deadline_at,
            amount,
            scope_type,
            school_id,
            department_id,
            programme_id,
            notice_message,
            is_active,
            created_by
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.title,
        payload.session_id,
        payload.semester,
        payload.deadline_at,
        payload.amount,
        payload.scope_type,
        payload.school_id,
        payload.department_id,
        payload.programme_id,
        payload.notice_message || null,
        payload.is_active,
        staff?.id || null,
      ]
    );

    await savePaymentTypeLinks(result.insertId, payload.payment_type_ids);

    return res.redirect("/staff/fees/late-payment-charges?created=1#configured-rules");
  } catch (err) {
    next(err);
  }
}

export async function updateLatePaymentCharge(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id || 0);
    const existing = await loadRule(id);

    if (!existing) {
      req.flash?.("error", "Late payment rule not found.");
      return res.redirect("/staff/fees/late-payment-charges");
    }

    const payload = readPayload(req);
    const error = validatePayload(payload);

    if (error) {
      req.flash?.("error", error);
      return res.redirect(`/staff/fees/late-payment-charges/${id}/edit`);
    }

    await db.query(
      `
        UPDATE tuition_late_fee_rules
        SET
          title = ?,
          session_id = ?,
          semester = ?,
          deadline_at = ?,
          amount = ?,
          scope_type = ?,
          school_id = ?,
          department_id = ?,
          programme_id = ?,
          notice_message = ?,
          is_active = ?
        WHERE id = ?
      `,
      [
        payload.title,
        payload.session_id,
        payload.semester,
        payload.deadline_at,
        payload.amount,
        payload.scope_type,
        payload.school_id,
        payload.department_id,
        payload.programme_id,
        payload.notice_message || null,
        payload.is_active,
        id,
      ]
    );

    await savePaymentTypeLinks(id, payload.payment_type_ids);

    return res.redirect("/staff/fees/late-payment-charges?updated=1#configured-rules");
  } catch (err) {
    next(err);
  }
}

export async function toggleLatePaymentCharge(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id || 0);
    const existing = await loadRule(id);

    if (!existing) {
      req.flash?.("error", "Late payment rule not found.");
      return res.redirect("/staff/fees/late-payment-charges");
    }

    await db.query(
      `
        UPDATE tuition_late_fee_rules
        SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
        WHERE id = ?
      `,
      [id]
    );

    return res.redirect("/staff/fees/late-payment-charges?status=1#configured-rules");
  } catch (err) {
    next(err);
  }
}
