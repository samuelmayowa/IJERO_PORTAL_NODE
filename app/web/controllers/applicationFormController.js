import db from "../../core/db.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeCode(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
}

function normalizeStatus(value) {
  const status = clean(value).toUpperCase();
  return ["DRAFT", "OPEN", "CLOSED", "INACTIVE"].includes(status)
    ? status
    : "DRAFT";
}

function mysqlDateTime(value) {
  const raw = clean(value);
  if (!raw) return "";

  const normalized = raw.replace("T", " ");
  return normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
}

function normalizeInstructions(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function validateInstructions(value) {
  const normalized = normalizeInstructions(value);

  if (!normalized) return "";

  const lines = normalized.split("\n");

  if (lines.length > 5) {
    return "Applicant instructions must not exceed 5 lines.";
  }

  for (let index = 0; index < lines.length; index += 1) {
    const words = lines[index]
      .split(/\s+/)
      .filter(Boolean);

    if (words.length > 10) {
      return `Instruction line ${index + 1} must not exceed 10 words.`;
    }
  }

  return "";
}

function dateTimeLocal(value) {
  if (!value) return "";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const pad = (n) => String(n).padStart(2, "0");

  return [
    d.getFullYear(),
    "-",
    pad(d.getMonth() + 1),
    "-",
    pad(d.getDate()),
    "T",
    pad(d.getHours()),
    ":",
    pad(d.getMinutes()),
  ].join("");
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
  const role = clean(
    user?.role || user?.role_name || user?.type,
  ).toLowerCase();

  return (
    role === "admin" ||
    role === "administrator" ||
    role === "portal administrator"
  );
}

function requireAdmin(req, res) {
  if (isAdmin(req, res)) return true;

  req.flash?.(
    "error",
    "Only admin users can manage application forms.",
  );
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
  if (req.query?.created) {
    return "Application form created successfully.";
  }

  if (req.query?.updated) {
    return "Application form updated successfully.";
  }

  if (req.query?.status) {
    return "Application form status updated successfully.";
  }

  return "";
}

function parseCharges(namesValue, amountsValue, stage) {
  const names = asArray(namesValue);
  const amounts = asArray(amountsValue);
  const rows = [];

  for (let i = 0; i < Math.max(names.length, amounts.length); i += 1) {
    const chargeName = clean(names[i]);
    if (!chargeName) continue;

    rows.push({
      charge_name: chargeName,
      charge_stage: stage,
      amount: money(amounts[i]),
      display_order: rows.length + 1,
    });
  }

  return rows;
}

const APPLICATION_TYPES = new Set([
  "ND",
  "HND",
  "PRELIM",
  "UTME",
]);

function normalizeApplicationType(value) {
  const normalized = clean(value).toUpperCase();

  const aliases = {
    JAMB: "UTME",
    PUTME: "UTME",
    "POST UTME": "UTME",
    "POST-UTME": "UTME",
  };

  return aliases[normalized] || normalized;
}

function readPayload(req) {
  const body = req.body || {};

  const code = normalizeCode(body.code);
  const title = clean(body.title);

  const applicationCharges = parseCharges(
    body.application_charge_name,
    body.application_charge_amount,
    "APPLICATION",
  );

  const acceptanceCharges = parseCharges(
    body.acceptance_charge_name,
    body.acceptance_charge_amount,
    "ACCEPTANCE",
  );

  return {
    code,
    slug: slugify(body.slug || `${code}-${title}`),
    title,
    category: normalizeApplicationType(body.category),
    description: clean(body.description),
    instructions: normalizeInstructions(body.instructions),
    session_id: Number(body.session_id || 0),
    application_payment_type_id:
      Number(body.application_payment_type_id || 0) || null,
    acceptance_payment_type_id:
      Number(body.acceptance_payment_type_id || 0) || null,
    opens_at: mysqlDateTime(body.opens_at),
    closes_at: mysqlDateTime(body.closes_at),
    status: normalizeStatus(body.status),
    requires_prerequisite:
      body.requires_prerequisite === "1" ||
      body.requires_prerequisite === "on"
        ? 1
        : 0,
    prerequisite_match_mode:
      clean(body.prerequisite_match_mode).toUpperCase() || "NONE",
    allow_multiple_applications:
      body.allow_multiple_applications === "1" ||
      body.allow_multiple_applications === "on"
        ? 1
        : 0,
    applicationCharges,
    acceptanceCharges,
  };
}

function validatePayload(payload) {
  if (!payload.code) return "Application code is required.";
  if (!payload.title) return "Application title is required.";

  if (!APPLICATION_TYPES.has(payload.category)) {
    return "Select a valid application type.";
  }

  const instructionError = validateInstructions(
    payload.instructions,
  );

  if (instructionError) return instructionError;

  if (!payload.session_id) return "Academic session is required.";
  if (!payload.opens_at) return "Opening date and time are required.";
  if (!payload.closes_at) return "Closing date and time are required.";

  if (
    new Date(payload.opens_at).getTime() >=
    new Date(payload.closes_at).getTime()
  ) {
    return "Closing date must be after the opening date.";
  }

  if (!payload.applicationCharges.length) {
    return "Add at least one application-stage charge. It may have an amount of zero.";
  }

  const applicationTotal = payload.applicationCharges.reduce(
    (sum, row) => sum + money(row.amount),
    0,
  );

  const acceptanceTotal = payload.acceptanceCharges.reduce(
    (sum, row) => sum + money(row.amount),
    0,
  );

  if (applicationTotal > 0 && !payload.application_payment_type_id) {
    return "Select the Remita payment type to use for application-stage charges.";
  }

  if (acceptanceTotal > 0 && !payload.acceptance_payment_type_id) {
    return "Select the Remita payment type to use for acceptance-stage charges.";
  }

  if (
    payload.requires_prerequisite &&
    payload.prerequisite_match_mode === "NONE"
  ) {
    return "Select a prerequisite matching method.";
  }

  if (
    !["NONE", "EMAIL", "PHONE", "REFERENCE", "NAME"].includes(
      payload.prerequisite_match_mode,
    )
  ) {
    return "Invalid prerequisite matching method.";
  }

  return "";
}

async function loadLookups() {
  const [sessions] = await db.query(`
    SELECT id, name, is_current
    FROM sessions
    ORDER BY id DESC
  `);

  const [paymentTypes] = await db.query(`
    SELECT
      id,
      name,
      purpose,
      amount,
      portal_charge,
      remita_service_type_id,
      scope
    FROM payment_types
    WHERE is_active = 1
    ORDER BY name ASC, purpose ASC
  `);

  return {
    sessions: sessions || [],
    paymentTypes: paymentTypes || [],
  };
}

async function loadForms() {
  const [rows] = await db.query(`
    SELECT
      f.*,
      s.name AS session_name,
      COALESCE(c.application_total, 0) AS application_total,
      COALESCE(c.acceptance_total, 0) AS acceptance_total,
      COALESCE(a.application_count, 0) AS application_count
    FROM application_forms f
    LEFT JOIN sessions s
      ON s.id = f.session_id
    LEFT JOIN (
      SELECT
        application_form_id,
        SUM(
          CASE
            WHEN charge_stage = 'APPLICATION' AND is_active = 1
            THEN amount ELSE 0
          END
        ) AS application_total,
        SUM(
          CASE
            WHEN charge_stage = 'ACCEPTANCE' AND is_active = 1
            THEN amount ELSE 0
          END
        ) AS acceptance_total
      FROM application_form_charges
      GROUP BY application_form_id
    ) c
      ON c.application_form_id = f.id
    LEFT JOIN (
      SELECT
        application_form_id,
        COUNT(*) AS application_count
      FROM applicant_applications
      GROUP BY application_form_id
    ) a
      ON a.application_form_id = f.id
    ORDER BY f.id DESC
  `);

  return rows || [];
}

async function loadForm(id) {
  const [rows] = await db.query(`
    SELECT *
    FROM application_forms
    WHERE id = ?
    LIMIT 1
  `, [id]);

  const form = rows?.[0] || null;
  if (!form) return null;

  const [charges] = await db.query(`
    SELECT *
    FROM application_form_charges
    WHERE application_form_id = ?
      AND is_active = 1
    ORDER BY charge_stage ASC, display_order ASC, id ASC
  `, [id]);

  form.application_charges = (charges || []).filter(
    (row) => row.charge_stage === "APPLICATION",
  );

  form.acceptance_charges = (charges || []).filter(
    (row) => row.charge_stage === "ACCEPTANCE",
  );

  const [batches] = await db.query(`
    SELECT
      id,
      original_filename,
      imported_rows,
      valid_rows,
      invalid_rows,
      status,
      uploaded_at
    FROM application_prerequisite_batches
    WHERE application_form_id = ?
    ORDER BY id DESC
    LIMIT 10
  `, [id]);

  const [summaryRows] = await db.query(`
    SELECT
      COUNT(*) AS total_rows,
      SUM(CASE WHEN match_status <> 'INVALID' THEN 1 ELSE 0 END) AS valid_rows,
      SUM(CASE WHEN match_status = 'INVALID' THEN 1 ELSE 0 END) AS invalid_rows
    FROM application_prerequisites
    WHERE application_form_id = ?
  `, [id]);

  form.prerequisite_batches = batches || [];
  form.prerequisite_summary = summaryRows?.[0] || {
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
  };

  return form;
}

async function saveCharges(connection, formId, charges) {
  await connection.query(`
    DELETE FROM application_form_charges
    WHERE application_form_id = ?
  `, [formId]);

  for (const charge of charges) {
    await connection.query(`
      INSERT INTO application_form_charges
        (
          application_form_id,
          charge_name,
          charge_stage,
          amount,
          display_order,
          is_active
        )
      VALUES (?, ?, ?, ?, ?, 1)
    `, [
      formId,
      charge.charge_name,
      charge.charge_stage,
      charge.amount,
      charge.display_order,
    ]);
  }
}

async function renderManagePage(req, res, editing = null) {
  const lookups = await loadLookups();
  const forms = await loadForms();

  return res.render("applications/manage-forms", {
    title: editing
      ? "Edit Application Form"
      : "Manage Application Forms",
    pageTitle: editing
      ? "Edit Application Form"
      : "Manage Application Forms",
    messages: flashMessages(req),
    notice: actionNotice(req),
    editing,
    forms,
    dateTimeLocal,
    ...lookups,
  });
}

export async function listApplicationForms(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;
    return await renderManagePage(req, res, null);
  } catch (err) {
    next(err);
  }
}

export async function editApplicationForm(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const editing = await loadForm(Number(req.params.id || 0));

    if (!editing) {
      req.flash?.("error", "Application form not found.");
      return res.redirect("/staff/fees/application-forms");
    }

    return await renderManagePage(req, res, editing);
  } catch (err) {
    next(err);
  }
}

export async function createApplicationForm(req, res, next) {
  let connection;

  try {
    if (!requireAdmin(req, res)) return;

    const payload = readPayload(req);
    const error = validatePayload(payload);

    if (error) {
      req.flash?.("error", error);
      return res.redirect("/staff/fees/application-forms");
    }

    const staff = getStaffUser(req, res);

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.query(`
      INSERT INTO application_forms
        (
          code,
          slug,
          title,
          category,
          description,
          instructions,
          session_id,
          application_payment_type_id,
          acceptance_payment_type_id,
          opens_at,
          closes_at,
          status,
          requires_prerequisite,
          prerequisite_match_mode,
          allow_multiple_applications,
          created_by
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      payload.code,
      payload.slug,
      payload.title,
      payload.category,
      payload.description || null,
      payload.instructions || null,
      payload.session_id,
      payload.application_payment_type_id,
      payload.acceptance_payment_type_id,
      payload.opens_at,
      payload.closes_at,
      payload.status,
      payload.requires_prerequisite,
      payload.requires_prerequisite
        ? payload.prerequisite_match_mode
        : "NONE",
      payload.allow_multiple_applications,
      staff?.id || null,
    ]);

    await saveCharges(
      connection,
      result.insertId,
      [
        ...payload.applicationCharges,
        ...payload.acceptanceCharges,
      ],
    );

    await connection.commit();

    if (payload.requires_prerequisite) {
      return res.redirect(
        `/staff/fees/application-forms/${result.insertId}/edit?created=1#prerequisite-upload`,
      );
    }

    return res.redirect(
      "/staff/fees/application-forms?created=1#configured-forms",
    );
  } catch (err) {
    if (connection) await connection.rollback();

    if (err?.code === "ER_DUP_ENTRY") {
      req.flash?.(
        "error",
        "An application with that code or URL slug already exists.",
      );
      return res.redirect("/staff/fees/application-forms");
    }

    next(err);
  } finally {
    connection?.release();
  }
}

export async function updateApplicationForm(req, res, next) {
  let connection;

  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id || 0);
    const existing = await loadForm(id);

    if (!existing) {
      req.flash?.("error", "Application form not found.");
      return res.redirect("/staff/fees/application-forms");
    }

    const payload = readPayload(req);
    const error = validatePayload(payload);

    if (error) {
      req.flash?.("error", error);
      return res.redirect(
        `/staff/fees/application-forms/${id}/edit`,
      );
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(`
      UPDATE application_forms
      SET
        code = ?,
        slug = ?,
        title = ?,
        category = ?,
        description = ?,
        instructions = ?,
        session_id = ?,
        application_payment_type_id = ?,
        acceptance_payment_type_id = ?,
        opens_at = ?,
        closes_at = ?,
        status = ?,
        requires_prerequisite = ?,
        prerequisite_match_mode = ?,
        allow_multiple_applications = ?
      WHERE id = ?
    `, [
      payload.code,
      payload.slug,
      payload.title,
      payload.category,
      payload.description || null,
      payload.instructions || null,
      payload.session_id,
      payload.application_payment_type_id,
      payload.acceptance_payment_type_id,
      payload.opens_at,
      payload.closes_at,
      payload.status,
      payload.requires_prerequisite,
      payload.requires_prerequisite
        ? payload.prerequisite_match_mode
        : "NONE",
      payload.allow_multiple_applications,
      id,
    ]);

    await saveCharges(
      connection,
      id,
      [
        ...payload.applicationCharges,
        ...payload.acceptanceCharges,
      ],
    );

    await connection.commit();

    return res.redirect(
      "/staff/fees/application-forms?updated=1#configured-forms",
    );
  } catch (err) {
    if (connection) await connection.rollback();

    if (err?.code === "ER_DUP_ENTRY") {
      req.flash?.(
        "error",
        "An application with that code or URL slug already exists.",
      );
      return res.redirect(
        `/staff/fees/application-forms/${req.params.id}/edit`,
      );
    }

    next(err);
  } finally {
    connection?.release();
  }
}

export async function setApplicationFormStatus(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id || 0);
    const status = normalizeStatus(req.body?.status);

    const [existing] = await db.query(`
      SELECT id, requires_prerequisite
      FROM application_forms
      WHERE id = ?
      LIMIT 1
    `, [id]);

    if (!existing.length) {
      req.flash?.("error", "Application form not found.");
      return res.redirect("/staff/fees/application-forms");
    }

    if (
      status === "OPEN" &&
      Number(existing[0].requires_prerequisite) === 1
    ) {
      const [prerequisiteRows] = await db.query(`
        SELECT COUNT(*) AS valid_rows
        FROM application_prerequisites
        WHERE application_form_id = ?
          AND match_status <> 'INVALID'
      `, [id]);

      if (Number(prerequisiteRows?.[0]?.valid_rows || 0) < 1) {
        req.flash?.(
          "error",
          "Upload at least one valid prerequisite candidate before opening this application.",
        );

        return res.redirect(
          `/staff/fees/application-forms/${id}/edit#prerequisite-upload`,
        );
      }
    }

    await db.query(`
      UPDATE application_forms
      SET status = ?
      WHERE id = ?
    `, [status, id]);

    return res.redirect(
      "/staff/fees/application-forms?status=1#configured-forms",
    );
  } catch (err) {
    next(err);
  }
}
