import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const notes = [];
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, run) {
  try {
    notes.push(`${name} ${String(await run())}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const cadence = await import('cadence');
const domain = await import('cadence/domain');
const scheduler = await import('cadence/scheduler');

const second = Math.floor(Date.now() / 1000) * 1000;

await step('node', () => {
  const engines = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node;
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} does not satisfy ${engines}`);
  return `v${process.versions.node}`;
});

await step('image', () => {
  assert(process.env.NODE_ENV === 'production', `NODE_ENV is ${String(process.env.NODE_ENV)}`);
  const tooling = ['typescript', 'vitest', 'eslint', 'dependency-cruiser'].filter((name) =>
    existsSync(path.join(root, 'node_modules', name)),
  );
  assert(tooling.length === 0, `dev tooling in the image: ${tooling.join(', ')}`);
  const modules = path.join(root, 'node_modules');
  // npm ci --omit=dev may not create node_modules at all when nothing is left to install.
  const installed = existsSync(modules)
    ? readdirSync(modules, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;
  return `NODE_ENV=production, ${String(installed)} packages in node_modules`;
});

await step('entry points', () => {
  for (const name of ['nextOccurrence', 'createSeriesCursor', 'isCadenceError']) {
    assert(typeof cadence[name] === 'function', `cadence.${name} is not a function`);
  }
  assert(typeof domain.parseId === 'function', 'cadence/domain has no parseId');
  assert(typeof scheduler.runSeries === 'function' && typeof scheduler.sleep === 'function', 'cadence/scheduler is incomplete');
  return 'cadence, cadence/domain, cadence/scheduler';
});

await step('DST gap', () => {
  const dtStart = Date.UTC(2026, 2, 28, 1, 30);
  const occ = cadence.nextOccurrence({ tz: 'Europe/Berlin', dtStart, freq: 'DAILY' }, dtStart);
  assert(occ !== null && occ.instant === Date.UTC(2026, 2, 29, 1, 0), 'wrong instant for the spring-forward gap');
  assert(occ.disambiguation === 'gap-roll-forward', `wrong disambiguation: ${String(occ.disambiguation)}`);
  return new Date(occ.instant).toISOString();
});

await step('real wait', async () => {
  const target = second + 1000;
  const cursor = cadence.createSeriesCursor({ tz: 'UTC', dtStart: target, freq: 'DAILY' });
  const started = Date.now();
  let deliveredAt = 0;
  const summary = await scheduler.runSeries(cursor, {
    clock: { now: () => Date.now() },
    sleep: scheduler.sleep,
    notify: () => {
      deliveredAt = Date.now();
    },
    limit: 1,
  });
  assert(summary.endedBy === 'limit', `run ended by ${summary.endedBy}`);
  // The contract is wall-clock, not duration: the wait is only the lead that was left when the
  // run started, so asserting a full second here would be wrong.
  assert(deliveredAt >= target, `delivered ${String(target - deliveredAt)} ms before its instant`);
  return `waited ${String(deliveredAt - started)} ms, delivered at ${new Date(deliveredAt).toISOString()}`;
});

await step('real abort', async () => {
  const cursor = cadence.createSeriesCursor({ tz: 'UTC', dtStart: second + 3_600_000, freq: 'DAILY' });
  const controller = new AbortController();
  setTimeout(() => controller.abort('selfcheck cancels a long wait'), 20);
  const summary = await scheduler.runSeries(cursor, {
    clock: { now: () => Date.now() },
    sleep: scheduler.sleep,
    notify: () => {
      throw new Error('an aborted run delivered an occurrence');
    },
    signal: controller.signal,
  });
  assert(summary.endedBy === 'aborted', `run ended by ${summary.endedBy}`);
  assert(summary.delivered === 0, `aborted run delivered ${String(summary.delivered)}`);
  return 'endedBy aborted, 0 delivered';
});

if (failures.length > 0) {
  console.error(`selfcheck failed (${String(failures.length)}): ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log(`selfcheck ok: ${notes.join(' | ')}`);
}
