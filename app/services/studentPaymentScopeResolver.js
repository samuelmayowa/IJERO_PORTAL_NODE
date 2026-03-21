// app/services/studentPaymentScopeResolver.js
import db from "../core/db.js";

function toRows(x) {
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

function normName(v) {
  return String(v || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniqInts(values) {
  return Array.from(
    new Set((values || []).map((v) => Number(v)).filter(Boolean)),
  );
}

function normalizeSemesterName(name) {
  const raw = String(name || "")
    .trim()
    .toUpperCase();
  if (!raw || raw === "0" || raw === "ALL") return "ALL";
  if (raw === "1" || raw === "FIRST") return "FIRST";
  if (raw === "2" || raw === "SECOND") return "SECOND";
  return raw;
}

function mapSemesterNameToKey(semesterName) {
  const n = String(semesterName || "")
    .trim()
    .toLowerCase();
  if (n.startsWith("first")) return "FIRST";
  if (n.startsWith("second")) return "SECOND";
  if (n.startsWith("summer")) return "SUMMER";
  return String(semesterName || "")
    .trim()
    .toUpperCase();
}

function semesterMatches(storedSemester, currentSemesterKey) {
  const stored = normalizeSemesterName(storedSemester);
  const current = normalizeSemesterName(currentSemesterKey);

  if (stored === "ALL") return true;
  return stored === current;
}

function normalizeLevelToken(v) {
  return String(v || "")
    .replace(/\s+/g, "")
    .replace(/LEVEL/gi, "")
    .trim()
    .toUpperCase();
}

function buildLevelAliases(raw) {
  const v = normalizeLevelToken(raw);
  const set = new Set();
  if (!v) return [];

  set.add(v);

  const pairs = {
    100: ["ND1"],
    200: ["ND2"],
    300: ["ND3", "HND1"],
    400: ["HND2"],
    500: ["HND3"],
    600: [],
    ND1: ["100"],
    ND2: ["200"],
    ND3: ["300"],
    HND1: ["300"],
    HND2: ["400"],
    HND3: ["500"],
  };

  (pairs[v] || []).forEach((x) => set.add(x));
  return Array.from(set);
}

async function getCurrentSessionAndSemester() {
  const [sessRows] = await db.query(
    `SELECT id, name FROM sessions WHERE is_current = 1 LIMIT 1`,
  );
  const [semRows] = await db.query(
    `SELECT id, name FROM semesters WHERE is_current = 1 LIMIT 1`,
  );

  const currentSession = sessRows?.[0] || null;
  const currentSemester = semRows?.[0] || null;

  return {
    currentSessionId: currentSession?.id || null,
    semesterKey: mapSemesterNameToKey(currentSemester?.name),
  };
}

async function findSchoolIdByName(name) {
  const clean = normName(name);
  if (!clean) return null;

  const q = await db.query(
    `SELECT id
     FROM schools
     WHERE LOWER(TRIM(name)) = ?
     LIMIT 1`,
    [clean],
  );
  return Number(toRows(q)?.[0]?.id || 0) || null;
}

async function findDepartmentIdByName(name, schoolId = null) {
  const clean = normName(name);
  if (!clean) return null;

  const params = [clean];
  let sql = `
    SELECT id
    FROM departments
    WHERE LOWER(TRIM(name)) = ?
  `;

  if (schoolId) {
    sql += ` AND school_id = ?`;
    params.push(Number(schoolId));
  }

  sql += ` LIMIT 1`;

  const q = await db.query(sql, params);
  return Number(toRows(q)?.[0]?.id || 0) || null;
}

async function findProgrammeIdByName(
  name,
  departmentId = null,
  schoolId = null,
) {
  const clean = normName(name);
  if (!clean) return null;

  const params = [clean];
  let sql = `
    SELECT id
    FROM programmes
    WHERE LOWER(TRIM(name)) = ?
  `;

  if (departmentId) {
    sql += ` AND department_id = ?`;
    params.push(Number(departmentId));
  } else if (schoolId) {
    sql += ` AND school_id = ?`;
    params.push(Number(schoolId));
  }

  sql += ` LIMIT 1`;

  const q = await db.query(sql, params);
  return Number(toRows(q)?.[0]?.id || 0) || null;
}

async function resolveAdmissionSessionId(yearOfEntry) {
  const year = String(yearOfEntry || "").trim();
  if (!year) return null;

  const q = await db.query(
    `
      SELECT id
      FROM sessions
      WHERE name LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [`${year}%`],
  );

  return Number(toRows(q)?.[0]?.id || 0) || null;
}

export async function resolveStudentPaymentContext({
  studentId,
  publicUser = null,
  currentSessionId = null,
  semesterKey = null,
}) {
  const current =
    !currentSessionId || !semesterKey
      ? await getCurrentSessionAndSemester()
      : null;

  const effectiveCurrentSessionId =
    currentSessionId || current?.currentSessionId || null;
  const effectiveSemesterKey = semesterKey || current?.semesterKey || null;

  const [profileRows] = await db.query(
    `
      SELECT
        pu.id,
        pu.username,
        pu.matric_number,
        pu.phone AS public_phone,
        pu.state_of_origin,
        sp.school_id,
        sp.department_id,
        sp.programme_id,
        sp.level,
        sp.phone AS profile_phone
      FROM public_users pu
      LEFT JOIN student_profiles sp
        ON sp.user_id = pu.id
      WHERE pu.id = ?
      LIMIT 1
    `,
    [studentId],
  );

  const profile = profileRows?.[0] || null;

  const [importRows] = await db.query(
    `
      SELECT
        school,
        department,
        programme,
        year_of_entry,
        student_level,
        level
      FROM student_imports
      WHERE matric_number = ?
         OR student_email = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [
      profile?.matric_number || publicUser?.matric_number || "",
      profile?.username || publicUser?.username || "",
    ],
  );

  const imp = importRows?.[0] || null;

  let schoolId = Number(profile?.school_id || 0) || null;
  if (!schoolId) {
    schoolId = await findSchoolIdByName(imp?.school || "");
  }

  let departmentId = Number(profile?.department_id || 0) || null;
  if (!departmentId) {
    departmentId = await findDepartmentIdByName(
      imp?.department || "",
      schoolId,
    );
  }

  let programmeId = Number(profile?.programme_id || 0) || null;
  if (!programmeId) {
    programmeId = await findProgrammeIdByName(
      imp?.programme || "",
      departmentId,
      schoolId,
    );
  }

  const rawLevel = profile?.level || imp?.student_level || imp?.level || "";

  const levelAliases = buildLevelAliases(rawLevel);

  const admissionSessionId = await resolveAdmissionSessionId(
    imp?.year_of_entry || "",
  );

  const stateOfOrigin =
    profile?.state_of_origin || publicUser?.state_of_origin || "";

  const isIndigene = normName(stateOfOrigin) === "ekiti";

  return {
    studentId,
    username: profile?.username || publicUser?.username || "",
    matric_number: profile?.matric_number || publicUser?.matric_number || "",
    phone:
      profile?.profile_phone ||
      profile?.public_phone ||
      publicUser?.phone ||
      "",
    stateOfOrigin,
    isIndigene,
    schoolId,
    departmentId,
    programmeId,
    rawLevel,
    levelAliases,
    admissionSessionId,
    currentSessionId: effectiveCurrentSessionId,
    semesterKey: effectiveSemesterKey,
  };
}

function groupScopedRows(rows) {
  const grouped = new Map();

  for (const row of rows || []) {
    if (!grouped.has(row.id)) {
      grouped.set(row.id, {
        base: row,
        schoolIds: new Set(),
        departmentIds: new Set(),
        programmeIds: new Set(),
        sessionRows: [],
        rules: [],
      });
    }

    const item = grouped.get(row.id);

    if (row.scoped_school_id != null) {
      item.schoolIds.add(Number(row.scoped_school_id));
    }

    if (row.scoped_department_id != null) {
      item.departmentIds.add(Number(row.scoped_department_id));
    }

    if (row.scoped_programme_id != null) {
      item.programmeIds.add(Number(row.scoped_programme_id));
    }

    if (row.scoped_session_id != null) {
      const key = `${row.scoped_session_id}::${normalizeSemesterName(row.scoped_semester)}`;
      if (!item.sessionRows.some((x) => x.key === key)) {
        item.sessionRows.push({
          key,
          session_id: Number(row.scoped_session_id),
          semester: normalizeSemesterName(row.scoped_semester),
        });
      }
    }

    const hasRule =
      row.entry_level != null ||
      row.current_level != null ||
      row.admission_session_id != null ||
      row.amount_override != null;

    if (hasRule) {
      const key = JSON.stringify({
        entry_level: row.entry_level ?? null,
        current_level: row.current_level ?? null,
        admission_session_id: row.admission_session_id ?? null,
        amount_override: row.amount_override ?? null,
      });

      if (!item.rules.some((r) => r.__key === key)) {
        item.rules.push({
          __key: key,
          entry_level: row.entry_level ?? null,
          current_level: row.current_level ?? null,
          admission_session_id: row.admission_session_id ?? null,
          amount_override: row.amount_override ?? null,
        });
      }
    }
  }

  return Array.from(grouped.values());
}

function matchesScopedFilters(item, ctx) {
  if (item.sessionRows.length) {
    const sessionOk = item.sessionRows.some((s) => {
      return (
        Number(s.session_id) === Number(ctx.currentSessionId || 0) &&
        semesterMatches(s.semester, ctx.semesterKey)
      );
    });

    if (!sessionOk) return false;
  }

  const scope = String(item.base.scope || "GENERAL")
    .trim()
    .toUpperCase();
  const isGeneral = scope === "GENERAL";

  if (isGeneral) {
    return false;
  }

  const schoolIds = Array.from(item.schoolIds);
  const departmentIds = Array.from(item.departmentIds);
  const programmeIds = Array.from(item.programmeIds);

  if (schoolIds.length && !schoolIds.includes(Number(ctx.schoolId || 0))) {
    return false;
  }

  if (
    departmentIds.length &&
    !departmentIds.includes(Number(ctx.departmentId || 0))
  ) {
    return false;
  }

  if (
    programmeIds.length &&
    !programmeIds.includes(Number(ctx.programmeId || 0))
  ) {
    return false;
  }

  return true;
}

function matchesRule(rule, ctx) {
  const entryLevel = normalizeLevelToken(rule.entry_level || "");
  const currentLevel = normalizeLevelToken(rule.current_level || "");
  const ruleAdmissionSessionId = Number(rule.admission_session_id || 0) || null;

  const entryOk = !entryLevel || ctx.levelAliases.includes(entryLevel);

  const currentOk = !currentLevel || ctx.levelAliases.includes(currentLevel);

  const admissionOk =
    !ruleAdmissionSessionId ||
    Number(ctx.admissionSessionId || 0) === ruleAdmissionSessionId;

  return entryOk && currentOk && admissionOk;
}

function pickResolvedAmounts(base, matchedRule, ctx) {
  let amount = Number(base.amount || 0) || 0;
  let portalCharge = Number(base.portal_charge || 0) || 0;
  let serviceTypeId = String(base.remita_service_type_id || "").trim() || null;
  let feeRegime = "BASE";

  if (Number(base.uses_indigene_regime || 0)) {
    const useIndigene = !!ctx.isIndigene;
    feeRegime = useIndigene ? "INDIGENE" : "NON_INDIGENE";

    amount = useIndigene
      ? Number(base.amount_indigene ?? 0) || 0
      : Number(base.amount_non_indigene ?? 0) || 0;

    portalCharge = useIndigene
      ? Number(base.portal_charge_indigene ?? 0) || 0
      : Number(base.portal_charge_non_indigene ?? 0) || 0;

    serviceTypeId =
      (useIndigene
        ? String(base.remita_service_type_id_indigene || "").trim()
        : String(base.remita_service_type_id_non_indigene || "").trim()) ||
      String(base.remita_service_type_id || "").trim() ||
      null;
  }

  if (
    matchedRule &&
    matchedRule.amount_override != null &&
    matchedRule.amount_override !== ""
  ) {
    amount = Number(matchedRule.amount_override) || 0;
  }

  return {
    amount,
    portal_charge: portalCharge,
    remita_service_type_id: serviceTypeId,
    fee_regime: feeRegime,
  };
}

export async function listStudentScopedPaymentTypes({
  studentId,
  publicUser = null,
  currentSessionId = null,
  semesterKey = null,
  paymentTypeId = null,
}) {
  const ctx = await resolveStudentPaymentContext({
    studentId,
    publicUser,
    currentSessionId,
    semesterKey,
  });

  const params = [];
  let whereSql = `WHERE pt.is_active = 1`;

  if (paymentTypeId) {
    whereSql += ` AND pt.id = ?`;
    params.push(Number(paymentTypeId));
  }

  const q = await db.query(
    `
      SELECT
        pt.*,
        pts.session_id AS scoped_session_id,
        pts.semester AS scoped_semester,
        psch.school_id AS scoped_school_id,
        ptd.department_id AS scoped_department_id,
        ptp.programme_id AS scoped_programme_id,
        pr.entry_level,
        pr.current_level,
        pr.admission_session_id,
        pr.amount_override
      FROM payment_types pt
      LEFT JOIN payment_type_sessions pts
        ON pts.payment_type_id = pt.id
      LEFT JOIN payment_type_schools psch
        ON psch.payment_type_id = pt.id
      LEFT JOIN payment_type_departments ptd
        ON ptd.payment_type_id = pt.id
      LEFT JOIN payment_type_programmes ptp
        ON ptp.payment_type_id = pt.id
      LEFT JOIN payment_type_rules pr
        ON pr.payment_type_id = pt.id
      ${whereSql}
      ORDER BY pt.name ASC, pt.id DESC
    `,
    params,
  );

  const grouped = groupScopedRows(toRows(q));
  const rows = [];

  for (const item of grouped) {
    if (!matchesScopedFilters(item, ctx)) continue;

    let matchedRule = null;
    if (item.rules.length) {
      matchedRule = item.rules.find((r) => matchesRule(r, ctx)) || null;
      if (!matchedRule) continue;
    }

    const resolved = pickResolvedAmounts(item.base, matchedRule, ctx);

    rows.push({
      ...item.base,
      amount: resolved.amount,
      portal_charge: resolved.portal_charge,
      remita_service_type_id: resolved.remita_service_type_id,
      fee_regime: resolved.fee_regime,
      matched_rule: matchedRule
        ? {
            entry_level: matchedRule.entry_level,
            current_level: matchedRule.current_level,
            admission_session_id: matchedRule.admission_session_id,
            amount_override: matchedRule.amount_override,
          }
        : null,
      scoped_school_ids: uniqInts(Array.from(item.schoolIds)),
      scoped_department_ids: uniqInts(Array.from(item.departmentIds)),
      scoped_programme_ids: uniqInts(Array.from(item.programmeIds)),
    });
  }

  return {
    context: ctx,
    rows,
  };
}

export async function getResolvedPaymentTypeForStudent({
  studentId,
  publicUser = null,
  paymentTypeId,
  currentSessionId = null,
  semesterKey = null,
}) {
  const result = await listStudentScopedPaymentTypes({
    studentId,
    publicUser,
    paymentTypeId,
    currentSessionId,
    semesterKey,
  });

  return result.rows?.[0] || null;
}
