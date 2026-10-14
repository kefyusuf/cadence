import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import http from 'node:http';
import type { FastifyInstance } from 'fastify';

import { createMemoryStores } from '../src/adapters/memory-store.js';
import type { Recurrence } from '../src/core/recurrence.js';
import { createApp } from '../src/server/create-app.js';
import type { ExportRow } from '../src/server/export-stream.js';

const clock = { now: (): number => Date.UTC(2026, 9, 13, 9, 0) };

/** A rule with no `count`: the only shape that can walk for ever, so the bound has to hold it. */
const daily = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' } as const satisfies Recurrence;
/** A rule the engine can start but not follow past year 9999 — it fails about 12 ms into the walk. */
const pastTheCeiling = { tz: 'Europe/Berlin', dtStart: Date.UTC(9999, 11, 31, 9, 0), freq: 'YEARLY' } as const satisfies Recurrence;

let server: FastifyInstance;
/** The instances that had to be `listen()`ed to, and so have to be closed too. */
const servers: FastifyInstance[] = [];

beforeEach(() => {
  server = createApp({ ...createMemoryStores(), clock, logger: false });
});

afterEach(async () => {
  await server.close();
  for (const listening of servers.splice(0)) await listening.close();
});

async function create(boardId: string, items: readonly Record<string, unknown>[]): Promise<void> {
  const created = await server.inject({ method: 'POST', url: '/boards', body: { id: boardId, name: 'Core platform' } });
  expect(created.statusCode).toBe(201);

  for (const [index, body] of items.entries()) {
    const stored = await server.inject({
      method: 'POST',
      url: `/boards/${boardId}/work-items`,
      body: { id: `wi_item${String(index)}`, title: `Item ${String(index)}`, ...body },
    });
    expect(stored.statusCode).toBe(201);
  }
}

async function get(url: string): Promise<{ status: number; type: string | undefined; body: string; json: unknown }> {
  const response = await server.inject({ method: 'GET', url });
  const type = response.headers['content-type'];

  // Only a JSON body is read as JSON: an NDJSON body has one document per line, and `response.json()`
  // on it fails on the second line rather than telling the test what arrived.
  return {
    status: response.statusCode,
    type,
    body: response.body,
    json: type?.startsWith('application/json') === true ? response.json() : undefined,
  };
}

function rowsOf(body: string): ExportRow[] {
  return body
    .split('\n')
    .filter((line: string): boolean => line.length > 0)
    .map((line: string): ExportRow => JSON.parse(line) as ExportRow);
}

function kinds(body: string): string[] {
  return rowsOf(body).map((r) => r.kind);
}

/** Every refusal has the same envelope, so there is one way to read a failure. */
function failure(json: unknown): { code: string; message: string } {
  const error = (json as { readonly error?: { code: string; message: string } }).error;
  if (error === undefined) throw new Error(`response carries no error object: ${JSON.stringify(json)}`);

  return error;
}

describe('GET /boards/:id/export', () => {
  it('answers with one NDJSON line per row and a content type that says so', async () => {
    await create('bd_core', [{ status: 'ready' }, { status: 'done', schedule: daily }]);
    const { status, type, body } = await get('/boards/bd_core/export?occurrences=2');

    expect(status).toBe(200);
    expect(type).toBe('application/x-ndjson; charset=utf-8');
    expect(kinds(body)).toEqual(['item', 'item', 'occurrence', 'occurrence', 'done']);
    // Every line stands on its own, and the last one is a line: a reader that stops anywhere is holding
    // complete rows rather than half of one.
    const lines = body.split('\n');
    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) {
      expect(JSON.parse(line)).toBeInstanceOf(Object);
    }
  });

  it('refuses a board nobody stored with a status, not with a truncated body', async () => {
    await create('bd_core', [{ status: 'ready' }]);
    const { status, json } = await get('/boards/bd_growth/export');

    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'BOARD_NOT_FOUND', message: 'no board with id "bd_growth"' } });
  });

  it('walks no further than the bound the caller gave, on a rule that has no end', async () => {
    await create('bd_core', [{ schedule: daily }]);
    const { body } = await get('/boards/bd_core/export?occurrences=4');

    expect(rowsOf(body).filter((r) => r.kind === 'occurrence')).toHaveLength(4);
    expect(rowsOf(body).at(-1)).toEqual({ kind: 'done', items: 1, occurrences: 4, bound: 4 });
  });

  it('takes the default bound when the caller names none', async () => {
    await create('bd_core', [{ schedule: daily }]);
    const { body } = await get('/boards/bd_core/export');

    expect(rowsOf(body).filter((r) => r.kind === 'occurrence')).toHaveLength(20);
  });

  it('exports an empty board as a body that only says it is done', async () => {
    await create('bd_core', []);
    const { body } = await get('/boards/bd_core/export?occurrences=5');

    expect(rowsOf(body)).toEqual([{ kind: 'done', items: 0, occurrences: 0, bound: 5 }]);
  });

  describe('rejects a bound that is not a whole number in range', () => {
    const bad = [
      ['abc', 'must be a whole number'],
      ['', 'must be a whole number'],
      ['-1', 'must be a whole number'],
      ['2.5', 'must be a whole number'],
      ['1e3', 'must be a whole number'],
      ['1001', 'at most 1000'],
    ] as const;

    for (const [raw, because] of bad) {
      it(`refuses occurrences=${raw || '""'} because it ${because}`, async () => {
        await create('bd_core', [{ schedule: daily }]);
        const { status, json } = await get(`/boards/bd_core/export?occurrences=${raw}`);

        expect(status).toBe(400);
        expect(failure(json).code).toBe('INVALID_OCCURRENCES');
        expect(failure(json).message).toContain(because);
      });
    }

    it('refuses the same key twice rather than picking one silently', async () => {
      await create('bd_core', [{ schedule: daily }]);
      const { status, json } = await get('/boards/bd_core/export?occurrences=1&occurrences=2');

      expect(status).toBe(400);
      expect(failure(json).code).toBe('INVALID_OCCURRENCES');
    });
  });

  it('reads the request before the store, so an impossible bound is a 400 even for a board nobody stored', async () => {
    // The door owns what a caller may ask for (ADR 0008), so the bound is refused before the board is
    // loaded — the same precedence a work-item POST gives, where a malformed body beats a missing board.
    const { status, json } = await get('/boards/bd_growth/export?occurrences=1001');

    expect(status).toBe(400);
    expect(failure(json).code).toBe('INVALID_OCCURRENCES');
  });

  it('keeps an unscheduled item to its header row', async () => {
    await create('bd_core', [{ status: 'ready' }, { status: 'blocked', schedule: null }]);
    const { body } = await get('/boards/bd_core/export?occurrences=3');

    expect(kinds(body)).toEqual(['item', 'item', 'done']);
  });
});

describe('the export over a real socket', () => {
  /**
   * Read a whole body over a real socket, line by line, and report the framing with it. A stream that
   * fails or is abandoned has no length to point at, so the rows and whatever `tail` is left after the
   * last newline are the only observables — and `close` is the one event both shapes reach.
   */
  function pull(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; rows: ExportRow[]; tail: string; error: string | null }> {
    return new Promise((resolve) => {
      const rows: ExportRow[] = [];
      let pending = '';
      let error: string | null = null;

      const request = http.get(url, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line.length > 0) rows.push(JSON.parse(line) as ExportRow);
          }
        });
        response.on('error', (cause: Error) => {
          error = 'code' in cause ? String(cause.code) : cause.message;
        });
        response.on('close', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, rows, tail: pending, error });
        });
      });
      request.on('error', () => {});
    });
  }

  /** A request that leaves mid-body, resolved with whatever bytes it managed to read. */
  function readThenLeave(url: string, keepBytes: number): Promise<{ status: number; bytes: number; head: string; error: string | null }> {
    return new Promise((resolve) => {
      const req = http.get(url, (response) => {
        let body = '';
        let error: string | null = null;
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length >= keepBytes) req.destroy();
        });
        response.on('error', (cause: Error) => {
          error = 'code' in cause ? String(cause.code) : cause.message;
        });
        response.on('close', () => {
          resolve({ status: response.statusCode ?? 0, bytes: body.length, head: body.slice(0, keepBytes), error });
        });
      });
    });
  }

  async function boardWith(items: number, occurrences: number): Promise<string> {
    const listening = createApp({ ...createMemoryStores(), clock, logger: false });
    const address = await listening.listen({ host: '127.0.0.1', port: 0 });
    const created = await listening.inject({ method: 'POST', url: '/boards', body: { id: 'bd_core', name: 'Core' } });
    expect(created.statusCode).toBe(201);

    for (let index = 0; index < items; index += 1) {
      const stored = await listening.inject({
        method: 'POST',
        url: '/boards/bd_core/work-items',
        body: { id: `wi_${String(index)}`, title: `Item ${String(index)}`, schedule: daily },
      });
      expect(stored.statusCode).toBe(201);
    }
    servers.push(listening);

    return `${address}/boards/bd_core/export?occurrences=${String(occurrences)}`;
  }

  it('is chunked, promises no length, and gives the whole body to a reader that stays', async () => {
    const url = await boardWith(40, 200);
    const read = await pull(url);

    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(read.headers['transfer-encoding']).toBe('chunked');
    // No declared length, because none can be: the body is produced as it goes.
    expect(read.headers['content-length']).toBeUndefined();
    expect(read.error).toBeNull();
    // A reader that stays gets whole rows only — the tail after the last newline is empty.
    expect(read.tail).toBe('');
    expect(read.rows.filter((r) => r.kind === 'occurrence')).toHaveLength(40 * 200);
    expect(read.rows.at(-1)).toEqual({ kind: 'done', items: 40, occurrences: 8000, bound: 200 });
  });

  it('ends where the connection ended, and stays a server afterwards', async () => {
    const url = await boardWith(40, 200);

    // Bigger than the socket buffer on purpose: the client has to be able to leave while rows are still
    // on their way, which is the case the fast producer in ADR 0010's probe hid.
    const left = await readThenLeave(url, 2000);
    expect(left.status).toBe(200);
    expect(left.bytes).toBeGreaterThanOrEqual(2000);
    expect(left.error).not.toBeNull();
    expect(left.head.startsWith('{"kind":"item"')).toBe(true);

    const alive = await fetch(`${url.split('/boards')[0] ?? ''}/healthz`);
    expect(await alive.json()).toEqual({ ok: true });
  });

  it('answers a walk that fails mid-body with the status it already sent and no done row', async () => {
    const listening = createApp({ ...createMemoryStores(), clock, logger: false });
    const address = await listening.listen({ host: '127.0.0.1', port: 0 });
    const created = await listening.inject({ method: 'POST', url: '/boards', body: { id: 'bd_core', name: 'Core' } });
    expect(created.statusCode).toBe(201);
    const stored = await listening.inject({
      method: 'POST',
      url: '/boards/bd_core/work-items',
      body: { id: 'wi_ceiling', title: 'Into the ceiling', schedule: pastTheCeiling },
    });
    expect(stored.statusCode).toBe(201);
    servers.push(listening);

    const read = await pull(`${address}/boards/bd_core/export?occurrences=10`);

    // The refusal arrives after the header row and the one occurrence the engine did produce. It cannot
    // turn into a 500: the status line went out with the first chunk.
    expect(read.status).toBe(200);
    expect(read.rows.map((r) => r.kind)).toEqual(['item', 'occurrence']);
    expect(read.error).not.toBeNull();
    // The reset arrived after a whole line, which is the only way a reader knows it has usable rows.
    expect(read.tail).toBe('');

    const alive = await fetch(`${address}/healthz`);
    expect(await alive.json()).toEqual({ ok: true });
  });
});
