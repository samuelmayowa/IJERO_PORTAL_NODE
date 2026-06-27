import { pool } from "../../core/db.js";

const APPLICATION_STATUSES = new Set([
  "DRAFT",
  "AWAITING_PAYMENT",
  "IN_PROGRESS",
  "SUBMITTED",
  "UNDER_REVIEW",
  "ADMITTED",
  "REJECTED",
  "WITHDRAWN",
]);

const PAYMENT_STATUSES = new Set([
  "NOT_REQUIRED",
  "UNPAID",
  "PENDING",
  "PAID",
  "FAILED",
]);

const PAGE_SIZES = new Set([25, 50, 100]);

function clean(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function validDate(value) {
  const text = clean(value);

  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? text
    : "";
}

function parseStoredFormData(value) {
  if (
    value &&
    typeof value === "object" &&
    !Buffer.isBuffer(value)
  ) {
    return value;
  }

  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(String(value));

    return parsed && typeof parsed === "object"
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function enrichApplication(row) {
  const formData = parseStoredFormData(row.form_data);

  const details =
    formData.application_details &&
    typeof formData.application_details === "object"
      ? formData.application_details
      : {};

  const personal =
    details.personal &&
    typeof details.personal === "object"
      ? details.personal
      : {};

  const jamb =
    details.jamb &&
    typeof details.jamb === "object"
      ? details.jamb
      : {};

  const programmeChoice =
    details.programme_choice &&
    typeof details.programme_choice === "object"
      ? details.programme_choice
      : {};

  return {
    ...row,

    jamb_registration_number:
      jamb.registration_number ||
      jamb.jamb_registration_number ||
      jamb.candidate_reference ||
      personal.jamb_registration_number ||
      "",

    jamb_total_score:
      personal.jamb_total_score ??
      jamb.jamb_total_score ??
      jamb.total_score ??
      jamb.jamb_score ??
      jamb.score ??
      "",

    programme_name:
      programmeChoice.programme_name ||
      row.programme_choice ||
      "",
  };
}

async function loadSessions() {
  const [rows] = await pool.query(`
    SELECT id, name, is_current
    FROM sessions
    ORDER BY is_current DESC, id DESC
  `);

  return rows || [];
}

async function loadDefaultSessionId(sessions) {
  const [[latestApplicationSession]] =
    await pool.query(
      `
        SELECT
          af.session_id

        FROM applicant_applications aa

        INNER JOIN application_forms af
          ON af.id = aa.application_form_id

        GROUP BY af.session_id

        ORDER BY
          MAX(
            COALESCE(
              aa.submitted_at,
              aa.created_at
            )
          ) DESC,
          af.session_id DESC

        LIMIT 1
      `,
    );

  if (latestApplicationSession?.session_id) {
    return Number(
      latestApplicationSession.session_id,
    );
  }

  const current = sessions.find(
    (session) =>
      Number(session.is_current) === 1,
  );

  return Number(
    current?.id ||
    sessions[0]?.id ||
    0,
  );
}

function resolveSessionId(
  queryValue,
  sessions,
  defaultSessionId,
) {
  const requested = positiveInteger(queryValue);

  if (
    requested &&
    sessions.some(
      (session) =>
        Number(session.id) === requested,
    )
  ) {
    return requested;
  }

  return Number(defaultSessionId || 0);
}

function readFilters(
  req,
  sessions,
  defaultSessionId,
) {
  const sessionId = resolveSessionId(
    req.query.session_id,
    sessions,
    defaultSessionId,
  );

  const requestedStatus = clean(
    req.query.status,
  ).toUpperCase();

  const requestedPaymentStatus = clean(
    req.query.payment_status,
  ).toUpperCase();

  const requestedPageSize = positiveInteger(
    req.query.page_size,
    25,
  );

  return {
    session_id: sessionId,

    application_form_id: positiveInteger(
      req.query.application_form_id,
    ),

    programme: clean(req.query.programme),

    status: APPLICATION_STATUSES.has(requestedStatus)
      ? requestedStatus
      : "",

    payment_status: PAYMENT_STATUSES.has(
      requestedPaymentStatus,
    )
      ? requestedPaymentStatus
      : "",

    from_date: validDate(req.query.from_date),
    to_date: validDate(req.query.to_date),

    q: clean(req.query.q).slice(0, 150),

    page: positiveInteger(req.query.page, 1),

    page_size: PAGE_SIZES.has(requestedPageSize)
      ? requestedPageSize
      : 25,
  };
}

function buildScopeWhere(filters) {
  const clauses = ["af.session_id = ?"];
  const params = [filters.session_id];

  if (filters.application_form_id) {
    clauses.push("aa.application_form_id = ?");
    params.push(filters.application_form_id);
  }

  return {
    sql: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function buildListWhere(filters) {
  const clauses = ["af.session_id = ?"];
  const params = [filters.session_id];

  if (filters.application_form_id) {
    clauses.push("aa.application_form_id = ?");
    params.push(filters.application_form_id);
  }

  if (filters.programme) {
    clauses.push(`
      (
        aa.programme_choice = ?
        OR aa.form_data LIKE ?
      )
    `);

    params.push(
      filters.programme,
      `%"programme_name":"${filters.programme}"%`,
    );
  }

  if (filters.status) {
    clauses.push("aa.status = ?");
    params.push(filters.status);
  }

  if (filters.payment_status) {
    clauses.push(
      "aa.application_payment_status = ?",
    );
    params.push(filters.payment_status);
  }

  if (filters.from_date) {
    clauses.push(`
      DATE(
        COALESCE(
          aa.submitted_at,
          aa.created_at
        )
      ) >= ?
    `);

    params.push(filters.from_date);
  }

  if (filters.to_date) {
    clauses.push(`
      DATE(
        COALESCE(
          aa.submitted_at,
          aa.created_at
        )
      ) <= ?
    `);

    params.push(filters.to_date);
  }

  if (filters.q) {
    const search = `%${filters.q}%`;

    clauses.push(`
      (
        aa.application_number LIKE ?
        OR CONCAT_WS(
          ' ',
          pu.first_name,
          pu.middle_name,
          pu.last_name
        ) LIKE ?
        OR pu.username LIKE ?
        OR pu.phone LIKE ?
        OR aa.programme_choice LIKE ?
        OR pi.rrr LIKE ?
        OR aa.form_data LIKE ?
      )
    `);

    params.push(
      search,
      search,
      search,
      search,
      search,
      search,
      search,
    );
  }

  return {
    sql: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

const APPLICATION_FROM_SQL = `
  FROM applicant_applications aa

  INNER JOIN application_forms af
    ON af.id = aa.application_form_id

  INNER JOIN sessions s
    ON s.id = af.session_id

  INNER JOIN public_users pu
    ON pu.id = aa.applicant_user_id
    AND pu.role = 'applicant'

  LEFT JOIN payment_invoices pi
    ON pi.id = aa.application_invoice_id
`;

const APPLICATION_SELECT_SQL = `
  SELECT
    aa.id,
    aa.application_form_id,
    aa.applicant_user_id,
    aa.application_number,
    aa.programme_choice,
    aa.form_data,
    aa.application_payment_status,
    aa.acceptance_payment_status,
    aa.status AS application_status,
    aa.submitted_at,
    aa.created_at,
    aa.updated_at,

    af.title AS application_title,
    af.slug AS application_slug,
    af.category,

    s.id AS session_id,
    s.name AS session_name,

    pu.first_name,
    pu.middle_name,
    pu.last_name,
    pu.username,
    pu.phone,

    CONCAT_WS(
      ' ',
      pu.first_name,
      pu.middle_name,
      pu.last_name
    ) AS applicant_name,

    pi.order_id,
    pi.rrr,
    pi.status AS invoice_status,
    pi.amount,
    pi.portal_charge,
    pi.method,
    pi.paid_at
`;

async function loadOptions(filters, sessions) {
  const [forms] = await pool.query(
    `
      SELECT id, title, category, status
      FROM application_forms
      WHERE session_id = ?
      ORDER BY title ASC
    `,
    [filters.session_id],
  );

  const [programmes] = await pool.query(
    `
      SELECT DISTINCT programme_choice AS name
      FROM applicant_applications aa
      INNER JOIN application_forms af
        ON af.id = aa.application_form_id
      WHERE af.session_id = ?
        AND programme_choice IS NOT NULL
        AND TRIM(programme_choice) <> ''
      ORDER BY programme_choice ASC
    `,
    [filters.session_id],
  );

  return {
    sessions,
    forms: forms || [],
    programmes: programmes || [],
  };
}

async function loadSummary(filters) {
  const scope = buildListWhere(filters);

  const [[summary]] = await pool.query(
    `
      SELECT
        COUNT(aa.id) AS total_started,

        COALESCE(
          SUM(
            CASE
              WHEN aa.status IN (
                'DRAFT',
                'AWAITING_PAYMENT',
                'IN_PROGRESS'
              )
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS in_progress,

        COALESCE(
          SUM(
            CASE
              WHEN aa.submitted_at IS NOT NULL
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS total_submitted,

        COALESCE(
          SUM(
            CASE
              WHEN aa.status = 'UNDER_REVIEW'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS under_review,

        COALESCE(
          SUM(
            CASE
              WHEN aa.status = 'ADMITTED'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS total_admitted,

        COALESCE(
          SUM(
            CASE
              WHEN aa.status = 'REJECTED'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS total_rejected,

        COALESCE(
          SUM(
            CASE
              WHEN DATE(aa.submitted_at) = CURDATE()
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS submitted_today,

        COALESCE(
          SUM(
            CASE
              WHEN pi.status = 'PAID'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS application_paid_count,

        COALESCE(
          SUM(
            CASE
              WHEN pi.status = 'PAID'
              THEN
                COALESCE(pi.amount, 0) +
                COALESCE(pi.portal_charge, 0)
              ELSE 0
            END
          ),
          0
        ) AS application_paid_amount

      ${APPLICATION_FROM_SQL}
      ${scope.sql}
    `,
    scope.params,
  );

  return summary || {};
}

async function loadDailySubmitted(filters) {
  const scope = buildListWhere(filters);

  const [rows] = await pool.query(
    `
      SELECT
        DATE(aa.submitted_at) AS activity_date,
        COUNT(aa.id) AS total_submitted

      ${APPLICATION_FROM_SQL}

      ${scope.sql}
        AND aa.submitted_at IS NOT NULL
        AND aa.submitted_at >=
          DATE_SUB(CURDATE(), INTERVAL 29 DAY)

      GROUP BY DATE(aa.submitted_at)
      ORDER BY activity_date DESC
    `,
    scope.params,
  );

  return rows || [];
}

async function loadApplicationRows(
  filters,
  {
    paginate = true,
    page = 1,
    pageSize = 25,
  } = {},
) {
  const where = buildListWhere(filters);

  let paginationSql = "";
  const params = [...where.params];

  if (paginate) {
    paginationSql = "LIMIT ? OFFSET ?";

    params.push(
      pageSize,
      (page - 1) * pageSize,
    );
  } else {
    paginationSql = "LIMIT 50000";
  }

  const [rows] = await pool.query(
    `
      ${APPLICATION_SELECT_SQL}
      ${APPLICATION_FROM_SQL}
      ${where.sql}

      ORDER BY
        COALESCE(
          aa.submitted_at,
          aa.created_at
        ) DESC,
        aa.id DESC

      ${paginationSql}
    `,
    params,
  );

  return (rows || []).map(enrichApplication);
}

function buildExportQuery(filters) {
  const values = {
    session_id: filters.session_id,
    application_form_id:
      filters.application_form_id || "",
    programme: filters.programme,
    status: filters.status,
    payment_status: filters.payment_status,
    from_date: filters.from_date,
    to_date: filters.to_date,
    q: filters.q,
  };

  return Object.entries(values)
    .filter(([, value]) => String(value ?? "") !== "")
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=` +
        `${encodeURIComponent(value)}`,
    )
    .join("&");
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString().replace("T", " ").slice(0, 19);
}

export async function applicationsReport(
  req,
  res,
  next,
) {
  try {
    const sessions = await loadSessions();

    const defaultSessionId =
      await loadDefaultSessionId(sessions);

    const filters = readFilters(
      req,
      sessions,
      defaultSessionId,
    );

    const where = buildListWhere(filters);

    const [[countRow]] = await pool.query(
      `
        SELECT COUNT(aa.id) AS total
        ${APPLICATION_FROM_SQL}
        ${where.sql}
      `,
      where.params,
    );

    const total = Number(countRow?.total || 0);

    const totalPages = Math.max(
      1,
      Math.ceil(total / filters.page_size),
    );

    const page = Math.min(
      filters.page,
      totalPages,
    );

    filters.page = page;

    const [
      rows,
      summary,
      dailySubmitted,
      options,
    ] = await Promise.all([
      loadApplicationRows(filters, {
        paginate: true,
        page,
        pageSize: filters.page_size,
      }),

      loadSummary(filters),

      loadDailySubmitted(filters),

      loadOptions(filters, sessions),
    ]);

    return res.render(
      "pages/staff/application-report",
      {
        layout: "layouts/adminlte",
        title: "Applications Report",
        pageTitle: "Applications Report",
        currentPath:
          req.originalUrl || req.path || "",

        rows,
        summary,
        dailySubmitted,
        filters,
        options,

        pagination: {
          page,
          pageSize: filters.page_size,
          total,
          totalPages,
        },

        exportQuery: buildExportQuery(filters),

        allowedModules:
          res.locals.allowedModules || null,

        user:
          res.locals.user ||
          req.session?.user ||
          req.session?.staff ||
          null,
      },
    );
  } catch (error) {
    next(error);
  }
}

export async function exportApplicationsCsv(
  req,
  res,
  next,
) {
  try {
    const sessions = await loadSessions();

    const defaultSessionId =
      await loadDefaultSessionId(sessions);

    const filters = readFilters(
      req,
      sessions,
      defaultSessionId,
    );

    const rows = await loadApplicationRows(
      filters,
      {
        paginate: false,
      },
    );

    const headers = [
      "Application Number",
      "Applicant Name",
      "Username / Email",
      "Phone",
      "JAMB Registration Number",
      "UTME Score",
      "Academic Session",
      "Application Form",
      "Category",
      "Programme",
      "Application Status",
      "Application Payment Status",
      "RRR",
      "Application Fee",
      "Portal Charge",
      "Total Paid",
      "Payment Method",
      "Payment Date",
      "Submitted Date",
      "Created Date",
    ];

    const lines = [headers.map(csvEscape).join(",")];

    for (const row of rows) {
      lines.push(
        [
          row.application_number,
          row.applicant_name,
          row.username,
          row.phone,
          row.jamb_registration_number,
          row.jamb_total_score,
          row.session_name,
          row.application_title,
          row.category,
          row.programme_name,
          row.application_status,
          row.application_payment_status,
          row.rrr,
          Number(row.amount || 0).toFixed(2),
          Number(row.portal_charge || 0).toFixed(2),
          (
            Number(row.amount || 0) +
            Number(row.portal_charge || 0)
          ).toFixed(2),
          row.method,
          csvDate(row.paid_at),
          csvDate(row.submitted_at),
          csvDate(row.created_at),
        ].map(csvEscape).join(","),
      );
    }

    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8",
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="applications_report.csv"',
    );

    return res.send(
      "\uFEFF" + lines.join("\r\n"),
    );
  } catch (error) {
    next(error);
  }
}
