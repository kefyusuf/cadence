export type CadenceErrorCode =
  | 'INVALID_TIME_ZONE'
  | 'INVALID_INSTANT'
  | 'INVALID_INTERVAL'
  | 'INVALID_COUNT'
  | 'INVALID_WEEK_DAYS'
  | 'WEEK_DAYS_REQUIRES_WEEKLY'
  | 'INVALID_MONTH_DAYS'
  | 'MONTH_DAYS_REQUIRES_MONTHLY'
  | 'SEARCH_EXHAUSTED';

export class CadenceError extends Error {
  readonly code: CadenceErrorCode;

  constructor(code: CadenceErrorCode, message: string) {
    super(message);
    this.name = 'CadenceError';
    this.code = code;
  }
}
