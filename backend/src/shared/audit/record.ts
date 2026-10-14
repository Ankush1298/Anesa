import { isIP } from 'node:net';
import { AppError, databaseBusy, isDatabaseTimeout } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { isUuidV7, uuidv7 } from '../ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { findAuditMetadataProblem } from './sensitive-keys.js';

/**
 * Request-level facts the audit row may carry. They come from the calling route/service boundary
 * (the request), never from the TrustedContext and never from request bodies. All optional.
 */
export interface AuditRequestMeta {
  /** Correlates with log lines. Any UUID version (Fastify generates v4). */
  requestId?: string;
  /** platform.auth_sessions.id of the authenticated session. */
  sessionId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditEvent {
  /** `module.resource.action`, e.g. `role.assignment.grant`. */
  action: string;
  resourceType: string;
  resourceId?: string;
  subjectStudentId?: string;
  campusId?: string;
  departmentId?: string;
  /** 1 routine, 2 sensitive change (reason required by the caller), 3 exceptional. */
  riskTier: 1 | 2 | 3;
  /** Field-level diff `{field: {old, new}}`. Sensitive keys are rejected. */
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  reasonCode?: string;
  reasonText?: string;
}

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE_TYPE_RE = /^[a-z][a-z0-9_]{0,59}$/;
const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 16_384;

function invalid(what: string): AppError {
  // A programming error, not a user error: generic message, nothing about the data.
  return new AppError(500, 'AUDIT_INVALID', `Audit event rejected: ${what}.`);
}

function optionalV7(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  if (!isUuidV7(value)) throw invalid(`${name} must be a UUIDv7`);
  return value.toLowerCase();
}

function json(value: Record<string, unknown> | undefined, name: string): string | null {
  if (value === undefined) return null;
  const problem = findAuditMetadataProblem(value);
  if (problem) throw invalid(`${name}: ${problem}`);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw invalid(`${name} is too large`);
  return text;
}

/** Control characters and over-long values are stripped/truncated; the header is otherwise opaque. */
function cleanUserAgent(ua: string | undefined): string | null {
  if (ua === undefined) return null;
  const printable = Array.from(ua, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f ? ' ' : ch; // control characters become spaces
  }).join('');
  const cleaned = printable.trim().slice(0, 256);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The single writer of app.audit_events (a static test enforces it). Call it INSIDE the same
 * `withTenant` transaction as the business change: the audit row commits or rolls back with it, and if
 * the audit insert fails the error propagates, the caller's transaction rolls back and the business
 * change does not happen (fail closed, ADR-008).
 *
 * The tenant and the actor come only from the TrustedContext (and are re-checked by RLS); occurred_at
 * is the database clock. This function persists only the fields above: never a request body.
 */
export async function recordAudit(
  tx: TenantTx,
  ctx: TrustedContext,
  event: AuditEvent,
  meta: AuditRequestMeta = {},
): Promise<string> {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
  if (!ACTION_RE.test(event.action) || event.action.length > 100) throw invalid('action format');
  if (!RESOURCE_TYPE_RE.test(event.resourceType)) throw invalid('resourceType format');
  if (![1, 2, 3].includes(event.riskTier)) throw invalid('riskTier');
  if (event.reasonCode !== undefined && !REASON_CODE_RE.test(event.reasonCode)) {
    throw invalid('reasonCode format');
  }
  let reasonText: string | null = null;
  if (event.reasonText !== undefined) {
    reasonText = event.reasonText.trim();
    if (reasonText.length < 1 || reasonText.length > 500) throw invalid('reasonText length');
  }
  if (meta.requestId !== undefined && !UUID_RE.test(meta.requestId)) throw invalid('requestId');
  if (meta.ip !== undefined && isIP(meta.ip) === 0) throw invalid('ip');

  // Build and validate EVERY parameter before touching the database, so a malformed event is reported
  // as AUDIT_INVALID and only a genuine database failure becomes AUDIT_WRITE_FAILED.
  const id = uuidv7();
  const params: unknown[] = [
    id,
    ctx.tenantId,
    ctx.userId,
    optionalV7(meta.sessionId, 'sessionId'),
    meta.requestId ?? null,
    meta.ip ?? null,
    cleanUserAgent(meta.userAgent),
    event.action,
    event.resourceType,
    optionalV7(event.resourceId, 'resourceId'),
    optionalV7(event.subjectStudentId, 'subjectStudentId'),
    optionalV7(event.campusId, 'campusId'),
    optionalV7(event.departmentId, 'departmentId'),
    event.riskTier,
    json(event.changes, 'changes'),
    event.reasonCode ?? null,
    reasonText,
    json(event.metadata, 'metadata'),
  ];
  try {
    await tx.query(
      `INSERT INTO app.audit_events
         (id, organization_id, actor_type, actor_user_id, session_id, request_id, ip, user_agent,
          action, resource_type, resource_id, subject_student_id, campus_id, department_id,
          risk_tier, changes, reason_code, reason_text, metadata)
       VALUES ($1, $2, 'USER', $3, $4, $5, $6::inet, $7, $8, $9, $10, $11, $12, $13, $14,
               $15::jsonb, $16, $17, $18::jsonb)`,
      params,
    );
  } catch (err) {
    // Still ALWAYS a throw: the business write never commits without its audit record. The one distinction kept is a
    // lock/statement timeout (55P03 / 57014): the same retry-safe 503 every other timeout gets, instead of an opaque
    // 500, because the whole transaction rolls back and nothing was written. No driver detail leaves this function.
    if (isDatabaseTimeout(err)) throw databaseBusy();
    // Includes "no partition of relation found for row" and any RLS/constraint failure; the caller's transaction is
    // already doomed and will roll back.
    throw new AppError(500, 'AUDIT_WRITE_FAILED', 'The audit record could not be written.');
  }
  return id;
}
