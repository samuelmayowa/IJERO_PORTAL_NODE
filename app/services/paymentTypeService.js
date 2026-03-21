// app/services/paymentTypeService.js
import db from "../core/db.js";

function toIntArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((n) => Number(n)).filter(Boolean);
  return String(v)
    .split(",")
    .map((n) => Number(n))
    .filter(Boolean);
}

function toRows(x) {
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

function normalizeScope(scope) {
  return String(scope || "GENERAL")
    .trim()
    .toUpperCase() === "GENERAL"
    ? "GENERAL"
    : "BOTH";
}

function normalizeSemesterValue(v) {
  const raw = String(v == null ? "" : v)
    .trim()
    .toUpperCase();
  if (!raw || raw === "0" || raw === "ALL") return "ALL";
  if (raw === "1" || raw === "FIRST") return "FIRST";
  if (raw === "2" || raw === "SECOND") return "SECOND";
  return raw;
}

function extractSessions(payload) {
  const pairs = [];
  const rows = Array.isArray(payload.sessionRows) ? payload.sessionRows : [];

  for (const row of rows) {
    const sid = Number(row?.session_id || 0);
    const sem = normalizeSemesterValue(row?.semester);
    if (sid > 0) {
      pairs.push({ sid, sem });
    }
  }

  if (!pairs.length) {
    const sids = toIntArray(payload.session_ids);
    const sems = Array.isArray(payload.session_semesters)
      ? payload.session_semesters
      : [];

    for (let i = 0; i < sids.length; i++) {
      const sid = Number(sids[i] || 0);
      const sem = normalizeSemesterValue(sems[i]);
      if (sid > 0) {
        pairs.push({ sid, sem });
      }
    }
  }

  const seen = new Set();
  return pairs.filter((p) => {
    const key = `${p.sid}::${p.sem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function list({ page = 1, pageSize = 20, q = "" }) {
  const off = (page - 1) * pageSize;
  const args = [];
  const where = [];

  if (q) {
    where.push("(pt.name LIKE ? OR pt.purpose LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const listR = await db.query(
    `
      SELECT pt.*
      FROM payment_types pt
      ${whereSql}
      ORDER BY pt.created_at DESC
      LIMIT ? OFFSET ?
    `,
    [...args, pageSize, off],
  );

  const countR = await db.query(
    `SELECT COUNT(*) AS cnt FROM payment_types pt ${whereSql}`,
    args,
  );

  const rows = toRows(listR);
  const [{ cnt }] = toRows(countR);

  return {
    rows,
    pagination: {
      page,
      pageSize,
      total: Number(cnt || 0),
      totalPages: Math.max(1, Math.ceil(Number(cnt || 0) / pageSize)),
    },
  };
}

export async function get(id) {
  const r = await db.query(`SELECT * FROM payment_types WHERE id = ?`, [id]);
  const [row] = toRows(r);
  if (!row) return null;

  const [schoolsR, departmentsR, programmesR, sessionsR, rulesR] =
    await Promise.all([
      db.query(
        `SELECT school_id FROM payment_type_schools WHERE payment_type_id = ? ORDER BY school_id ASC`,
        [id],
      ),
      db.query(
        `SELECT department_id FROM payment_type_departments WHERE payment_type_id = ? ORDER BY department_id ASC`,
        [id],
      ),
      db.query(
        `SELECT programme_id FROM payment_type_programmes WHERE payment_type_id = ? ORDER BY programme_id ASC`,
        [id],
      ),
      db.query(
        `SELECT session_id, semester FROM payment_type_sessions WHERE payment_type_id = ? ORDER BY session_id ASC, semester ASC`,
        [id],
      ),
      db.query(
        `SELECT entry_level, current_level, admission_session_id, amount_override
       FROM payment_type_rules
       WHERE payment_type_id = ?
       ORDER BY id DESC
       LIMIT 1`,
        [id],
      ),
    ]);

  const school_ids = toRows(schoolsR)
    .map((x) => Number(x.school_id))
    .filter(Boolean);
  const department_ids = toRows(departmentsR)
    .map((x) => Number(x.department_id))
    .filter(Boolean);
  const programme_ids = toRows(programmesR)
    .map((x) => Number(x.programme_id))
    .filter(Boolean);

  const sessionRows = toRows(sessionsR).map((x) => ({
    session_id: Number(x.session_id) || "",
    semester:
      normalizeSemesterValue(x.semester) === "ALL"
        ? ""
        : normalizeSemesterValue(x.semester),
  }));

  const [rule] = toRows(rulesR);

  return {
    ...row,
    school_ids,
    department_ids,
    programme_ids,
    sessionRows,
    rule_entry_level: rule?.entry_level ?? "",
    rule_current_level: rule?.current_level ?? "",
    rule_admission_session_id: rule?.admission_session_id ?? "",
    rule_amount_override: rule?.amount_override ?? "",
  };
}

async function existsDuplicate({ name, purpose, scope }) {
  const r = await db.query(
    `SELECT id
     FROM payment_types
     WHERE name = ?
       AND purpose = ?
       AND scope = ?
     LIMIT 1`,
    [String(name).trim(), String(purpose).trim(), normalizeScope(scope)],
  );

  return !!toRows(r)?.[0];
}

async function insertPivotRows(conn, table, col, paymentTypeId, ids) {
  const cleanIds = Array.from(
    new Set((ids || []).map((x) => Number(x)).filter(Boolean)),
  );
  if (!cleanIds.length) return;

  const values = cleanIds.map((v) => [paymentTypeId, v]);
  await conn.query(`INSERT INTO ${table} (payment_type_id, ${col}) VALUES ?`, [
    values,
  ]);
}

export async function create(payload, createdBy) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const {
      name,
      purpose,
      amount = 0,
      portal_charge = 0,
      scope = "GENERAL",
      is_active = 1,

      remita_service_type_id = "",
      uses_indigene_regime = 0,
      amount_indigene = null,
      amount_non_indigene = null,
      portal_charge_indigene = null,
      portal_charge_non_indigene = null,
      remita_service_type_id_indigene = "",
      remita_service_type_id_non_indigene = "",

      school_ids,
      department_ids,
      programme_ids,

      school_id,
      department_id,

      rule_entry_level,
      rule_current_level,
      rule_admission_session_id,
      rule_amount_override,
    } = payload;

    const normalizedScope = normalizeScope(scope);

    if (await existsDuplicate({ name, purpose, scope: normalizedScope })) {
      throw new Error(
        "A payment type with the same Name, Purpose and Scope already exists.",
      );
    }

    const [ins] = await conn.query(
      `
        INSERT INTO payment_types (
          name,
          purpose,
          remita_service_type_id,
          uses_indigene_regime,
          amount,
          portal_charge,
          amount_indigene,
          amount_non_indigene,
          portal_charge_indigene,
          portal_charge_non_indigene,
          remita_service_type_id_indigene,
          remita_service_type_id_non_indigene,
          scope,
          is_active,
          created_by
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
      [
        String(name).trim(),
        String(purpose).trim(),
        String(remita_service_type_id || "").trim() || null,
        uses_indigene_regime ? 1 : 0,
        Number(amount || 0),
        Number(portal_charge || 0),
        amount_indigene === "" || amount_indigene == null
          ? null
          : Number(amount_indigene),
        amount_non_indigene === "" || amount_non_indigene == null
          ? null
          : Number(amount_non_indigene),
        portal_charge_indigene === "" || portal_charge_indigene == null
          ? null
          : Number(portal_charge_indigene),
        portal_charge_non_indigene === "" || portal_charge_non_indigene == null
          ? null
          : Number(portal_charge_non_indigene),
        String(remita_service_type_id_indigene || "").trim() || null,
        String(remita_service_type_id_non_indigene || "").trim() || null,
        normalizedScope,
        is_active ? 1 : 0,
        createdBy || null,
      ],
    );

    const id = ins.insertId;

    if (normalizedScope !== "GENERAL") {
      await insertPivotRows(
        conn,
        "payment_type_schools",
        "school_id",
        id,
        school_ids?.length ? school_ids : school_id,
      );

      await insertPivotRows(
        conn,
        "payment_type_departments",
        "department_id",
        id,
        department_ids?.length ? department_ids : department_id,
      );

      await insertPivotRows(
        conn,
        "payment_type_programmes",
        "programme_id",
        id,
        programme_ids,
      );
    }

    const pairs = extractSessions(payload);
    if (pairs.length) {
      const values = pairs.map((p) => [id, p.sid, p.sem]);
      await conn.query(
        `INSERT INTO payment_type_sessions (payment_type_id, session_id, semester) VALUES ?`,
        [values],
      );
    }

    const entryL = String(rule_entry_level || "").trim() || null;
    const currentL = String(rule_current_level || "").trim() || null;
    const admSess = Number(rule_admission_session_id) || null;
    const override =
      rule_amount_override === "" || rule_amount_override == null
        ? null
        : Number(rule_amount_override);

    if (entryL || currentL || admSess || override !== null) {
      await conn.query(
        `
          INSERT INTO payment_type_rules
            (payment_type_id, entry_level, current_level, admission_session_id, amount_override)
          VALUES (?,?,?,?,?)
        `,
        [id, entryL, currentL, admSess, override],
      );
    }

    await conn.commit();
    return id;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function update(id, payload) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const {
      name,
      purpose,
      amount,
      portal_charge,
      scope,
      is_active,

      remita_service_type_id,
      uses_indigene_regime,
      amount_indigene,
      amount_non_indigene,
      portal_charge_indigene,
      portal_charge_non_indigene,
      remita_service_type_id_indigene,
      remita_service_type_id_non_indigene,

      school_ids,
      department_ids,
      programme_ids,

      school_id,
      department_id,

      sessionRows,
      session_ids,
      session_semesters,

      rule_entry_level,
      rule_current_level,
      rule_admission_session_id,
      rule_amount_override,
    } = payload;

    const normalizedScope = normalizeScope(scope);

    await conn.query(
      `
        UPDATE payment_types SET
          name = COALESCE(?, name),
          purpose = COALESCE(?, purpose),
          remita_service_type_id = COALESCE(?, remita_service_type_id),
          uses_indigene_regime = COALESCE(?, uses_indigene_regime),
          amount = COALESCE(?, amount),
          portal_charge = COALESCE(?, portal_charge),
          amount_indigene = ?,
          amount_non_indigene = ?,
          portal_charge_indigene = ?,
          portal_charge_non_indigene = ?,
          remita_service_type_id_indigene = ?,
          remita_service_type_id_non_indigene = ?,
          scope = COALESCE(?, scope),
          is_active = COALESCE(?, is_active),
          updated_at = NOW()
        WHERE id = ?
      `,
      [
        name ?? null,
        purpose ?? null,
        typeof remita_service_type_id === "undefined"
          ? null
          : String(remita_service_type_id || "").trim() || null,
        typeof uses_indigene_regime === "undefined"
          ? null
          : uses_indigene_regime
            ? 1
            : 0,
        amount == null ? null : Number(amount),
        portal_charge == null ? null : Number(portal_charge),
        amount_indigene === "" || amount_indigene == null
          ? null
          : Number(amount_indigene),
        amount_non_indigene === "" || amount_non_indigene == null
          ? null
          : Number(amount_non_indigene),
        portal_charge_indigene === "" || portal_charge_indigene == null
          ? null
          : Number(portal_charge_indigene),
        portal_charge_non_indigene === "" || portal_charge_non_indigene == null
          ? null
          : Number(portal_charge_non_indigene),
        typeof remita_service_type_id_indigene === "undefined"
          ? null
          : String(remita_service_type_id_indigene || "").trim() || null,
        typeof remita_service_type_id_non_indigene === "undefined"
          ? null
          : String(remita_service_type_id_non_indigene || "").trim() || null,
        normalizedScope,
        typeof is_active === "undefined" ? null : is_active ? 1 : 0,
        id,
      ],
    );

    await conn.query(
      `DELETE FROM payment_type_schools WHERE payment_type_id = ?`,
      [id],
    );
    await conn.query(
      `DELETE FROM payment_type_departments WHERE payment_type_id = ?`,
      [id],
    );
    await conn.query(
      `DELETE FROM payment_type_programmes WHERE payment_type_id = ?`,
      [id],
    );
    await conn.query(
      `DELETE FROM payment_type_sessions WHERE payment_type_id = ?`,
      [id],
    );
    await conn.query(
      `DELETE FROM payment_type_rules WHERE payment_type_id = ?`,
      [id],
    );

    if (normalizedScope !== "GENERAL") {
      await insertPivotRows(
        conn,
        "payment_type_schools",
        "school_id",
        id,
        school_ids?.length ? school_ids : school_id,
      );

      await insertPivotRows(
        conn,
        "payment_type_departments",
        "department_id",
        id,
        department_ids?.length ? department_ids : department_id,
      );

      await insertPivotRows(
        conn,
        "payment_type_programmes",
        "programme_id",
        id,
        programme_ids,
      );
    }

    const pairs = extractSessions({
      sessionRows,
      session_ids,
      session_semesters,
    });
    if (pairs.length) {
      const values = pairs.map((p) => [id, p.sid, p.sem]);
      await conn.query(
        `INSERT INTO payment_type_sessions (payment_type_id, session_id, semester) VALUES ?`,
        [values],
      );
    }

    const entryL = String(rule_entry_level || "").trim() || null;
    const currentL = String(rule_current_level || "").trim() || null;
    const admSess = Number(rule_admission_session_id) || null;
    const override =
      rule_amount_override === "" || rule_amount_override == null
        ? null
        : Number(rule_amount_override);

    if (entryL || currentL || admSess || override !== null) {
      await conn.query(
        `
          INSERT INTO payment_type_rules
            (payment_type_id, entry_level, current_level, admission_session_id, amount_override)
          VALUES (?,?,?,?,?)
        `,
        [id, entryL, currentL, admSess, override],
      );
    }

    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
