import QRCode from "qrcode";
import { pool } from "../core/db.js";

export const ADMIN_ID_CARD_ROLES = Object.freeze(["admin", "administrator", "superadmin", "adminict"]);

const SCHOOL_NAME = process.env.STUDENT_ID_SCHOOL_NAME || "Ekiti State College of Technology, Ijero-Ekiti";
const SCHOOL_ADDRESS = process.env.STUDENT_ID_SCHOOL_ADDRESS || "Ijero-Ekiti, Ekiti State, Nigeria";

function clean(value) {
  return String(value ?? "").trim();
}

export function safeFilenamePart(value) {
  return clean(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "student";
}

export function normaliseCardStatus(publicStatus, academicStatus, enabled = true) {
  if (!enabled) return "INACTIVE";
  const publicActive = clean(publicStatus).toUpperCase() === "ACTIVE";
  const academicActive = clean(academicStatus).toUpperCase() === "ACTIVE";
  return publicActive && academicActive ? "ACTIVE" : "INACTIVE";
}

export function institutionDetails() {
  return { schoolName: SCHOOL_NAME, schoolAddress: SCHOOL_ADDRESS };
}

export async function ensureStudentCards(executor = pool) {
  await executor.query(
    `INSERT IGNORE INTO student_id_cards (public_user_id, public_code)
     SELECT pu.id, LOWER(REPLACE(UUID(), '-', ''))
       FROM public_users pu
      WHERE pu.role='student'
         OR EXISTS (SELECT 1 FROM portal_user_roles pur WHERE pur.public_user_id=pu.id AND pur.role='student')`,
  );
}

const cardStatusSql = `CASE
  WHEN sic.is_enabled=1
   AND UPPER(COALESCE(pu.status,''))='ACTIVE'
   AND UPPER(COALESCE(sp.academic_status,''))='ACTIVE'
  THEN 'ACTIVE' ELSE 'INACTIVE' END`;

const studentFrom = `
    FROM public_users pu
    JOIN student_id_cards sic ON sic.public_user_id=pu.id
    LEFT JOIN student_profiles sp ON sp.user_id=pu.id
    LEFT JOIN schools s ON s.id=sp.school_id
    LEFT JOIN departments d ON d.id=sp.department_id
    LEFT JOIN programmes p ON p.id=sp.programme_id
    LEFT JOIN student_imports si ON si.id=COALESCE(
      (SELECT MAX(si2.id) FROM student_imports si2 WHERE si2.matric_number=pu.matric_number),
      (SELECT MAX(si3.id) FROM student_imports si3 WHERE si3.student_email=pu.username)
    )`;

const studentSelect = `
  SELECT pu.id public_user_id,pu.first_name,pu.middle_name,pu.last_name,
         pu.matric_number,pu.username email,pu.status public_status,
         sp.photo_path,sp.level,sp.academic_status,
         s.name school_name,d.name department_name,p.name programme_name,
         COALESCE(NULLIF(si.year_of_entry,''),'') year_of_entry,
         COALESCE(NULLIF(sp.level,''),NULLIF(si.student_level,''),'') effective_level,
         COALESCE(NULLIF(s.name,''),NULLIF(si.school,''),'') effective_school,
         COALESCE(NULLIF(d.name,''),NULLIF(si.department,''),'') effective_department,
         COALESCE(NULLIF(p.name,''),NULLIF(si.programme,''),'') effective_programme,
         sic.public_code,sic.is_enabled,sic.created_at card_created_at,
         ${cardStatusSql} card_status
    ${studentFrom}`;

function mapStudent(row) {
  if (!row) return null;
  return {
    ...row,
    full_name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
    school: row.effective_school || "Not recorded",
    department: row.effective_department || "Not recorded",
    programme: row.effective_programme || "Not recorded",
    level: row.effective_level || "Not recorded",
    year_of_entry: row.year_of_entry || "Not recorded",
    card_status: row.card_status || normaliseCardStatus(row.public_status, row.academic_status, Boolean(row.is_enabled)),
  };
}

export async function listStudentCards({ search = "", status = "", limit = 100, offset = 0 } = {}) {
  await ensureStudentCards();
  const where = [`(pu.role='student' OR EXISTS (SELECT 1 FROM portal_user_roles pur WHERE pur.public_user_id=pu.id AND pur.role='student'))`];
  const params = [];
  const q = clean(search);
  if (q) {
    where.push(`(pu.matric_number LIKE ? OR pu.username LIKE ? OR CONCAT_WS(' ',pu.first_name,pu.middle_name,pu.last_name) LIKE ?)`);
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern);
  }
  const wanted = clean(status).toUpperCase();
  if (["ACTIVE", "INACTIVE"].includes(wanted)) {
    where.push(`${cardStatusSql}=?`);
    params.push(wanted);
  }
  const whereSql = where.join(" AND ");
  const boundedLimit = limit == null ? null : Math.min(Math.max(Number(limit) || 50, 1), 500);
  const boundedOffset = Math.max(Number(offset) || 0, 0);
  const pageSql = boundedLimit == null ? "" : " LIMIT ? OFFSET ?";
  const pageParams = boundedLimit == null ? params : [...params, boundedLimit, boundedOffset];
  const [[countRows], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) total
      FROM public_users pu
      JOIN student_id_cards sic ON sic.public_user_id=pu.id
      LEFT JOIN student_profiles sp ON sp.user_id=pu.id
      WHERE ${whereSql}`, params),
    pool.query(`${studentSelect} WHERE ${whereSql} ORDER BY pu.last_name,pu.first_name,pu.id${pageSql}`, pageParams),
  ]);
  const mapped = rows.map(mapStudent);
  return { rows: mapped, total: Number(countRows[0]?.total || 0), allRows: boundedLimit == null ? mapped : [] };
}

export async function getStudentCardById(id) {
  await ensureStudentCards();
  const [[row]] = await pool.query(`${studentSelect} WHERE pu.id=? LIMIT 1`, [Number(id)]);
  return mapStudent(row);
}

export async function getStudentCardByCode(code) {
  if (!/^[a-f0-9]{32}$/i.test(clean(code))) return null;
  const [[row]] = await pool.query(`${studentSelect} WHERE sic.public_code=? AND sic.is_enabled=1 LIMIT 1`, [clean(code).toLowerCase()]);
  return mapStudent(row);
}

export function publicBaseUrl(req) {
  const configured = clean(process.env.STUDENT_ID_PUBLIC_BASE_URL).replace(/\/+$/, "");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("STUDENT_ID_PUBLIC_BASE_URL must use HTTPS in production.");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("STUDENT_ID_PUBLIC_BASE_URL is invalid.");
    return url.origin + url.pathname.replace(/\/+$/, "");
  }
  if (process.env.NODE_ENV === "production") throw new Error("STUDENT_ID_PUBLIC_BASE_URL must be configured in production.");
  const forwarded = clean(req.get?.("x-forwarded-proto")).split(",")[0];
  const protocol = ["http", "https"].includes(forwarded) ? forwarded : (req.protocol || "http");
  return `${protocol}://${req.get("host")}`;
}

export function verificationUrl(req, publicCode) {
  return `${publicBaseUrl(req)}/verify/student/${encodeURIComponent(publicCode)}`;
}

export async function cardQrDataUrl(url) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "H", margin: 2, width: 360, color: { dark: "#102a22", light: "#ffffff" } });
}

function escapeXml(value) {
  return clean(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[char]);
}

export function labelledQrSvg(url, matricNumber) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "H" });
  const count = qr.modules.size;
  const quiet = 4;
  const unit = 10;
  const qrSize = (count + quiet * 2) * unit;
  const labelHeight = 64;
  let modules = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.modules.get(row, col)) modules += `<rect x="${(col + quiet) * unit}" y="${(row + quiet) * unit}" width="${unit}" height="${unit}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${qrSize}" height="${qrSize + labelHeight}" viewBox="0 0 ${qrSize} ${qrSize + labelHeight}"><rect width="100%" height="100%" fill="#fff"/><g fill="#102a22">${modules}</g><text x="50%" y="${qrSize + 39}" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#102a22">${escapeXml(matricNumber || "NO MATRIC NUMBER")}</text></svg>`;
}

export function exportRows(req, rows) {
  return rows.map((row, index) => ({
    "S/N": index + 1,
    "Matric Number": row.matric_number || "",
    "Full Name": row.full_name,
    School: row.school,
    Department: row.department,
    Programme: row.programme,
    Level: row.level,
    "Year of Entry": row.year_of_entry,
    Status: row.card_status,
    "Verification URL": verificationUrl(req, row.public_code),
    "QR Code Filename": `IDCARD_${safeFilenamePart(row.matric_number)}_QR.svg`,
  }));
}
