import mongoose, { Schema } from "mongoose";
import type { AuthUser } from "../types/auth";

// Append-only audit trail in MongoDB. Writes are fire-and-forget: an unavailable
// MongoDB must never fail the business request that triggered the event.
const auditSchema = new Schema(
  {
    actorId: { type: String, required: true, index: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true, index: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true, index: true },
    meta: { type: Schema.Types.Mixed },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { collection: "audit_logs", versionKey: false },
);

export const AuditLog = mongoose.model("AuditLog", auditSchema);

export function audit(
  actor: AuthUser,
  action: string,
  entity: string,
  entityId: string,
  meta?: Record<string, unknown>,
): void {
  if (mongoose.connection.readyState !== 1) return;
  AuditLog.create({ actorId: actor.id, actorRole: actor.role, action, entity, entityId, meta }).catch(
    (err: Error) => console.error("Audit log write failed:", err.message),
  );
}

export async function listAuditLogs(filter: { entityId?: string; actorId?: string; action?: string }, limit = 50) {
  if (mongoose.connection.readyState !== 1) return [];
  const q: Record<string, string> = {};
  if (filter.entityId) q.entityId = filter.entityId;
  if (filter.actorId) q.actorId = filter.actorId;
  if (filter.action) q.action = filter.action;
  return AuditLog.find(q).sort({ at: -1 }).limit(limit).lean();
}
