import { pool } from "../../core/db.js";
import XLSX from "xlsx";
import PDFDocument from "pdfkit";

const PAGE_SIZES = new Set([25, 50, 100]);

const PAYMENT_STATUSES = new Set([
  "NOT_REQUIRED",
  "NOT_AVAILABLE",
  "UNPAID",
  "PENDING",
  "PAID",
  "FAILED",
  "CANCELLED",
]);

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

function enrichRow(row) {
  const formData = parseStoredFormData(
    row.form_data,
  );

  const details =
    formData.application_details &&
    typeof formData.application_details === "object"
      ? formData.application_details
      : {};

  const programmeChoice =
    details.programme_choice &&
    typeof details.programme_choice === "object"
      ? details.programme_choice
      : {};

  return {
    ...row,

    programme_name:
      programmeChoice.programme_name ||
      programmeChoice.programme ||
      row.programme_choice ||
      "",
  };
}

function reportConfig(stage) {
  if (stage === "ACCEPTANCE") {
    return {
      stage: "ACCEPTANCE",
      title: "Acceptance Fee Report",
      pageTitle: "Acceptance Fee Report",
      basePath:
        "/staff/fees/acceptance-fees",
      exportPath:
        "/staff/fees/acceptance-fees/export.csv",
      filename:
        "acceptance_fee_report.csv",
      invoiceColumn:
        "aa.acceptance_invoice_id",
      statusColumn:
        "aa.acceptance_payment_status",
      additionalCondition:
        "aa.status = 'ADMITTED'",
      emptyStatusLabel: "NOT AVAILABLE",
    };
  }

  return {
    stage: "APPLICATION",
    title: "Application Fee Report",
    pageTitle: "Application Fee Report",
    basePath:
      "/staff/fees/application-fees",
    exportPath:
      "/staff/fees/application-fees/export.csv",
    filename:
      "application_fee_report.csv",
    invoiceColumn:
      "aa.application_invoice_id",
    statusColumn:
      "aa.application_payment_status",
    additionalCondition: "1 = 1",
    emptyStatusLabel: "UNPAID",
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
  const [[latestSession]] = await pool.query(`
    SELECT af.session_id
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
  `);

  if (latestSession?.session_id) {
    return Number(latestSession.session_id);
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

function readFilters(
  req,
  sessions,
  defaultSessionId,
) {
  const requestedSessionId = positiveInteger(
    req.query.session_id,
  );

  const sessionId =
    requestedSessionId &&
    sessions.some(
      (session) =>
        Number(session.id) ===
        requestedSessionId,
    )
      ? requestedSessionId
      : defaultSessionId;

  const requestedStatus = clean(
    req.query.payment_status,
  ).toUpperCase();

  const requestedPageSize = positiveInteger(
    req.query.page_size,
    25,
  );

  return {
    session_id: Number(sessionId || 0),

    application_form_id: positiveInteger(
      req.query.application_form_id,
    ),

    programme: clean(req.query.programme),

    payment_status:
      PAYMENT_STATUSES.has(requestedStatus)
        ? requestedStatus
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

function baseFrom(config) {
  return `
    FROM applicant_applications aa

    INNER JOIN application_forms af
      ON af.id = aa.application_form_id

    INNER JOIN sessions s
      ON s.id = af.session_id

    INNER JOIN public_users pu
      ON pu.id = aa.applicant_user_id
      AND pu.role = 'applicant'

    LEFT JOIN payment_invoices pi
      ON pi.id = ${config.invoiceColumn}
  `;
}

function buildWhere(filters, config) {
  const clauses = [
    "af.session_id = ?",
    config.additionalCondition,
  ];

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

  if (filters.payment_status) {
    clauses.push(`
      COALESCE(
        pi.status,
        ${config.statusColumn}
      ) = ?
    `);

    params.push(filters.payment_status);
  }

  if (filters.from_date) {
    clauses.push(`
      DATE(
        COALESCE(
          pi.paid_at,
          pi.created_at,
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
          pi.paid_at,
          pi.created_at,
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
        OR pi.order_id LIKE ?
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
      search,
    );
  }

  return {
    sql: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

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
      SELECT DISTINCT
        aa.programme_choice AS name

      FROM applicant_applications aa

      INNER JOIN application_forms af
        ON af.id = aa.application_form_id

      WHERE af.session_id = ?
        AND aa.programme_choice IS NOT NULL
        AND TRIM(aa.programme_choice) <> ''

      ORDER BY aa.programme_choice ASC
    `,
    [filters.session_id],
  );

  return {
    sessions,
    forms: forms || [],
    programmes: programmes || [],
  };
}

async function loadSummary(filters, config) {
  const where = buildWhere(filters, config);

  const [[summary]] = await pool.query(
    `
      SELECT
        COUNT(aa.id) AS total_records,

        COALESCE(
          SUM(
            CASE
              WHEN pi.status = 'PAID'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS successful_payments,

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
        ) AS successful_amount,

        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(
                pi.status,
                ${config.statusColumn}
              ) = 'PENDING'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS pending_payments,

        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(
                pi.status,
                ${config.statusColumn}
              ) IN (
                'UNPAID',
                'NOT_AVAILABLE',
                'NOT_REQUIRED'
              )
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS unpaid_payments,

        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(
                pi.status,
                ${config.statusColumn}
              ) IN (
                'FAILED',
                'CANCELLED'
              )
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS failed_payments,

        COALESCE(
          SUM(
            CASE
              WHEN pi.status = 'PAID'
                AND DATE(pi.paid_at) = CURDATE()
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS paid_today,

        COALESCE(
          SUM(
            CASE
              WHEN pi.status = 'PAID'
                AND DATE(pi.paid_at) = CURDATE()
              THEN
                COALESCE(pi.amount, 0) +
                COALESCE(pi.portal_charge, 0)
              ELSE 0
            END
          ),
          0
        ) AS amount_paid_today

      ${baseFrom(config)}
      ${where.sql}
    `,
    where.params,
  );

  return summary || {};
}

async function loadDailySuccessful(
  filters,
  config,
) {
  const where = buildWhere(filters, config);

  const [rows] = await pool.query(
    `
      SELECT
        DATE(pi.paid_at) AS activity_date,
        COUNT(aa.id) AS successful_payments,

        SUM(
          COALESCE(pi.amount, 0) +
          COALESCE(pi.portal_charge, 0)
        ) AS successful_amount

      ${baseFrom(config)}

      ${where.sql}
        AND pi.status = 'PAID'
        AND pi.paid_at IS NOT NULL
        AND pi.paid_at >=
          DATE_SUB(CURDATE(), INTERVAL 29 DAY)

      GROUP BY DATE(pi.paid_at)
      ORDER BY activity_date DESC
    `,
    where.params,
  );

  return rows || [];
}

async function loadRows(
  filters,
  config,
  {
    paginate = true,
    page = 1,
    pageSize = 25,
  } = {},
) {
  const where = buildWhere(filters, config);
  const params = [...where.params];

  let paginationSql = "LIMIT 50000";

  if (paginate) {
    paginationSql = "LIMIT ? OFFSET ?";

    params.push(
      pageSize,
      (page - 1) * pageSize,
    );
  }

  const [rows] = await pool.query(
    `
      SELECT
        aa.id,
        aa.application_number,
        aa.programme_choice,
        aa.form_data,
        aa.status AS application_status,
        aa.submitted_at,
        aa.created_at,

        ${config.statusColumn}
          AS stage_payment_status,

        COALESCE(
          pi.status,
          ${config.statusColumn}
        ) AS payment_status,

        af.id AS application_form_id,
        af.title AS application_title,
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

        pi.id AS invoice_id,
        pi.order_id,
        pi.rrr,
        pi.amount,
        pi.portal_charge,
        pi.method,
        pi.status AS invoice_status,
        pi.paid_at,
        pi.created_at AS invoice_created_at

      ${baseFrom(config)}
      ${where.sql}

      ORDER BY
        COALESCE(
          pi.paid_at,
          pi.created_at,
          aa.submitted_at,
          aa.created_at
        ) DESC,
        aa.id DESC

      ${paginationSql}
    `,
    params,
  );

  return (rows || []).map(enrichRow);
}

function buildExportQuery(filters) {
  const values = {
    session_id: filters.session_id,

    application_form_id:
      filters.application_form_id || "",

    programme: filters.programme,

    payment_status:
      filters.payment_status,

    from_date: filters.from_date,
    to_date: filters.to_date,
    q: filters.q,
  };

  return Object.entries(values)
    .filter(
      ([, value]) =>
        String(value ?? "") !== "",
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=` +
        `${encodeURIComponent(value)}`,
    )
    .join("&");
}

function csvEscape(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text)
    ? `'${text}`
    : text;
  return `"${safe.replace(
    /"/g,
    '""',
  )}"`;
}

function csvDate(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

async function reportPage(
  req,
  res,
  next,
  stage,
) {
  try {
    const config = reportConfig(stage);
    const sessions = await loadSessions();

    const defaultSessionId =
      await loadDefaultSessionId(sessions);

    const filters = readFilters(
      req,
      sessions,
      defaultSessionId,
    );

    const where = buildWhere(filters, config);

    const [[countRow]] = await pool.query(
      `
        SELECT COUNT(aa.id) AS total
        ${baseFrom(config)}
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
      dailySuccessful,
      options,
    ] = await Promise.all([
      loadRows(filters, config, {
        paginate: true,
        page,
        pageSize: filters.page_size,
      }),

      loadSummary(filters, config),

      loadDailySuccessful(
        filters,
        config,
      ),

      loadOptions(filters, sessions),
    ]);

    return res.render(
      "pages/staff/bursary-payment-report",
      {
        layout: "layouts/adminlte",
        title: config.title,
        pageTitle: config.pageTitle,

        currentPath:
          req.originalUrl || req.path || "",

        config,
        filters,
        options,
        rows,
        summary,
        dailySuccessful,

        pagination: {
          page,
          pageSize: filters.page_size,
          total,
          totalPages,
        },

        exportQuery:
          buildExportQuery(filters),

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

async function exportCsv(
  req,
  res,
  next,
  stage,
) {
  try {
    const config = reportConfig(stage);
    const sessions = await loadSessions();

    const defaultSessionId =
      await loadDefaultSessionId(sessions);

    const filters = readFilters(
      req,
      sessions,
      defaultSessionId,
    );

    const rows = await loadRows(
      filters,
      config,
      {
        paginate: false,
      },
    );

    const headers = [
      "Application Number",
      "Applicant Name",
      "Username / Email",
      "Phone",
      "Academic Session",
      "Application Form",
      "Programme",
      "Application Status",
      "Payment Status",
      "RRR",
      "Order ID",
      "Amount",
      "Portal Charge",
      "Total",
      "Payment Method",
      "Payment Date",
      "Invoice Created",
    ];

    const lines = [
      headers.map(csvEscape).join(","),
    ];

    for (const row of rows) {
      lines.push(
        [
          row.application_number,
          row.applicant_name,
          row.username,
          row.phone,
          row.session_name,
          row.application_title,
          row.programme_name,
          row.application_status,
          row.payment_status,
          row.rrr,
          row.order_id,
          Number(row.amount || 0).toFixed(2),
          Number(
            row.portal_charge || 0,
          ).toFixed(2),
          (
            Number(row.amount || 0) +
            Number(row.portal_charge || 0)
          ).toFixed(2),
          row.method,
          csvDate(row.paid_at),
          csvDate(row.invoice_created_at),
        ].map(csvEscape).join(","),
      );
    }

    res.setHeader(
      "Content-Type",
      "text/csv; charset=utf-8",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${config.filename}"`,
    );

    return res.send(
      "\uFEFF" + lines.join("\r\n"),
    );
  } catch (error) {
    next(error);
  }
}

function exportRows(rows) {
  const spreadsheetSafe = (value) => {
    const text = String(value ?? "");
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  };
  return rows.map(row => ({
    "Application Number": spreadsheetSafe(row.application_number),
    "Applicant Name": spreadsheetSafe(row.applicant_name),
    "Email": spreadsheetSafe(row.username),
    "Phone": row.phone || "",
    "Academic Session": row.session_name || "",
    "Application Form": row.application_title || "",
    "Programme": row.programme_name || "",
    "Application Status": row.application_status || "",
    "Payment Status": row.payment_status || "",
    "RRR": row.rrr || "",
    "Order ID": row.order_id || "",
    "Amount": Number(row.amount || 0),
    "Portal Charge": Number(row.portal_charge || 0),
    "Total": Number(row.amount || 0) + Number(row.portal_charge || 0),
    "Payment Method": row.method || "",
    "Payment Date": csvDate(row.paid_at),
    "Invoice Created": csvDate(row.invoice_created_at),
  }));
}

async function loadExport(req, stage) {
  const config = reportConfig(stage);
  const sessions = await loadSessions();
  const defaultSessionId = await loadDefaultSessionId(sessions);
  const filters = readFilters(req, sessions, defaultSessionId);
  return { config, filters, rows: await loadRows(filters, config, { paginate: false }) };
}

async function exportXlsx(req, res, next, stage) {
  try {
    const { config, rows } = await loadExport(req, stage);
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows(rows));
    XLSX.utils.book_append_sheet(workbook, worksheet, config.stage === "ACCEPTANCE" ? "Acceptance Fees" : "Application Fees");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${config.stage.toLowerCase()}_fee_report.xlsx"`);
    res.send(buffer);
  } catch (error) { next(error); }
}

async function exportPdf(req, res, next, stage) {
  try {
    const { config, rows } = await loadExport(req, stage);
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${config.stage.toLowerCase()}_fee_report.pdf"`);
    doc.pipe(res);
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#247D57").text(config.title, { align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#555").text(`Generated ${new Date().toLocaleString("en-GB")} · ${rows.length} record(s)`, { align: "center" });
    doc.moveDown();
    const cols = [28,65,160,275,345,405,465,525,595,655,720];
    const widths = [35,92,112,68,58,58,58,68,58,62,70];
    const headers = ["#","Application","Applicant","Session","Programme","Status","Pay status","RRR","Amount","Charge","Paid date"];
    const drawHeader = y => { doc.rect(28,y,758,18).fill("#247D57"); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(7); headers.forEach((h,i)=>doc.text(h,cols[i],y+5,{width:widths[i],ellipsis:true})); };
    let y=95; drawHeader(y); y+=20;
    rows.forEach((row,index)=>{
      if(y>545){doc.addPage();y=35;drawHeader(y);y+=20;}
      if(index%2===0)doc.rect(28,y-2,758,18).fill("#f4f6f9");
      doc.fillColor("#222").font("Helvetica").fontSize(6.5);
      [index+1,row.application_number,row.applicant_name,row.session_name,row.programme_name,row.application_status,row.payment_status,row.rrr,Number(row.amount||0).toFixed(2),Number(row.portal_charge||0).toFixed(2),csvDate(row.paid_at)].forEach((v,i)=>doc.text(String(v??""),cols[i],y,{width:widths[i],ellipsis:true})); y+=18;
    });
    doc.end();
  } catch (error) { next(error); }
}

export function applicationFeesReport(
  req,
  res,
  next,
) {
  return reportPage(
    req,
    res,
    next,
    "APPLICATION",
  );
}

export function acceptanceFeesReport(
  req,
  res,
  next,
) {
  return reportPage(
    req,
    res,
    next,
    "ACCEPTANCE",
  );
}

export function exportApplicationFeesCsv(
  req,
  res,
  next,
) {
  return exportCsv(
    req,
    res,
    next,
    "APPLICATION",
  );
}

export function exportAcceptanceFeesCsv(
  req,
  res,
  next,
) {
  return exportCsv(
    req,
    res,
    next,
    "ACCEPTANCE",
  );
}

export const exportApplicationFeesXlsx = (req,res,next) => exportXlsx(req,res,next,"APPLICATION");
export const exportAcceptanceFeesXlsx = (req,res,next) => exportXlsx(req,res,next,"ACCEPTANCE");
export const exportApplicationFeesPdf = (req,res,next) => exportPdf(req,res,next,"APPLICATION");
export const exportAcceptanceFeesPdf = (req,res,next) => exportPdf(req,res,next,"ACCEPTANCE");
