import db from "../core/db.js";

function json(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return JSON.stringify({ value: String(value) }); }
}

export async function writeAudit(connection, req, entry) {
  const executor = connection || db;
  const actor = req?.user || req?.session?.user || req?.session?.staff || null;
  await executor.query(
    `INSERT INTO portal_audit_log
      (actor_user_id, actor_role, action, entity_type, entity_id, reason,
       old_values, new_values, request_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.id || null,
      String(actor?.role || "").toLowerCase() || null,
      entry.action,
      entry.entityType,
      entry.entityId == null ? null : String(entry.entityId),
      entry.reason || null,
      json(entry.oldValues),
      json(entry.newValues),
      String(req?.ip || req?.socket?.remoteAddress || "").slice(0, 64) || null,
      String(req?.get?.("user-agent") || "").slice(0, 255) || null,
    ],
  );
}
