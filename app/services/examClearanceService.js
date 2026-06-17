import crypto from "crypto";
import db from "../core/db.js";
import { listStudentScopedPaymentTypes } from "./studentPaymentScopeResolver.js";
import { listApplicableLatePaymentCharges } from "./latePaymentChargeService.js";

function clean(v) {
  return String(v ?? "").trim();
}

function money(v) {
  return Number(v || 0) || 0;
}

function normalizeSemester(v) {
  const raw = clean(v).toUpperCase();
  if (raw === "1" || raw.startsWith("FIRST")) return "FIRST";
  if (raw === "2" || raw.startsWith("SECOND")) return "SECOND";
  return raw;
}

function normalizeSession(v) {
  return clean(v).replace(/\s+/g, " ").toLowerCase();
}

function toBase64Url(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(str) {
  const b64 = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function secret() {
  return (
    process.env.EXAM_CLEARANCE_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.PASSWORD_ENCRYPTION_KEY ||
    "ijero-exam-clearance-secret"
  );
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function makeClearanceToken(payload) {
  const body = toBase64Url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyClearanceToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;

  const expected = sign(body);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    return JSON.parse(fromBase64Url(body));
  } catch {
    return null;
  }
}

function parseMeta(row) {
  try {
    return JSON.parse(row?.payment_meta || "{}");
  } catch {
    return {};
  }
}

function deepFind(obj, targetKey) {
  if (!obj || typeof obj !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(obj, targetKey)) {
    return clean(obj[targetKey]);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = deepFind(value, targetKey);
      if (found) return found;
    }
  }

  return "";
}

function hasSessionMeta(meta) {
  return Boolean(
    deepFind(meta, "session_id") ||
      deepFind(meta, "selected_session_id") ||
      deepFind(meta, "legacy_session") ||
      deepFind(meta, "session_name") ||
      deepFind(meta, "academic_session")
  );
}

function paymentMatchesSession(row, selectedSession, annualPaymentTypeIds) {
  const meta = parseMeta(row);

  const metaSessionId =
    Number(deepFind(meta, "session_id") || deepFind(meta, "selected_session_id") || 0) || null;

  if (metaSessionId) {
    return Number(metaSessionId) === Number(selectedSession.id);
  }

  const legacySession =
    deepFind(meta, "legacy_session") ||
    deepFind(meta, "session_name") ||
    deepFind(meta, "academic_session");

  if (legacySession) {
    return normalizeSession(legacySession) === normalizeSession(selectedSession.name);
  }

  // Older new-portal payments did not store session metadata.
  // Fallback: count successful payments whose payment type is part of the selected session's payable setup.
  // This keeps the feature working without counting failed/pending attempts.
  if (!hasSessionMeta(meta)) {
    return annualPaymentTypeIds.has(Number(row.payment_type_id));
  }

  return false;
}

function fullName(user, imp) {
  const fromUser = [user?.first_name, user?.middle_name, user?.last_name]
    .map(clean)
    .filter(Boolean)
    .join(" ");

  const fromImport = [imp?.first_name, imp?.middle_name, imp?.last_name]
    .map(clean)
    .filter(Boolean)
    .join(" ");

  return fromUser || fromImport || clean(user?.username);
}

async function loadStudent(studentId, publicUser = {}) {
  const [rows] = await db.query(
    `
      SELECT
        pu.*,
        sp.school_id,
        sp.department_id,
        sp.programme_id,
        sp.level AS profile_level,
        sp.phone AS profile_phone,
        sp.photo_path,
        sch.name AS school_name,
        d.name AS department_name,
        p.name AS programme_name
      FROM public_users pu
      LEFT JOIN student_profiles sp ON sp.user_id = pu.id
      LEFT JOIN schools sch ON sch.id = sp.school_id
      LEFT JOIN departments d ON d.id = sp.department_id
      LEFT JOIN programmes p ON p.id = sp.programme_id
      WHERE pu.id = ?
      LIMIT 1
    `,
    [studentId]
  );

  const user = rows?.[0] || publicUser || {};

  const [importRows] = await db.query(
    `
      SELECT *
      FROM student_imports
      WHERE matric_number = ?
         OR student_email = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [
      user?.matric_number || publicUser?.matric_number || "",
      user?.username || publicUser?.username || "",
    ]
  );

  const imp = importRows?.[0] || {};

  return {
    id: studentId,
    fullName: fullName(user, imp),
    firstName: clean(user?.first_name || imp?.first_name),
    middleName: clean(user?.middle_name || imp?.middle_name),
    lastName: clean(user?.last_name || imp?.last_name),
    matricNumber: clean(user?.matric_number || imp?.matric_number || user?.username),
    email: clean(user?.username || imp?.student_email),
    phone: clean(user?.profile_phone || user?.phone || imp?.phone),
    school: clean(user?.school_name || imp?.school),
    department: clean(user?.department_name || imp?.department),
    programme: clean(user?.programme_name || imp?.programme),
    level: clean(user?.profile_level || imp?.student_level || imp?.level),
  };
}

export async function listSessions() {
  const [rows] = await db.query(
    `SELECT id, name, is_current FROM sessions ORDER BY id DESC`
  );
  return rows || [];
}

export function requiredPercentForSemester(semester) {
  return normalizeSemester(semester) === "FIRST" ? 0.6 : 1;
}

async function resolveAnnualPayableRows({ studentId, publicUser, sessionId }) {
  const byId = new Map();

  for (const semesterKey of ["FIRST", "SECOND"]) {
    const resolved = await listStudentScopedPaymentTypes({
      studentId,
      publicUser,
      currentSessionId: sessionId,
      semesterKey,
    });

    for (const row of resolved.rows || []) {
      if (!byId.has(Number(row.id))) {
        byId.set(Number(row.id), {
          ...row,
          amount: money(row.amount),
          portal_charge: money(row.portal_charge),
        });
      }
    }
  }

  return Array.from(byId.values());
}

async function loadSessionPaymentTypeIds(sessionId) {
  const [rows] = await db.query(
    `
      SELECT DISTINCT payment_type_id
      FROM payment_type_sessions
      WHERE session_id = ?
    `,
    [sessionId]
  );

  return new Set((rows || []).map((r) => Number(r.payment_type_id)).filter(Boolean));
}

export async function buildClearanceData({
  req,
  sessionId,
  semester,
  includeToken = true,
}) {
  const publicUser = req.session?.publicUser || {};
  const studentId = Number(publicUser?.id || 0);

  if (!studentId) {
    throw new Error("Please login as a student.");
  }

  const normalizedSemester = normalizeSemester(semester);
  if (!sessionId || !["FIRST", "SECOND"].includes(normalizedSemester)) {
    throw new Error("Please select a valid session and semester.");
  }

  const [sessionRows] = await db.query(
    `SELECT id, name FROM sessions WHERE id = ? LIMIT 1`,
    [sessionId]
  );
  const selectedSession = sessionRows?.[0] || null;

  if (!selectedSession) {
    throw new Error("Selected session was not found.");
  }

  const student = await loadStudent(studentId, publicUser);

  const payableRows = await resolveAnnualPayableRows({
    studentId,
    publicUser,
    sessionId: selectedSession.id,
  });

  const lateCharges = await listApplicableLatePaymentCharges({
    studentId,
    publicUser,
    currentSessionId: selectedSession.id,
    semesterKey: normalizedSemester,
    payableRows,
  });

  for (const charge of lateCharges.rows || []) {
    payableRows.push({
      ...charge,
      amount: money(charge.amount),
      portal_charge: 0,
    });
  }

  const sessionPaymentTypeIds = await loadSessionPaymentTypeIds(selectedSession.id);

  const annualPaymentTypeIds = new Set([
    ...payableRows.map((row) => Number(row.id)).filter(Boolean),
    ...Array.from(sessionPaymentTypeIds),
  ]);

  const totalPayable = payableRows.reduce((sum, row) => sum + money(row.amount), 0);
  const requiredPercent = requiredPercentForSemester(normalizedSemester);
  const requiredAmount = Math.ceil(totalPayable * requiredPercent * 100) / 100;

  const identifiers = Array.from(
    new Set(
      [
        student.matricNumber,
        student.email,
        student.phone,
        publicUser?.matric_number,
        publicUser?.username,
        publicUser?.phone,
        String(studentId),
      ]
        .map(clean)
        .filter(Boolean)
    )
  );

  let rawPayments = [];
  if (identifiers.length) {
    const [rows] = await db.query(
      `
        SELECT
          inv.id,
          inv.order_id,
          inv.rrr,
          inv.payment_type_id,
          COALESCE(pt.name, inv.purpose, 'Payment') AS payment_type_name,
          inv.purpose,
          inv.amount,
          inv.status,
          inv.paid_at,
          inv.created_at,
          inv.payment_meta
        FROM payment_invoices inv
        LEFT JOIN payment_types pt ON pt.id = inv.payment_type_id
        WHERE inv.status = 'PAID'
          AND (
            inv.payee_id IN (?)
            OR inv.payee_email IN (?)
            OR inv.payee_phone IN (?)
          )
        ORDER BY COALESCE(inv.paid_at, inv.created_at) ASC, inv.id ASC
      `,
      [identifiers, identifiers, identifiers]
    );
    rawPayments = rows || [];
  }

  const successfulPayments = rawPayments
    .filter((row) => paymentMatchesSession(row, selectedSession, annualPaymentTypeIds))
    .map((row) => ({
      id: row.id,
      orderId: row.order_id,
      rrr: row.rrr || "",
      purpose: row.payment_type_name || row.purpose || "Payment",
      amount: money(row.amount),
      status: row.status,
      paidAt: row.paid_at || row.created_at,
    }));

  const totalPaid = successfulPayments.reduce((sum, row) => sum + money(row.amount), 0);
  const eligible = totalPayable > 0 && totalPaid >= requiredAmount;

  const generatedAt = new Date();

  const tokenPayload = {
    kind: "EXAM_CLEARANCE",
    studentId,
    matricNumber: student.matricNumber,
    studentName: student.fullName,
    sessionId: selectedSession.id,
    sessionName: selectedSession.name,
    semester: normalizedSemester,
    totalPayable,
    totalPaid,
    requiredAmount,
    eligible,
    generatedAt: generatedAt.toISOString(),
  };

  const token = includeToken ? makeClearanceToken(tokenPayload) : "";
  const protocol = req.get?.("x-forwarded-proto") || req.protocol || "https";
  const host = req.get?.("host") || "";
  const verifyUrl = token ? `${protocol}://${host}/verify/exam-clearance/${token}` : "";

  return {
    student,
    session: selectedSession,
    semester: normalizedSemester,
    payableRows,
    successfulPayments,
    totalPayable,
    totalPaid,
    requiredPercent,
    requiredAmount,
    eligible,
    generatedAt,
    token,
    verifyUrl,
  };
}

export function formatNaira(v) {
  const n = money(v);
  return `₦${n.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(v) {
  if (!v) return "";
  return new Date(v).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}
