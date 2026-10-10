import { isDeepStrictEqual } from 'node:util';
import type { TenantTx } from '../../shared/database/index.js';
import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { normaliseReason } from '../../shared/authorization/assignments.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import {
  SETTING_DEFINITIONS,
  SETTING_VALUE_MAX_BYTES,
  findSettingDefinition,
  isValidSettingValue,
  type ExpectedVersion,
} from '../../shared/settings/index.js';
import type { SettingRecordDto } from './organization.schemas.js';

const invalid = (msg: string): AppError => new AppError(400, 'VALIDATION_ERROR', msg);
const forbidden = (): AppError => new AppError(403, 'FORBIDDEN', 'Access denied.');

export interface SetSettingOptions {
  expectedVersion?: ExpectedVersion;
  meta?: AuditRequestMeta;
}

interface SettingRow {
  value: unknown;
  version: number;
  updated_at: Date;
}

/**
 * Writing organization-wide settings is strictly restricted to organization-scoped administrators
 * holding `org.settings.manage` (doc 06 §2, doc 10 row 19, doc 19).
 */
async function assertManageScope(tx: TenantTx, ctx: TrustedContext): Promise<void> {
  try {
    await AuthorizationEngine.assert(tx, ctx, 'org.settings.manage', {
      organization_id: ctx.tenantId,
    });
  } catch (err) {
    // assert() answers "not held" and "out of scope" with the resource-hiding 404; settings are not a hidden resource.
    if (err instanceof AppError && err.statusCode === 404) throw forbidden();
    throw err;
  }
}

/**
 * Settings are tenant-wide reference data (approved Decision 1; doc 19).
 * A caller with an effective `org.settings.read` grant at ANY supported assignment scope
 * (ORGANIZATION, CAMPUS, or DEPARTMENT) within the tenant may read organization settings.
 * This is a deliberate exception to normal resource-scope containment, allowing CAMPUS_ADMIN
 * and campus-scoped REGISTRARs to observe tenant-wide policies (e.g. age of majority, guardian policies).
 */
async function assertReadScope(tx: TenantTx, ctx: TrustedContext): Promise<void> {
  // Calling assert without a resource verifies the caller holds an effective grant within ctx.tenantId.
  await AuthorizationEngine.assert(tx, ctx, 'org.settings.read');
}

function toDto(key: string, row: SettingRow): SettingRecordDto {
  return {
    key,
    value: row.value,
    isDefault: false,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class SettingsService {
  /**
   * Lists every registered setting that currently has a value: the stored value, or the registry default while
   * nothing is stored. Keys that have neither are omitted. Stored rows whose key is no longer registered are never
   * returned. Requires `org.settings.read` at any valid scope (ORGANIZATION, CAMPUS, DEPARTMENT). Writes no audit event.
   */
  static async list(tx: TenantTx, ctx: TrustedContext): Promise<SettingRecordDto[]> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    await assertReadScope(tx, ctx);

    const stored = await tx.query<SettingRow & { key: string }>(
      `SELECT key, value, version, updated_at
         FROM app.organization_settings
        WHERE organization_id = $1`,
      [ctx.tenantId],
    );
    const byKey = new Map(stored.rows.map((r) => [r.key, r]));

    const out: SettingRecordDto[] = [];
    for (const def of SETTING_DEFINITIONS) {
      const row = byKey.get(def.key);
      if (row) {
        out.push(toDto(def.key, row));
      } else if (def.default !== undefined) {
        out.push({
          key: def.key,
          value: def.default,
          isDefault: true,
          version: null,
          updatedAt: null,
        });
      }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Sets one registered setting for the caller's organization (create or replace).
   *
   * CRITICAL action (org.settings.manage, doc 10 row 19): a reason is mandatory, and the change is audited in the
   * SAME transaction with risk tier 2, the reason and an old/new diff (doc 09 S-13: "settings change"). If the audit
   * write fails the setting is not changed. Setting a value equal to the stored one is a no-op: no write, no version
   * bump, no audit event. Concurrent writers of one key are serialized by a row lock.
   *
   * Optimistic concurrency (doc 08 §4.1 line 56, doc 06 §7, doc 09 §9): validates expectedVersion against stored
   * version. Mismatched versions or stale writes return 409 CONFLICT.
   *
   * Order of checks: authorization (403), then the key (404 when not registered), then reason and value (400).
   */
  static async set(
    tx: TenantTx,
    ctx: TrustedContext,
    key: string,
    input: { value: unknown; reason: unknown },
    options?: SetSettingOptions | AuditRequestMeta,
  ): Promise<SettingRecordDto> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    await assertManageScope(tx, ctx);

    const definition = findSettingDefinition(key);
    if (!definition) throw resourceNotFound();

    if (!input || typeof input !== 'object' || !('value' in input)) {
      throw invalid('A value is required.');
    }
    const reason = normaliseReason(input.reason);
    const value: unknown = input.value;
    if (!isValidSettingValue(definition, value)) {
      // Never echoes the submitted value.
      throw invalid(`The value does not satisfy the schema of setting "${key}".`);
    }
    if (Buffer.byteLength(JSON.stringify(value)) > SETTING_VALUE_MAX_BYTES) {
      throw invalid(`The value of setting "${key}" is too large.`);
    }
    const json = JSON.stringify(value);

    let expectedVersion: ExpectedVersion = { type: 'unconditional' };
    let meta: AuditRequestMeta = {};

    if (options) {
      if ('expectedVersion' in options || 'meta' in options) {
        if (options.expectedVersion) expectedVersion = options.expectedVersion;
        if (options.meta) meta = options.meta;
      } else {
        meta = options as AuditRequestMeta;
      }
    }

    // A first write races with another first write of the same key: the loser of the INSERT finds the row on the
    // next pass and updates it. Two passes are enough; a third would mean the row keeps disappearing.
    for (let pass = 0; pass < 2; pass++) {
      const current = await tx.query<SettingRow>(
        `SELECT value, version, updated_at
           FROM app.organization_settings
          WHERE organization_id = $1 AND key = $2
            FOR NO KEY UPDATE`,
        [ctx.tenantId, key],
      );
      const existing = current.rows[0];

      if (existing) {
        if (expectedVersion.type === 'initial') {
          throw new AppError(409, 'CONFLICT', 'Setting version mismatch.');
        }
        if (expectedVersion.type === 'version' && expectedVersion.version !== existing.version) {
          throw new AppError(409, 'CONFLICT', 'Setting version mismatch.');
        }

        if (isDeepStrictEqual(existing.value, value)) return toDto(key, existing);
        const updated = await tx.query<SettingRow>(
          `UPDATE app.organization_settings
              SET value = $3::jsonb, updated_by = $4
            WHERE organization_id = $1 AND key = $2 AND version = $5
        RETURNING value, version, updated_at`,
          [ctx.tenantId, key, json, ctx.userId, existing.version],
        );
        const row = updated.rows[0];
        if (!row) throw new AppError(409, 'CONFLICT', 'Setting version mismatch.');
        await SettingsService.audit(tx, ctx, key, reason, existing.value, value, false, meta);
        return toDto(key, row);
      }

      if (expectedVersion.type === 'version' || expectedVersion.type === 'exists') {
        throw new AppError(409, 'CONFLICT', 'Setting version mismatch.');
      }

      const inserted = await tx.query<SettingRow>(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (organization_id, key) DO NOTHING
         RETURNING value, version, updated_at`,
        [ctx.tenantId, key, json, ctx.userId],
      );
      const row = inserted.rows[0];
      if (row) {
        await SettingsService.audit(tx, ctx, key, reason, null, value, true, meta);
        return toDto(key, row);
      }
    }
    throw new AppError(409, 'CONFLICT', 'Setting was changed concurrently. Retry the request.');
  }

  private static async audit(
    tx: TenantTx,
    ctx: TrustedContext,
    key: string,
    reason: string,
    oldValue: unknown,
    newValue: unknown,
    created: boolean,
    meta: AuditRequestMeta,
  ): Promise<void> {
    await recordAudit(
      tx,
      ctx,
      {
        action: 'organization.setting.update',
        resourceType: 'organization_setting',
        riskTier: 2,
        reasonText: reason,
        // `old` is the previously STORED value (null when no row existed, i.e. the registry default applied).
        changes: { value: { old: oldValue, new: newValue } },
        // The key is a VALUE here, not a JSON key: audit rejects sensitive-looking key names (sensitive-keys.ts).
        metadata: { settingKey: key, created },
      },
      meta,
    );
  }
}
