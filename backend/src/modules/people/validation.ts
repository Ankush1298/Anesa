import { AppError } from '../../shared/errors/http-errors.js';

/** Shared field validation for the people-record modules (employees, students). */

export function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

/** A real calendar date, YYYY-MM-DD, within 1900..2200 (the database also stores a `date`). */
export function parseDate(value: unknown, field: string): string {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    const real = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
    if (real && y >= 1900 && y <= 2200) return value as string;
  }
  throw invalid(`${field} must be a real calendar date (YYYY-MM-DD) between 1900 and 2200.`);
}

/** A2 (doc 02 §4.1): a reason is mandatory on every mutation. */
export function parseReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 5 || reason.length > 500)
    throw invalid('Reason must be 5 to 500 characters.');
  return reason;
}
