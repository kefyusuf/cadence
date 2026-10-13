import { CadenceError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type NodeEnvironment = 'development' | 'production' | 'test';

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly environment: NodeEnvironment;
}

/** What the platform hands us: strings nobody type-checked, including the ones that are missing. */
export type StringRecord = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const ENVIRONMENTS: readonly NodeEnvironment[] = ['development', 'production', 'test'];

const DEFAULTS: AppConfig = {
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'info',
  environment: 'development',
};

const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PORT_PATTERN = /^\d+$/;
const MAX_HOST_LENGTH = 253;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Turns the environment into values the rest of the server can trust, or refuses with every problem
 * at once. Nothing here reads `process`: the caller hands over the record, so the rules are the same
 * whether they are being tested or booting a container.
 *
 * The defaults are the safe side of a mistake — an unset `HOST` binds loopback rather than every
 * interface, because the failure mode of a forgotten variable should be "cannot reach it", not
 * "reachable by everyone".
 */
export function parseAppConfig(values: StringRecord): Result<AppConfig, CadenceError> {
  const problems: string[] = [];

  const config: AppConfig = {
    host: readHost(readSetting(values, 'HOST'), problems),
    port: readPort(readSetting(values, 'PORT'), problems),
    logLevel: readEnum(readSetting(values, 'LOG_LEVEL'), LOG_LEVELS, DEFAULTS.logLevel, 'LOG_LEVEL', problems),
    environment: readEnum(readSetting(values, 'NODE_ENV'), ENVIRONMENTS, DEFAULTS.environment, 'NODE_ENV', problems),
  };

  if (problems.length > 0) {
    return err(new CadenceError('INVALID_CONFIG', `config refused: ${problems.join('; ')}`));
  }

  return ok(config);
}

/** Reads one variable, treating an empty value as absent: `HOST=` is what a compose file or a shell produces. */
function readSetting(values: StringRecord, key: string): string | undefined {
  const raw = values[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

function readHost(raw: string | undefined, problems: string[]): string {
  if (raw === undefined) return DEFAULTS.host;
  if (!HOST_PATTERN.test(raw)) {
    problems.push(`HOST must be a bare hostname or IP address, got "${raw}"`);
    return DEFAULTS.host;
  }
  if (raw.length > MAX_HOST_LENGTH) {
    problems.push(`HOST must be at most ${String(MAX_HOST_LENGTH)} characters, got ${String(raw.length)}`);
    return DEFAULTS.host;
  }
  // One colon is `localhost:3000` glued together; an IPv6 literal always has at least two.
  if (raw.split(':').length - 1 === 1) {
    problems.push(`HOST looks like host:port — set PORT separately, got "${raw}"`);
    return DEFAULTS.host;
  }

  return raw;
}

function readPort(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULTS.port;
  if (!PORT_PATTERN.test(raw)) {
    problems.push(`PORT must be a plain decimal number, got "${raw}"`);
    return DEFAULTS.port;
  }

  const port = Number(raw);
  if (port < MIN_PORT || port > MAX_PORT) {
    problems.push(`PORT must be between ${String(MIN_PORT)} and ${String(MAX_PORT)}, got "${raw}"`);
    return DEFAULTS.port;
  }

  return port;
}

function readEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
  problems: string[],
): T {
  if (raw === undefined) return fallback;

  const wanted = raw.toLowerCase();
  const match = allowed.find((candidate: T): boolean => candidate === wanted);
  if (match === undefined) {
    problems.push(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
    return fallback;
  }

  return match;
}
