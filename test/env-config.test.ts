import { describe, expect, it } from 'vitest';

import { isCadenceError } from '../src/core/errors.js';
import { parseAppConfig, type AppConfig, type StringRecord } from '../src/config/app-config.js';
import { loadAppConfig } from '../src/adapters/env-config.js';

const MANAGED = ['HOST', 'PORT', 'LOG_LEVEL', 'NODE_ENV'];

function withEnv(values: StringRecord, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of MANAGED) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function value(result: ReturnType<typeof loadAppConfig>): AppConfig {
  if (!result.ok) throw new Error(`config refused: ${result.error.message}`);
  return result.value;
}

describe('loadAppConfig', () => {
  it('reads the ambient environment when nothing is handed to it', () => {
    withEnv({ HOST: '0.0.0.0', PORT: '4321', LOG_LEVEL: 'warn', NODE_ENV: 'production' }, () => {
      expect(value(loadAppConfig())).toEqual({
        host: '0.0.0.0',
        port: 4321,
        logLevel: 'warn',
        environment: 'production',
      });
    });
  });

  it('takes the record it is given instead of the environment', () => {
    withEnv({ PORT: '4321' }, () => {
      expect(value(loadAppConfig({})).port).toBe(3000);
    });
  });

  it('applies the same rules to an empty value as to an absent one', () => {
    withEnv({ PORT: '' }, () => {
      expect(value(loadAppConfig()).port).toBe(3000);
    });
  });

  it('shares one set of rules with the parser, not a second copy', () => {
    const record: StringRecord = { HOST: 'localhost', PORT: '8080', LOG_LEVEL: 'TRACE', NODE_ENV: 'Test' };

    expect(loadAppConfig(record)).toEqual(parseAppConfig(record));
  });

  it('keeps a refusal a CadenceError the composition root can branch on', () => {
    withEnv({ LOG_LEVEL: 'verbose' }, () => {
      const refusal = loadAppConfig();
      if (refusal.ok) throw new Error('expected the environment to be refused');

      expect(isCadenceError(refusal.error)).toBe(true);
      expect(refusal.error.code).toBe('INVALID_CONFIG');
      expect(refusal.error.message).toContain('LOG_LEVEL');
    });
  });

  it('returns rather than throws on an environment nobody checked', () => {
    withEnv({ PORT: 'not a port' }, () => {
      expect(() => loadAppConfig()).not.toThrow();
      expect(loadAppConfig().ok).toBe(false);
    });
  });
});
