// app/services/paymentTypeService.js  (ESM)
import db from '../core/db.js';

/** utils */
function toIntArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(n => Number(n)).filter(Boolean);
  return String(v).split(',').map(n => Number(n)).filter(Boolean);
}

function toRows(x) {
  // mysql2/promise returns [rows, fields] — normalize if needed
  if (Array.isArray(x) && Array.isArray(x[0])) return x[0];
  return x || [];
}

/** Extract sessions from flexible form payload */
function extractSessions(payload) {
  // New form shape: sessionRows[][session_id], sessionRows[][semester]
  const rows = Array.isArray(payload.sessionRows) ? payload.sessionRows : [];
  const pairs = rows
    .map(r => ({
      sid: Number(r?.session_id) || 0,
      sem: (r?.semester === '' || r?.semester == null) ? 0 : Number(r?.semester)
    }))
    .filter(p => p.sid > 0);

  // Back-compat: session_ids + session_semesters
  if (!pairs.length) {
    const sids = toIntArray(payload.session_ids);
    const sems = Array.isArray(payload.session_semesters)
      ? payload.session_semesters.map(x => Number(x || 0))
      : [];
    for (let i = 0; i < sids.length; i++) {
      pairs.push({ sid: sids[i], sem: Number(sems[i] ?? 0) });
    }
  }
  return pairs;
}

/** LIST (with simple search + pagination) */
export async function list({ page = 1, pageSize = 20, q = '' }) {
  const off = (page - 1) * pageSize;
  const args = [];
  const where = [];
  if (q) {
    where.push('(pt.name LIKE ? OR pt.purpose LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const listR = await db.query(
    `SELECT pt.*
     FROM payment_types pt
     ${whereSql}
     ORDER BY pt.created_at DESC
     LIMIT ? OFFSET ?`,
    [...args, pageSize, off]
  );
  const rows = toRows(listR);

  const countR = await db.query(
    `SELECT COUNT(*) AS cnt FROM payment_types pt ${whereSql}`,
    args
  );
  const [{ cnt }] = toRows(countR);

  return {
    rows,
    pagination: {
      page,
      pageSize,
      total: Number(cnt || 0),
      totalPages: Math.max(1, Math.ceil(Number(cnt || 0) / pageSize))
    }
  };
}

/** GET one */
export async function get(id) {
  const r = await db.query(`SELECT * FROM payment_types WHERE id=?`, [id]);
  const [row] = toRows(r);
  return row || null;
}

/** Check duplicate (name + purpose + scope) */
async function existsDuplicate({ name, purpose, scope }) {
  const r = await db.query(
    `SELECT id FROM payment_types WHERE name=? AND purpose=? AND scope=? LIMIT 1`,
    [String(name).trim(), String(purpose).trim(), String(scope).toUpperCase()]
  );
  const [hit] = toRows(r);
  return !!hit;
}

/** CREATE with pivots + rules (transaction) */
export async function create(payload, createdBy) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      name, purpose,
      amount = 0, portal_charge = 0,
      scope = 'GENERAL',
      is_active = 1,

      // NEW (from form; multiple)
      school_ids,
      department_ids,

      // Back-compat (single)
      school_id,
      department_id,

      // Optional rule set
      rule_entry_level,
      rule_current_level,
      rule_admission_session_id,
      rule_amount_override
    } = payload;

    // Duplicate check
    if (await existsDuplicate({ name, purpose, scope })) {
      throw new Error('A payment type with the same Name, Purpose and Scope already exists.');
    }

    // Insert base row
    const [ins] = await conn.query(
      `INSERT INTO payment_types (name, purpose, amount, portal_charge, scope, is_active, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [
        String(name).trim(),
        String(purpose).trim(),
        Number(amount || 0),
        Number(portal_charge || 0),
        String(scope).toUpperCase(),
        is_active ? 1 : 0,
        createdBy || null
      ]
    );
    const id = ins.insertId;

    const sc = String(scope || 'GENERAL').toUpperCase();

    // Pivots by scope
    if (sc === 'SCHOOL' || sc === 'BOTH') {
      // accept multiple OR single (back-compat)
      const sids = toIntArray(school_ids?.length ? school_ids : school_id);
      if (sids.length) {
        const values = sids.map(sid => [id, sid]);
        await conn.query(
          `INSERT INTO payment_type_schools (payment_type_id, school_id) VALUES ?`,
          [values]
        );
      }
    }
    if (sc === 'DEPARTMENT' || sc === 'BOTH') {
      const dids = toIntArray(department_ids?.length ? department_ids : department_id);
      if (dids.length) {
        const values = dids.map(did => [id, did]);
        await conn.query(
          `INSERT INTO payment_type_departments (payment_type_id, department_id) VALUES ?`,
          [values]
        );
      }
    }

    // Sessions + Semesters
    const pairs = extractSessions(payload);
    if (pairs.length) {
      const values = pairs.map(p => [id, p.sid, p.sem]);
      await conn.query(
        `INSERT INTO payment_type_sessions (payment_type_id, session_id, semester) VALUES ?`,
        [values]
      );
    }

    // Optional single rule
    const entryL   = Number(rule_entry_level) || null;
    const currentL = Number(rule_current_level) || null;
    const admSess  = Number(rule_admission_session_id) || null;
    const override = (rule_amount_override === '' || rule_amount_override == null)
      ? null : Number(rule_amount_override);

    if (entryL || currentL || admSess || override !== null) {
      await conn.query(
        `INSERT INTO payment_type_rules
          (payment_type_id, entry_level, current_level, admission_session_id, amount_override)
         VALUES (?,?,?,?,?)`,
        [id, entryL, currentL, admSess, override]
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

/** UPDATE mirrors CREATE (replace pivots + rules) */
export async function update(id, payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      name, purpose,
      amount, portal_charge,
      scope,
      is_active,

      // NEW (from form; multiple)
      school_ids,
      department_ids,

      // Back-compat (single)
      school_id,
      department_id,

      // sessions (new + back-compat)
      sessionRows,
      session_ids,
      session_semesters,

      // rule set
      rule_entry_level, rule_current_level, rule_admission_session_id, rule_amount_override
    } = payload;

    await conn.query(
      `UPDATE payment_types SET
         name = COALESCE(?, name),
         purpose = COALESCE(?, purpose),
         amount = COALESCE(?, amount),
         portal_charge = COALESCE(?, portal_charge),
         scope = COALESCE(?, scope),
         is_active = COALESCE(?, is_active),
         updated_at = NOW()
       WHERE id = ?`,
      [
        name ?? null,
        purpose ?? null,
        (amount ?? null) === null ? null : Number(amount),
        (portal_charge ?? null) === null ? null : Number(portal_charge),
        scope ? String(scope).toUpperCase() : null,
        typeof is_active === 'undefined' ? null : (is_active ? 1 : 0),
        id
      ]
    );

    // Reset pivots/rules, then reinsert
    await conn.query(`DELETE FROM payment_type_schools    WHERE payment_type_id=?`, [id]);
    await conn.query(`DELETE FROM payment_type_departments WHERE payment_type_id=?`, [id]);
    await conn.query(`DELETE FROM payment_type_sessions   WHERE payment_type_id=?`, [id]);
    await conn.query(`DELETE FROM payment_type_rules      WHERE payment_type_id=?`, [id]);

    const sc = String(scope || 'GENERAL').toUpperCase();

    if (sc === 'SCHOOL' || sc === 'BOTH') {
      const sids = toIntArray(school_ids?.length ? school_ids : school_id);
      if (sids.length) {
        const values = sids.map(sid => [id, sid]);
        await conn.query(
          `INSERT INTO payment_type_schools (payment_type_id, school_id) VALUES ?`,
          [values]
        );
      }
    }
    if (sc === 'DEPARTMENT' || sc === 'BOTH') {
      const dids = toIntArray(department_ids?.length ? department_ids : department_id);
      if (dids.length) {
        const values = dids.map(did => [id, did]);
        await conn.query(
          `INSERT INTO payment_type_departments (payment_type_id, department_id) VALUES ?`,
          [values]
        );
      }
    }

    const pairs = extractSessions({ sessionRows, session_ids, session_semesters });
    if (pairs.length) {
      const values = pairs.map(p => [id, p.sid, p.sem]);
      await conn.query(
        `INSERT INTO payment_type_sessions (payment_type_id, session_id, semester) VALUES ?`,
        [values]
      );
    }

    const entryL   = Number(rule_entry_level) || null;
    const currentL = Number(rule_current_level) || null;
    const admSess  = Number(rule_admission_session_id) || null;
    const override = (rule_amount_override === '' || rule_amount_override == null)
      ? null : Number(rule_amount_override);

    if (entryL || currentL || admSess || override !== null) {
      await conn.query(
        `INSERT INTO payment_type_rules
          (payment_type_id, entry_level, current_level, admission_session_id, amount_override)
         VALUES (?,?,?,?,?)`,
        [id, entryL, currentL, admSess, override]
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
