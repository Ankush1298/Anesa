import { describe, expect, it } from 'vitest';
import { formatSequence } from '../../src/shared/numbering/formatter.js';
import { AppError } from '../../src/shared/errors/http-errors.js';

describe('formatSequence', () => {
  describe('successful formatting', () => {
    it('formats template with yyyy, program, and seq tokens', () => {
      const result = formatSequence(
        '{yyyy}{program}{seq:4}',
        { yyyy: '2026', program: 'BTECH' },
        1n,
      );
      expect(result).toBe('2026BTECH0001');
    });

    it('formats template with punctuation and literal characters', () => {
      const result = formatSequence(
        'ADM/{yyyy}/{program}-{seq:5}',
        { yyyy: 2026, program: 'CS' },
        42n,
      );
      expect(result).toBe('ADM/2026/CS-00042');
    });

    it('supports wide sequence widths and large bigints up to declared width', () => {
      const result = formatSequence('{seq:16}', {}, 9007199254740992n);
      expect(result).toBe('9007199254740992');
    });

    it('supports exact boundary width values', () => {
      expect(formatSequence('{seq:4}', {}, 9999n)).toBe('9999');
      expect(formatSequence('{seq:1}', {}, 9n)).toBe('9');
      expect(formatSequence('{seq:1}', {}, 0n)).toBe('0');
    });

    it('trims string variables', () => {
      const result = formatSequence(
        '{yyyy}-{program}-{seq:3}',
        { yyyy: '  2026  ', program: '  MECH  ' },
        7n,
      );
      expect(result).toBe('2026-MECH-007');
    });
  });

  describe('sequence overflow protection', () => {
    it('throws 409 SEQUENCE_OVERFLOW when sequence digits exceed declared width', () => {
      try {
        formatSequence('{seq:4}', {}, 10000n);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.statusCode).toBe(409);
        expect(appErr.code).toBe('SEQUENCE_OVERFLOW');
        expect(appErr.message).toMatch(/exceeds template width of 4 digits/);
      }
    });

    it('throws 409 on boundary overflow', () => {
      expect(() => formatSequence('{seq:1}', {}, 10n)).toThrowError(
        expect.objectContaining({
          statusCode: 409,
          code: 'SEQUENCE_OVERFLOW',
        }),
      );
    });
  });

  describe('malformed template detection', () => {
    it('rejects template without {seq:N} token', () => {
      expect(() =>
        formatSequence('{yyyy}{program}', { yyyy: '2026', program: 'CS' }, 1n),
      ).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MALFORMED_TEMPLATE',
          message: 'Template must contain a "{seq:N}" token.',
        }),
      );
    });

    it('rejects template with multiple {seq:N} tokens', () => {
      expect(() => formatSequence('{seq:4}-{seq:4}', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MALFORMED_TEMPLATE',
          message: 'Template cannot contain multiple "{seq:N}" tokens.',
        }),
      );
    });

    it('rejects unclosed opening brace', () => {
      expect(() => formatSequence('{yyyy{seq:4}', { yyyy: '2026' }, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MALFORMED_TEMPLATE',
        }),
      );
    });

    it('rejects unmatched closing brace', () => {
      expect(() => formatSequence('yyyy}{seq:4}', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MALFORMED_TEMPLATE',
        }),
      );
    });

    it('rejects empty token {}', () => {
      expect(() => formatSequence('{}{seq:4}', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MALFORMED_TEMPLATE',
          message: 'Template contains empty token "{}".',
        }),
      );
    });

    it('rejects unknown tokens (such as unapproved {yy} or {campus})', () => {
      expect(() => formatSequence('{yy}{seq:4}', {}, 1n)).toThrow(
        /Unknown template token "\{yy\}"/,
      );

      expect(() => formatSequence('{campus}{seq:4}', {}, 1n)).toThrow(
        /Unknown template token "\{campus\}"/,
      );
    });

    it.each(['{seq:0}', '{seq:-1}', '{seq:abc}', '{seq:}', '{seq:04}', '{seq:21}'])(
      'rejects invalid sequence token %s',
      (invalidToken) => {
        expect(() => formatSequence(invalidToken, {}, 1n)).toThrowError(
          expect.objectContaining({
            statusCode: 400,
            code: 'MALFORMED_TEMPLATE',
          }),
        );
      },
    );
  });

  describe('missing variable detection', () => {
    it('throws when yyyy is missing', () => {
      expect(() => formatSequence('{yyyy}{seq:4}', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MISSING_TEMPLATE_VARIABLE',
          message: 'Missing required template variable: "yyyy".',
        }),
      );
    });

    it('throws when program is missing', () => {
      expect(() => formatSequence('{program}{seq:4}', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MISSING_TEMPLATE_VARIABLE',
          message: 'Missing required template variable: "program".',
        }),
      );
    });

    it('throws when variable is empty string', () => {
      expect(() => formatSequence('{program}{seq:4}', { program: '   ' }, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'MISSING_TEMPLATE_VARIABLE',
        }),
      );
    });
  });

  describe('input type validation', () => {
    it('rejects empty template', () => {
      expect(() => formatSequence('  ', {}, 1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        }),
      );
    });

    it('rejects negative sequence value', () => {
      expect(() => formatSequence('{seq:4}', {}, -1n)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Sequence value cannot be negative.',
        }),
      );
    });

    it('rejects non-bigint sequence value', () => {
      // @ts-expect-error testing runtime check
      expect(() => formatSequence('{seq:4}', {}, 42)).toThrowError(
        expect.objectContaining({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Sequence value must be a bigint.',
        }),
      );
    });
  });
});
