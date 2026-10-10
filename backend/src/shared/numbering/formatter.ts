import { AppError } from '../errors/http-errors.js';

export interface FormatTemplateVars {
  readonly yyyy?: string | number;
  readonly program?: string;
}

const SEQ_TOKEN_RE = /^seq:([1-9][0-9]*)$/;
const KNOWN_TOKENS = new Set(['yyyy', 'program']);

/**
 * Pure formatter for number sequence templates (docs/architecture/v3/02 §4.2:
 * `{yyyy}{program}{seq:4}`).
 *
 * Supported documented tokens:
 *  - `{yyyy}`: 4-digit calendar year
 *  - `{program}`: Program code
 *  - `{seq:N}`: Zero-padded monotonic sequence of width N (positive integer)
 *
 * Guaranteed invariants:
 *  - Pure and deterministic (zero I/O, zero database access).
 *  - Requires exactly one `{seq:N}` token per template.
 *  - Rejects malformed templates, unmatched braces, unknown tokens, and missing variables.
 *  - Rejects sequence values that exceed width N with a typed 409 SEQUENCE_OVERFLOW.
 */
export function formatSequence(template: string, vars: FormatTemplateVars, seq: bigint): string {
  if (typeof template !== 'string' || template.trim().length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Template must be a non-empty string.');
  }

  if (typeof seq !== 'bigint') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Sequence value must be a bigint.');
  }

  if (seq < 0n) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Sequence value cannot be negative.');
  }

  // Check for unmatched or malformed braces
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      depth++;
      if (depth > 1) {
        throw new AppError(400, 'MALFORMED_TEMPLATE', 'Template contains nested braces.');
      }
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        throw new AppError(400, 'MALFORMED_TEMPLATE', 'Template contains unmatched closing brace.');
      }
    }
  }
  if (depth !== 0) {
    throw new AppError(400, 'MALFORMED_TEMPLATE', 'Template contains unmatched opening brace.');
  }

  // Scan and validate tokens
  const tokenMatcher = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  let seqTokenCount = 0;
  let seqWidth = 0;

  while ((match = tokenMatcher.exec(template)) !== null) {
    const tag = match[1]!;
    if (tag.length === 0) {
      throw new AppError(400, 'MALFORMED_TEMPLATE', 'Template contains empty token "{}".');
    }

    const seqMatch = SEQ_TOKEN_RE.exec(tag);
    if (seqMatch) {
      seqTokenCount++;
      const width = parseInt(seqMatch[1]!, 10);
      if (isNaN(width) || width < 1 || width > 20) {
        throw new AppError(
          400,
          'MALFORMED_TEMPLATE',
          `Invalid sequence width in token "{${tag}}". Must be between 1 and 20.`,
        );
      }
      seqWidth = width;
    } else if (tag.startsWith('seq:')) {
      throw new AppError(
        400,
        'MALFORMED_TEMPLATE',
        `Invalid sequence token "{${tag}}". Sequence width must be a positive integer without leading zeros.`,
      );
    } else if (!KNOWN_TOKENS.has(tag)) {
      throw new AppError(
        400,
        'MALFORMED_TEMPLATE',
        `Unknown template token "{${tag}}". Supported tokens: {yyyy}, {program}, {seq:N}.`,
      );
    }
  }

  if (seqTokenCount === 0) {
    throw new AppError(400, 'MALFORMED_TEMPLATE', 'Template must contain a "{seq:N}" token.');
  }

  if (seqTokenCount > 1) {
    throw new AppError(
      400,
      'MALFORMED_TEMPLATE',
      'Template cannot contain multiple "{seq:N}" tokens.',
    );
  }

  // Sequence overflow check against declared width N
  const seqStr = seq.toString();
  if (seqStr.length > seqWidth) {
    throw new AppError(
      409,
      'SEQUENCE_OVERFLOW',
      `Sequence value ${seqStr} exceeds template width of ${seqWidth} digits.`,
    );
  }

  const paddedSeq = seqStr.padStart(seqWidth, '0');

  // Replace tokens with validated values
  return template.replace(/\{([^}]+)\}/g, (_full, tag: string) => {
    if (tag.startsWith('seq:')) {
      return paddedSeq;
    }
    if (tag === 'yyyy') {
      const val = vars.yyyy;
      if (val === undefined || val === null || String(val).trim().length === 0) {
        throw new AppError(
          400,
          'MISSING_TEMPLATE_VARIABLE',
          'Missing required template variable: "yyyy".',
        );
      }
      return String(val).trim();
    }
    if (tag === 'program') {
      const val = vars.program;
      if (val === undefined || val === null || String(val).trim().length === 0) {
        throw new AppError(
          400,
          'MISSING_TEMPLATE_VARIABLE',
          'Missing required template variable: "program".',
        );
      }
      return String(val).trim();
    }
    throw new AppError(400, 'MALFORMED_TEMPLATE', `Unexpected token "{${tag}}".`);
  });
}
