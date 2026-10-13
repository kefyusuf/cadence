import { describe, expect, it } from 'vitest';

import { isCadenceError } from '../src/core/errors.js';
import { parseAppConfig, type AppConfig, type StringRecord } from '../src/config/app-config.js';

function config(values: StringRecord): AppConfig {
  const parsed = parseAppConfig(values);
  if (!parsed.ok) throw new Error(`config refused: ${parsed.error.message}`);
  return parsed.value;
}

function message(values: StringRecord): string {
  const parsed = parseAppConfig(values);
  if (parsed.ok) throw new Error('expected the config to be refused');
  return parsed.error.message;
}

describe('parseAppConfig', () => {
  it('fills every absent value with a default that is safe to bind to', () => {
    expect(config({})).toEqual({ host: '127.0.0.1', port: 3000, logLevel: 'info', environment: 'development' });
  });

  it('exposes exactly the four settings the server is built from', () => {
    expect(Object.keys(config({})).sort()).toEqual(['environment', 'host', 'logLevel', 'port']);
  });

  it('reads all four variables', () => {
    const value = config({
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    });

    expect(value).toEqual({ host: '0.0.0.0', port: 8080, logLevel: 'debug', environment: 'production' });
    expect(typeof value.port).toBe('number');
  });

  it('treats an empty value as absent, because shells and compose produce them', () => {
    for (const key of ['HOST', 'PORT', 'LOG_LEVEL', 'NODE_ENV']) {
      expect(config({ [key]: '' })).toEqual(config({}));
    }
  });

  it('ignores variables it does not know', () => {
    expect(config({ FOO: 'bar', PATH: '/usr/bin' })).toEqual(config({}));
  });

  it('accepts the addresses a bind call can take without resolving them', () => {
    for (const host of ['localhost', '0.0.0.0', '127.0.0.1', '::1', 'cadence.internal']) {
      expect(config({ HOST: host }).host).toBe(host);
    }
  });

  it('refuses a host that cannot be an address', () => {
    for (const host of ['exa mple.com', '0.0.0.0/0', 'http://localhost', 'host:8080', '  ', 'x'.repeat(300)]) {
      expect(message({ HOST: host }), host).toContain('HOST');
    }
  });

  it('points a host:port mistake at the variable that should have been used', () => {
    expect(message({ HOST: 'localhost:3000' })).toContain('set PORT separately');
  });

  it('keeps a leading zero rather than guessing an octal', () => {
    expect(config({ PORT: '03000' }).port).toBe(3000);
  });

  it('refuses a port that is not a plain decimal number', () => {
    for (const port of ['abc', '80.5', '+80', '-1', '3_000', '0x50', ' 80', '80 ']) {
      expect(message({ PORT: port }), port).toContain('PORT');
    }
  });

  it('refuses a port outside the bindable range but not its edges', () => {
    for (const port of ['0', '65536', '70000', '999999999999']) {
      expect(message({ PORT: port }), port).toContain('PORT');
    }
    expect(config({ PORT: '65535' }).port).toBe(65535);
    expect(config({ PORT: '1' }).port).toBe(1);
  });

  it('normalises the log level and refuses one that is not a level', () => {
    for (const level of ['info', 'DEBUG', 'Trace', 'fatal', 'warn', 'error']) {
      expect(config({ LOG_LEVEL: level }).logLevel).toBe(level.toLowerCase());
    }
    for (const level of ['verbose', 'silent', 'info ', 'notice']) {
      expect(message({ LOG_LEVEL: level }), level).toContain('LOG_LEVEL');
    }
  });

  it('normalises the environment and refuses one we have no behaviour for', () => {
    for (const environment of ['production', 'Production', 'TEST', 'development']) {
      expect(config({ NODE_ENV: environment }).environment).toBe(environment.toLowerCase());
    }
    for (const environment of ['prod', 'staging', 'dev']) {
      expect(message({ NODE_ENV: environment }), environment).toContain('NODE_ENV');
    }
  });

  it('names every problem in one refusal instead of one per run', () => {
    const refusal = parseAppConfig({ PORT: 'abc', LOG_LEVEL: 'verbose', NODE_ENV: 'staging', HOST: 'a b' });
    if (refusal.ok) throw new Error('expected the config to be refused');

    expect(refusal.error.message).toContain('PORT');
    expect(refusal.error.message).toContain('LOG_LEVEL');
    expect(refusal.error.message).toContain('NODE_ENV');
    expect(refusal.error.message).toContain('HOST');
  });

  it('refuses with a code the rest of the system can branch on', () => {
    const refusal = parseAppConfig({ PORT: 'abc' });
    if (refusal.ok) throw new Error('expected the config to be refused');

    expect(isCadenceError(refusal.error)).toBe(true);
    expect(refusal.error.code).toBe('INVALID_CONFIG');
  });

  it('never throws, whatever the environment handed it', () => {
    const garbage: StringRecord = { PORT: '\u0000', HOST: 'x'.repeat(300), LOG_LEVEL: '🔥', NODE_ENV: '' };

    expect(() => parseAppConfig(garbage)).not.toThrow();
    expect(message(garbage)).toContain('PORT');
    expect(() => parseAppConfig({})).not.toThrow();
  });

  it('reads the record it is given and nothing from the process', () => {
    const previous = process.env.PORT;
    process.env.PORT = '4321';
    try {
      expect(config({}).port).toBe(3000);
    } finally {
      if (previous === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = previous;
      }
    }
  });
});
