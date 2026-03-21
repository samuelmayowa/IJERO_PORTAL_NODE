// app/web/controllers/staffVacancyReport.controller.js
import fs from "fs";
import path from "path";
import { pool } from "../../core/db.js";

const PAGE_SIZE = 20;
const SAFE_UPLOAD_ROOT = path.resolve("app/uploads/vacancies");

function clean(value) {
  return String(value ?? "").trim();
}

function toPositiveInt(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function parseCertificates(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function applicantName(row) {
  return [row.first_name, row.middle_name, row.last_name]
    .filter(Boolean)
    .join(" ");
}

function buildFilters(query = {}) {
  return {
    from: clean(query.from),
    to: clean(query.to),
    status: clean(query.status),
    post: clean(query.post),
    q: clean(query.q),
    page: toPositiveInt(query.page, 1),
  };
}

function buildQueryString(filters, page = null) {
  const p = new URLSearchParams();

  ["from", "to", "status", "post", "q"].forEach((key) => {
    if (filters[key]) p.set(key, filters[key]);
  });

  if (page != null) p.set("page", String(page));
  return p.toString();
}

function buildWhere(filters) {
  const where = [];
  const params = [];

  if (filters.from) {
    where.push("DATE(created_at) >= ?");
    params.push(filters.from);
  }

  if (filters.to) {
    where.push("DATE(created_at) <= ?");
    params.push(filters.to);
  }

  if (filters.status) {
    where.push("LOWER(status) = ?");
    params.push(filters.status.toLowerCase());
  }

  if (filters.post) {
    where.push("post_applying_for LIKE ?");
    params.push(`%${filters.post}%`);
  }

  if (filters.q) {
    where.push(`
      (
        reference_no LIKE ?
        OR first_name LIKE ?
        OR middle_name LIKE ?
        OR last_name LIKE ?
        OR email LIKE ?
        OR phone LIKE ?
        OR alternative_phone LIKE ?
      )
    `);

    const like = `%${filters.q}%`;
    params.push(like, like, like, like, like, like, like);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

async function fetchReport(filters, options = {}) {
  const all = Boolean(options.all);
  const { whereSql, params } = buildWhere(filters);

  const [summaryRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN LOWER(status) = 'submitted' THEN 1 ELSE 0 END) AS submitted_count,
        SUM(CASE WHEN cv_path IS NOT NULL AND cv_path <> '' THEN 1 ELSE 0 END) AS with_cv_count,
        SUM(
          CASE
            WHEN certificates_json IS NOT NULL
             AND certificates_json <> ''
             AND certificates_json <> '[]'
            THEN 1 ELSE 0
          END
        ) AS with_certificates_count
      FROM job_applications
      ${whereSql}
    `,
    params,
  );

  const total = Number(summaryRows?.[0]?.total || 0);
  const page = toPositiveInt(filters.page, 1);
  const offset = (page - 1) * PAGE_SIZE;

  let sql = `
    SELECT *
    FROM job_applications
    ${whereSql}
    ORDER BY created_at DESC, id DESC
  `;

  const dataParams = [...params];

  if (!all) {
    sql += " LIMIT ? OFFSET ?";
    dataParams.push(PAGE_SIZE, offset);
  }

  const [rows] = await pool.query(sql, dataParams);

  const items = (rows || []).map((row) => {
    const certificates = parseCertificates(row.certificates_json);

    return {
      ...row,
      applicant_name: applicantName(row),
      certificates,
      certificate_count: certificates.length,
    };
  });

  return {
    rows: items,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: {
      total,
      submitted: Number(summaryRows?.[0]?.submitted_count || 0),
      withCv: Number(summaryRows?.[0]?.with_cv_count || 0),
      withCertificates: Number(summaryRows?.[0]?.with_certificates_count || 0),
    },
  };
}

function getSafeAbsolutePath(storedPath) {
  if (!storedPath) return null;

  const absolute = path.resolve(storedPath);
  const rootWithSep = `${SAFE_UPLOAD_ROOT}${path.sep}`;

  if (absolute !== SAFE_UPLOAD_ROOT && !absolute.startsWith(rootWithSep)) {
    return null;
  }

  return absolute;
}

function resolveDownloadTarget(row, kind, index = 0) {
  const normalizedKind = String(kind || "").toLowerCase();

  if (normalizedKind === "cv") {
    const ext = path.extname(row.cv_path || "") || "";
    return {
      storedPath: row.cv_path,
      downloadName: `${row.reference_no || "application"}-cv${ext}`,
    };
  }

  if (normalizedKind === "supporting") {
    const ext = path.extname(row.supporting_document_path || "") || "";
    return {
      storedPath: row.supporting_document_path,
      downloadName: `${row.reference_no || "application"}-supporting${ext}`,
    };
  }

  if (normalizedKind === "certificate") {
    const certificates = parseCertificates(row.certificates_json);
    const cert = certificates[index];

    if (!cert) return null;

    const ext = path.extname(cert.path || cert.original_name || "") || "";
    return {
      storedPath: cert.path,
      downloadName:
        cert.original_name ||
        `${row.reference_no || "application"}-certificate-${index + 1}${ext}`,
    };
  }

  return null;
}

export async function index(req, res, next) {
  try {
    const filters = buildFilters(req.query);
    const report = await fetchReport(filters);

    const baseQuery = buildQueryString(filters);

    return res.render("pages/staff/vacancy-report", {
      title: "Vacancy Applications Report",
      pageTitle: "Vacancy Applications Report",
      filters,
      rows: report.rows,
      summary: report.summary,
      pagination: {
        page: report.page,
        pageSize: report.pageSize,
        total: report.total,
        totalPages: report.totalPages,
        queryBase: buildQueryString(filters, null),
      },
      exportCsvUrl: `/staff/vacancies/report/export.csv${
        baseQuery ? `?${baseQuery}` : ""
      }`,
    });
  } catch (error) {
    next(error);
  }
}

export async function exportCsv(req, res, next) {
  try {
    const filters = buildFilters(req.query);
    const report = await fetchReport(filters, { all: true });
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const header = [
      "Submission Date",
      "Reference No",
      "Applicant Name",
      "Post Applying For",
      "Email",
      "Phone",
      "Alternative Phone",
      "Date of Birth",
      "Gender",
      "State of Origin",
      "Local Government",
      "House Address",
      "Status",
      "CV Download URL",
      "Supporting Document URL",
      "Certificate Download URLs",
    ];

    const lines = [header.map(escapeCsv).join(",")];

    for (const row of report.rows) {
      const cvUrl = row.cv_path
        ? `${baseUrl}/staff/vacancies/report/file/${row.id}/cv`
        : "";

      const supportingUrl = row.supporting_document_path
        ? `${baseUrl}/staff/vacancies/report/file/${row.id}/supporting`
        : "";

      const certificateUrls = (row.certificates || [])
        .map(
          (_cert, idx) =>
            `${baseUrl}/staff/vacancies/report/file/${row.id}/certificate?index=${idx}`,
        )
        .join(" | ");

      lines.push(
        [
          row.created_at,
          row.reference_no,
          row.applicant_name,
          row.post_applying_for,
          row.email,
          row.phone,
          row.alternative_phone,
          row.date_of_birth,
          row.gender,
          row.state_of_origin,
          row.local_government,
          row.house_address,
          row.status,
          cvUrl,
          supportingUrl,
          certificateUrls,
        ]
          .map(escapeCsv)
          .join(","),
      );
    }

    const filename = `vacancy-applications-${Date.now()}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(lines.join("\n"));
  } catch (error) {
    next(error);
  }
}

export async function downloadFile(req, res, next) {
  try {
    const id = Number(req.params.id);
    const kind = clean(req.params.kind).toLowerCase();
    const index = Math.max(0, Number(req.query.index || 0));

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).send("Invalid application id.");
    }

    const [rows] = await pool.query(
      `
        SELECT
          id,
          reference_no,
          cv_path,
          supporting_document_path,
          certificates_json
        FROM job_applications
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );

    const row = rows?.[0];
    if (!row) {
      return res.status(404).send("Application record not found.");
    }

    const target = resolveDownloadTarget(row, kind, index);
    if (!target?.storedPath) {
      return res
        .status(404)
        .send("Requested file was not found for this application.");
    }

    const absolutePath = getSafeAbsolutePath(target.storedPath);
    if (!absolutePath) {
      return res.status(403).send("Access to this file is not allowed.");
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).send("Physical file not found on disk.");
    }

    return res.download(absolutePath, target.downloadName);
  } catch (error) {
    next(error);
  }
}
