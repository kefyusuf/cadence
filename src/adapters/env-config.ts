import { parseAppConfig, type AppConfig, type StringRecord } from '../config/app-config.js';
import type { CadenceError } from '../core/errors.js';
import type { Result } from '../core/result.js';

/**
 * The one line that touches `process.env`. It exists so `src/config` can stay pure enough to be
 * gated: the parser holds every rule and takes its input as an argument, while this is the seam the
 * composition root calls — and the seam a test can bypass by handing over a record.
 */
export function loadAppConfig(env: StringRecord = process.env): Result<AppConfig, CadenceError> {
  return parseAppConfig(env);
}
