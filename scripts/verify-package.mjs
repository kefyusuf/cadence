#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDir);
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const results = [];

function record(name, run) {
  try {
    results.push({ name, ok: true, detail: run() });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function runNode(inputType, code) {
  try {
    return execFileSync(process.execPath, [`--input-type=${inputType}`, '-e', code], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const line = stderr.split('\n').find((candidate) => candidate.trim().length > 0) ?? String(error);
    throw new Error(line.trim(), { cause: error });
  }
}

const ASSERT_CORE = `
  const dtStart = Date.UTC(2026, 0, 6, 9, 0);
  if (typeof cadenceApi.nextOccurrence !== 'function') throw new Error('nextOccurrence is missing');
  const next = cadenceApi.nextOccurrence({ tz: 'UTC', dtStart, freq: 'DAILY' }, dtStart);
  if (next.instant !== Date.UTC(2026, 0, 7, 9, 0)) throw new Error('wrong instant: ' + String(next.instant));
  if (!cadenceApi.CADENCE_ERROR_CODES.includes('INVALID_ID')) throw new Error('INVALID_ID is not exported');
  const bad = cadenceApi.tryNextOccurrence({ tz: 'Mars/Olympus_Mons', dtStart, freq: 'DAILY' }, dtStart);
  if (bad.ok) throw new Error('tryNextOccurrence did not report the bad time zone');
  if (!cadenceApi.isCadenceError(bad.error)) throw new Error('isCadenceError rejected its own error');
`;

record('esm: import "cadence"', () =>
  runNode('module', `const cadenceApi = await import('cadence'); ${ASSERT_CORE} console.log('ok, next ' + new Date(next.instant).toISOString())`),
);

record('cjs: require("cadence")', () =>
  runNode('commonjs', `const cadenceApi = require('cadence'); ${ASSERT_CORE} console.log('ok on ' + process.version)`),
);

record('esm: import "cadence/domain"', () =>
  runNode(
    'module',
    `const { parseId } = await import('cadence/domain');
     if (!parseId('board', 'bd_1').ok) throw new Error('a valid id was rejected');
     const bad = parseId('board', 'iş_1');
     if (bad.ok) throw new Error('a non-ASCII id was accepted');
     if (bad.error.code !== 'INVALID_ID') throw new Error('unexpected code: ' + String(bad.error.code));
     console.log('ok')`,
  ),
);

record('cjs: require("cadence/domain")', () =>
  runNode(
    'commonjs',
    `const { parseId } = require('cadence/domain');
     if (!parseId('member', 'mb_2').ok) throw new Error('a valid id was rejected');
     console.log('ok on ' + process.version)`,
  ),
);

record('esm: import "cadence/scheduler"', () =>
  runNode(
    'module',
    `const { createSeriesCursor } = await import('cadence');
     const { runSeries, sleep } = await import('cadence/scheduler');
     if (typeof sleep !== 'function') throw new Error('sleep is missing');
     const cursor = createSeriesCursor({ tz: 'UTC', dtStart: 0, freq: 'DAILY' });
     const waits = [];
     const summary = await runSeries(cursor, {
       clock: { now: () => 0 },
       sleep: async (ms) => { waits.push(ms); },
       notify: () => undefined,
       limit: 2,
     });
     if (summary.delivered !== 2 || summary.endedBy !== 'limit') throw new Error('unexpected summary: ' + JSON.stringify(summary));
     if (waits.join(',') !== '0,86400000') throw new Error('unexpected waits: ' + waits.join(','));
     console.log('ok, 2 delivered after waits of 0 and 86400000 ms')`,
  ),
);

record('cjs: require("cadence/scheduler")', () =>
  runNode(
    'commonjs',
    `(async () => {
       const { createSeriesCursor } = require('cadence');
       const { runSeries } = require('cadence/scheduler');
       const cursor = createSeriesCursor({ tz: 'UTC', dtStart: 0, freq: 'WEEKLY', byWeekDay: ['MO'] });
       const indexes = [];
       const summary = await runSeries(cursor, {
         clock: { now: () => 0 },
         sleep: async () => undefined,
         notify: (occurrence) => { indexes.push(occurrence.index); },
         limit: 3,
       });
       if (indexes.join(',') !== '0,1,2') throw new Error('unexpected indexes: ' + indexes.join(','));
       console.log('ok on ' + process.version);
     })()`,
  ),
);

record('deep import "cadence/src/..." is blocked', () =>
  runNode(
    'module',
    `let code = 'no error';
     try { await import('cadence/src/core/recurrence.js'); } catch (error) { code = error.code }
     if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw new Error('deep import behaved as: ' + code);
     console.log('ok, ERR_PACKAGE_PATH_NOT_EXPORTED')`,
  ),
);

// src/adapters is repo-internal: it is compiled into dist and travels in the tarball, but the
// exports map has no key for it, so a consumer cannot reach it without a decision being made.
record('the internal adapter layer is not importable', () =>
  runNode(
    'module',
    `let code = 'no error';
     try { await import('cadence/adapters'); } catch (error) { code = error.code }
     if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw new Error('cadence/adapters behaved as: ' + code);
     console.log('ok, ERR_PACKAGE_PATH_NOT_EXPORTED')`,
  ),
);

record('every exports target exists', () => {
  if (!existsSync(path.join(root, 'dist'))) throw new Error('dist/ is missing, run npm run build first');

  const targets = [];
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    if (typeof value === 'string') targets.push([subpath, value]);
    else for (const [condition, target] of Object.entries(value)) targets.push([`${subpath} -> ${condition}`, target]);
  }

  const missing = targets.filter(([, target]) => !existsSync(path.join(root, target))).map(([name]) => name);
  if (missing.length > 0) throw new Error('missing targets: ' + missing.join(', '));
  return `${String(targets.length)} targets resolve on disk`;
});

record('tarball ships dist and hides src', () => {
  const packed = spawnSync('npm pack --dry-run --json', { cwd: root, encoding: 'utf8', shell: true });
  if (packed.status !== 0) throw new Error((packed.stderr || packed.stdout || 'npm pack failed').trim().split('\n')[0]);

  const [manifest] = JSON.parse(packed.stdout);
  const names = manifest.files.map((entry) => entry.path);
  const problems = [];
  for (const required of ['dist/core/index.js', 'dist/core/index.d.ts', 'dist/domain/index.js']) {
    if (!names.includes(required)) problems.push(required + ' is not packed');
  }
  if (names.some((name) => name.startsWith('src/'))) problems.push('src/ leaked into the tarball');
  if (names.some((name) => name.startsWith('test/'))) problems.push('test/ leaked into the tarball');
  if (problems.length > 0) throw new Error(problems.join('; '));
  return `${String(names.length)} files, ${String(manifest.size)} bytes`;
});

record('consumer typechecks against dist/*.d.ts', () => {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(
      process.execPath,
      [tsc, '--noEmit', '--strict', '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'scripts/typecheck-consumer.ts'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
    throw new Error(stdout.split('\n').slice(0, 3).join(' | ') || `tsc exited with ${String(error.status)}`, {
      cause: error,
    });
  }
  return 'cadence and cadence/domain both resolve';
});

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  ${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${String(failed.length)} of ${String(results.length)} package checks failed`);
  process.exitCode = 1;
}
