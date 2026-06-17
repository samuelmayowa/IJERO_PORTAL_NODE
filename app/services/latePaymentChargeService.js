import db from "../core/db.js";
import { resolveStudentPaymentContext } from "./studentPaymentScopeResolver.js";

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSemester(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || raw === "0" || raw === "ALL") return "ALL";
  if (raw === "1" || raw.startsWith("FIRST")) return "FIRST";
  if (raw === "2" || raw.startsWith("SECOND")) return "SECOND";
  return raw;
}

function parsePaymentTypeIds(value) {
  return String(value || "")
    .split(",")
    .map((v) => Number(v))
    .filter(Boolean);
}

function scopeMatches(rule, ctx) {
  const scope = String(rule.scope_type || "ALL").trim().toUpperCase();

  if (scope === "ALL") return true;

  if (scope === "SCHOOL") {
    return Number(rule.school_id || 0) === Number(ctx.schoolId || 0);
  }

  if (scope === "DEPARTMENT") {
    return Number(rule.department_id || 0) === Number(ctx.departmentId || 0);
  }

  if (scope === "PROGRAMME") {
    return Number(rule.programme_id || 0) === Number(ctx.programmeId || 0);
  }

  return false;
}

async function getPaymentInvoiceColumns() {
  const [cols] = await db.query(`SHOW COLUMNS FROM payment_invoices`);
  return new Set((cols || []).map((c) => c.Field));
}

async function sumPaidBeforeDeadline({
  studentId,
  publicUser = null,
  paymentTypeIds = [],
  deadlineAt,
}) {
  const ids = Array.from(new Set(paymentTypeIds.map(Number).filter(Boolean)));
  if (!ids.length || !deadlineAt) return 0;

  const cols = await getPaymentInvoiceColumns();

  const identityParts = [];
  const identityParams = [];

  if (cols.has("student_id")) {
    identityParts.push("student_id = ?");
    identityParams.push(studentId);
  }

  if (cols.has("public_user_id")) {
    identityParts.push("public_user_id = ?");
    identityParams.push(studentId);
  }

  if (cols.has("payee_email") && publicUser?.username) {
    identityParts.push("payee_email = ?");
    identityParams.push(publicUser.username);
  }

  if (cols.has("email") && publicUser?.username) {
    identityParts.push("email = ?");
    identityParams.push(publicUser.username);
  }

  if (cols.has("matric_number") && publicUser?.matric_number) {
    identityParts.push("matric_number = ?");
    identityParams.push(publicUser.matric_number);
  }

  if (cols.has("payee_phone") && publicUser?.phone) {
    identityParts.push("payee_phone = ?");
    identityParams.push(publicUser.phone);
  }

  if (cols.has("phone") && publicUser?.phone) {
    identityParts.push("phone = ?");
    identityParams.push(publicUser.phone);
  }

  if (!identityParts.length) return 0;

  const dateExpr = cols.has("paid_at")
    ? "COALESCE(paid_at, created_at)"
    : "created_at";

  const [rows] = await db.query(
    `
      SELECT COALESCE(SUM(amount), 0) AS total_paid
      FROM payment_invoices
      WHERE payment_type_id IN (${ids.map(() => "?").join(",")})
        AND status = 'PAID'
        AND ${dateExpr} <= ?
        AND (${identityParts.join(" OR ")})
    `,
    [...ids, deadlineAt, ...identityParams],
  );

  return money(rows?.[0]?.total_paid || 0);
}

export async function listApplicableLatePaymentCharges({
  studentId,
  publicUser = null,
  currentSessionId = null,
  semesterKey = null,
  payableRows = [],
}) {
  const payablePaymentTypeIds = new Set(
    (payableRows || [])
      .map((row) => Number(row.id || row.payment_type_id || 0))
      .filter(Boolean),
  );

  if (!studentId || !currentSessionId || !semesterKey || !payablePaymentTypeIds.size) {
    return { context: null, rows: [], total: 0 };
  }

  const normalizedSemester = normalizeSemester(semesterKey);

  const ctx = await resolveStudentPaymentContext({
    studentId,
    publicUser,
    currentSessionId,
    semesterKey: normalizedSemester,
  });

  const [rules] = await db.query(
    `
      SELECT
        r.*,
        GROUP_CONCAT(rpt.payment_type_id ORDER BY rpt.payment_type_id) AS payment_type_ids
      FROM tuition_late_fee_rules r
      INNER JOIN tuition_late_fee_rule_payment_types rpt
        ON rpt.rule_id = r.id
      WHERE r.is_active = 1
        AND r.session_id = ?
        AND r.deadline_at <= NOW()
        AND (
          UPPER(r.semester) = 'ALL'
          OR UPPER(r.semester) = ?
        )
      GROUP BY r.id
      ORDER BY r.id ASC
    `,
    [currentSessionId, normalizedSemester],
  );

  const rows = [];

  for (const rule of rules || []) {
    if (!scopeMatches(rule, ctx)) continue;

    const selectedPaymentTypeIds = parsePaymentTypeIds(rule.payment_type_ids);
    const matchedPaymentTypeIds = selectedPaymentTypeIds.filter((id) =>
      payablePaymentTypeIds.has(Number(id)),
    );

    if (!matchedPaymentTypeIds.length) continue;

    const normalAffectedAmount = (payableRows || [])
      .filter((row) => matchedPaymentTypeIds.includes(Number(row.id || row.payment_type_id || 0)))
      .reduce((sum, row) => sum + money(row.amount), 0);

    if (normalAffectedAmount <= 0) continue;

    const paidBeforeDeadline = await sumPaidBeforeDeadline({
      studentId,
      publicUser,
      paymentTypeIds: selectedPaymentTypeIds,
      deadlineAt: rule.deadline_at,
    });

    // If the student had already completed the normal affected payment before the deadline,
    // the late charge must not apply.
    if (paidBeforeDeadline >= normalAffectedAmount) continue;

    const amount = money(rule.amount);
    if (amount <= 0) continue;

    rows.push({
      id: `late_fee_${rule.id}`,
      payment_type_id: null,
      name: "Late Payment Charge",
      purpose: rule.title,
      amount,
      portal_charge: 0,
      category: "school",
      is_late_payment_charge: true,
      late_fee_rule_id: Number(rule.id),
      affected_payment_type_ids: matchedPaymentTypeIds,
      deadline_at: rule.deadline_at,
      semester: rule.semester,
      notice_message: rule.notice_message || "",
    });
  }

  return {
    context: ctx,
    rows,
    total: rows.reduce((sum, row) => sum + money(row.amount), 0),
  };
}
