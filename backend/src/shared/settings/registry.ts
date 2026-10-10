import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Registry of organization settings (docs/architecture/v3/02 §4.2: "registry in code: type, schema, default,
 * sensitivity"; 11 §5.3: `shared/settings`). The table `app.organization_settings` stores only values a tenant
 * administrator has chosen; this registry decides which keys exist, what a valid value looks like, and what applies
 * while nothing is stored.
 *
 * WHAT IS REGISTERED, AND WHY ONLY THIS:
 *  Only keys whose TYPE the architecture states completely (02 §4.2): a number, a boolean, or a closed enumeration.
 *  A default is registered only where the document gives one (`identity.age_of_majority` = 18); a key without a
 *  default has no value until an administrator sets one, and consumers must handle that.
 *
 * NOT REGISTERED (deliberately; the architecture does not yet give a complete schema or default, and this file must
 * not invent them): `terminology`, `academic.degree_levels`, `identity.admission_number`, `privacy.student_fields`,
 * `security.password_policy` / session lifetimes, `retention.*`, `attendance.default_policy_id`, and
 * `identity.unknown_dob_policy` (referenced in 02 §4.4 but absent from the §4.2 key list). Each is added by the
 * slice that owns its meaning, together with a schema, a default decision and tests.
 *
 * PER-KEY SENSITIVITY: the architecture says the registry carries a sensitivity but does not assign one to any key
 * ("CRITICAL keys A2" names no key). It is therefore not modelled here. Every write is already CRITICAL because it
 * requires `org.settings.manage` (a CRITICAL permission): a mandatory reason and a risk-tier-2 audit row.
 */
export interface SettingDefinition {
  readonly key: string;
  /** TypeBox schema every stored value must satisfy. */
  readonly schema: TSchema;
  /** Applies while no row exists. Absent = no value until one is set. */
  readonly default?: unknown;
}

/** `module.name` style: lower-case segments of letters/digits/underscore separated by dots (02 §4.2 key names). */
export const SETTING_KEY_PATTERN = '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$';
export const SETTING_KEY_MAX_LENGTH = 100;
/** The database CHECK on `value` is 16 KiB; the service refuses larger values before they reach it. */
export const SETTING_VALUE_MAX_BYTES = 16_384;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    // 02 §4.2: "int (default 18; jurisdiction decision is the tenant's/legal's, not ours)". The 0..150 bound is a
    // technical sanity limit on the integer, NOT a legal rule; the document states none.
    key: 'identity.age_of_majority',
    schema: Type.Integer({ minimum: 0, maximum: 150 }),
    default: 18,
  },
  {
    // 02 §4.2: "bool"; no default stated.
    key: 'identity.dob_required',
    schema: Type.Boolean(),
  },
  {
    // 02 §4.2: NEVER | MINORS_ONLY | ALWAYS_WHEN_ENABLED; no default stated.
    key: 'guardian.notification_policy',
    schema: Type.Union([
      Type.Literal('NEVER'),
      Type.Literal('MINORS_ONLY'),
      Type.Literal('ALWAYS_WHEN_ENABLED'),
    ]),
  },
  {
    // 02 §4.2: MINORS_ONLY | ALWAYS_WHEN_LINKED | NEVER; no default stated.
    key: 'guardian.academic_visibility',
    schema: Type.Union([
      Type.Literal('MINORS_ONLY'),
      Type.Literal('ALWAYS_WHEN_LINKED'),
      Type.Literal('NEVER'),
    ]),
  },
];

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((d) => [d.key, d]),
);

/** Exact-match lookup. An unregistered key is not a setting, whatever its spelling. */
export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** True when `value` satisfies the key's schema. Never throws and never echoes the value. */
export function isValidSettingValue(definition: SettingDefinition, value: unknown): boolean {
  return Value.Check(definition.schema, value);
}
