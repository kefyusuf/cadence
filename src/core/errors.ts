export const CADENCE_ERROR_CODES = [
  'INVALID_TIME_ZONE',
  'INVALID_INSTANT',
  'INVALID_FREQUENCY',
  'INVALID_INTERVAL',
  'INVALID_COUNT',
  'INVALID_WEEK_DAYS',
  'WEEK_DAYS_REQUIRES_WEEKLY',
  'INVALID_MONTH_DAYS',
  'MONTH_DAYS_REQUIRES_MONTHLY',
  'INVALID_ID',
  'INVALID_CONFIG',
  'INVALID_DELAY',
  'INVALID_LIMIT',
  'INVALID_ESTIMATE',
  'INVALID_STATUS',
  'INVALID_SCHEDULE',
  'INVALID_WORK_ITEM',
  'ABORTED',
  'SEARCH_EXHAUSTED',
  'UNEXPECTED',
] as const;

export type CadenceErrorCode = (typeof CADENCE_ERROR_CODES)[number];

/**
 * A value somebody handed us, spelled the way it reads in a refusal about it: numbers and booleans
 * bare, strings quoted, `null` named as itself rather than as the `object` `typeof` reports for it, and
 * anything else by its type.
 *
 * A message that names the offending value is the only part of a refusal a caller can act on, and the
 * spelling is a rule about wording rather than about a particular field — so it lives beside the codes
 * rather than in whichever layer is currently raising one. Two copies would be free to drift, and the
 * drift would be invisible until someone compared two 400 bodies.
 */
export function shown(raw: unknown): string {
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'string') return `"${raw}"`;

  return raw === null ? 'null' : typeof raw;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(CADENCE_ERROR_CODES);

export class CadenceError extends Error {
  readonly code: CadenceErrorCode;

  constructor(code: CadenceErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = 'CadenceError';
    this.code = code;
  }
}

/**
 * Identity check that survives a duplicated module copy or a worker boundary, where
 * `instanceof CadenceError` fails because the class object is not the same one.
 *
 * A bare object that merely has the right shape is rejected: only real `Error` values
 * carry a stack, and adapters key off `code` after reconstructing the error.
 */
export function isCadenceError(value: unknown): value is CadenceError {
  if (value instanceof CadenceError) return true;
  if (!(value instanceof Error)) return false;

  const candidate = value as Partial<CadenceError>;
  return candidate.name === 'CadenceError' && typeof candidate.code === 'string' && KNOWN_CODES.has(candidate.code);
}
