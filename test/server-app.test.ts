import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Board, WorkItem } from '../src/domain/model.js';
import type { BoardStore } from '../src/domain/ports.js';
import { createMemoryStores } from '../src/adapters/memory-store.js';
import { createApp } from '../src/server/create-app.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const clock = { now: (): number => Date.UTC(2026, 9, 13, 9, 0) };

function newApp(): FastifyInstance {
  return createApp({ ...createMemoryStores(), clock, logger: false });
}

/**
 * One app per test: a fresh instance for every request would give every request its own empty
 * store, and a test that posts twice before reading would be asserting about two different servers.
 */
let server: FastifyInstance;

beforeEach(() => {
  server = newApp();
});

// `inject()` never opens a socket, but an app is still an object with a logger and an encapsulation
// tree, and thirty of them per file is a leak a reviewer should not have to reason about.
afterEach(async () => {
  await server.close();
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: InjectOptions['body'],
): Promise<{ status: number; json: unknown }> {
  // `exactOptionalPropertyTypes` is on, so a body that was not passed must stay absent rather than
  // arrive as `body: undefined` — which is not a value `InjectOptions` accepts.
  const options: InjectOptions = { method, url };
  if (body !== undefined) options.body = body;

  const response = await server.inject(options);
  return { status: response.statusCode, json: response.json() };
}

/** Every refusal has the same shape, so there is one way to read a failure. */
function failure(json: unknown): { code: string; message: string } {
  const error = (json as { readonly error?: { code: string; message: string } }).error;
  if (error === undefined) throw new Error(`response carries no error object: ${JSON.stringify(json)}`);
  return error;
}

describe('the health probe', () => {
  it('answers on a path that needs no store', async () => {
    const { status, json } = await call('GET', '/healthz');

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it('answers over a real socket, not only through inject', async () => {
    const listening = newApp();
    const address = await listening.listen({ host: '127.0.0.1', port: 0 });

    try {
      const response = await fetch(`${address}/healthz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await listening.close();
    }
  });
});

describe('boards', () => {
  it('creates a board and hands the stored value back', async () => {
    const { status, json } = await call('POST', '/boards', { id: 'bd_core', name: 'Core platform' });

    expect(status).toBe(201);
    expect(json).toEqual({ id: 'bd_core', name: 'Core platform', memberIds: [] });
  });

  it('refuses an id the domain refuses, with the domain code and message', async () => {
    const { status, json } = await call('POST', '/boards', { id: 'iş_1', name: 'Core platform' });

    expect(status).toBe(400);
    expect(failure(json)).toMatchObject({ code: 'INVALID_ID' });
    expect(failure(json).message).toContain('iş_1');
  });

  it('refuses a name that is empty once trimmed, and one no human will read', async () => {
    const empty = await call('POST', '/boards', { id: 'bd_a', name: '   ' });
    const huge = await call('POST', '/boards', { id: 'bd_b', name: 'x'.repeat(201) });

    expect(failure(empty.json).code).toBe('INVALID_NAME');
    expect(failure(huge.json).code).toBe('INVALID_NAME');
    expect((await call('GET', '/boards')).json).toEqual([]);
  });

  it('validates member ids as members, not as boards', async () => {
    const { status, json } = await call('POST', '/boards', { id: 'bd_a', name: 'Team', memberIds: ['bd_core'] });

    expect(status).toBe(400);
    expect(failure(json).message).toContain('member');
  });

  it('refuses a member list that is not a list', async () => {
    const { status, json } = await call('POST', '/boards', { id: 'bd_a', name: 'Team', memberIds: 'mb_yusuf' });

    expect(status).toBe(400);
    expect(failure(json).message).toContain('member');
  });

  it('refuses a second board under an id it already holds', async () => {
    await call('POST', '/boards', { id: 'bd_core', name: 'Core platform' });
    const again = await call('POST', '/boards', { id: 'bd_core', name: 'Renamed' });

    expect(again.status).toBe(409);
    expect(failure(again.json).code).toBe('CONFLICT');
    expect((await call('GET', '/boards/bd_core')).json).toMatchObject({ name: 'Core platform' });
  });

  it('lists boards in creation order and reads one back', async () => {
    await call('POST', '/boards', { id: 'bd_a', name: 'Alpha' });
    await call('POST', '/boards', { id: 'bd_b', name: 'Beta' });

    const listed = await call('GET', '/boards');
    const one = await call('GET', '/boards/bd_b');

    expect((listed.json as Board[]).map((board): string => board.name)).toEqual(['Alpha', 'Beta']);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ id: 'bd_b', name: 'Beta' });
  });

  it('answers 404 for a board it does not have and 400 for one it cannot name', async () => {
    const missing = await call('GET', '/boards/bd_ghost');
    const malformed = await call('GET', '/boards/not%20an%20id');

    expect(missing.status).toBe(404);
    expect(failure(missing.json).code).toBe('NOT_FOUND');
    expect(malformed.status).toBe(400);
    expect(failure(malformed.json).code).toBe('INVALID_ID');
  });
});

describe('work items', () => {
  async function withBoard(): Promise<void> {
    await call('POST', '/boards', { id: 'bd_core', name: 'Core platform', memberIds: ['mb_yusuf'] });
  }

  it('creates an item under a board, stamped by the injected clock', async () => {
    await withBoard();

    const { status, json } = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_deploy',
      title: 'Deploy the release',
      assigneeId: 'mb_yusuf',
      estimateMinutes: 30,
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({
      id: 'wi_deploy',
      boardId: 'bd_core',
      title: 'Deploy the release',
      status: 'backlog',
      assigneeId: 'mb_yusuf',
      estimateMinutes: 30,
      schedule: null,
      createdAt: clock.now(),
    });
  });

  it('refuses an item for a board it has never seen', async () => {
    const { status, json } = await call('POST', '/boards/bd_ghost/work-items', { id: 'wi_a', title: 'Anything' });

    expect(status).toBe(404);
    expect(failure(json).code).toBe('BOARD_NOT_FOUND');
  });

  it('refuses a status outside the domain vocabulary but accepts every one inside it', async () => {
    await withBoard();

    const bad = await call('POST', '/boards/bd_core/work-items', { id: 'wi_a', title: 'T', status: 'shipping' });

    expect(bad.status).toBe(400);
    expect(failure(bad.json).code).toBe('INVALID_STATUS');
    expect(failure(bad.json).message).toContain('backlog');

    for (const status of ['backlog', 'ready', 'in_progress', 'blocked', 'done']) {
      const created = await call('POST', '/boards/bd_core/work-items', { id: `wi_${status}`, title: 'T', status });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({ status });
    }
  });

  it('refuses an estimate that is not a whole number of minutes, and reads an absent one as null', async () => {
    await withBoard();

    // The sentences are the domain's now, and this is the door's side of that: a value that is not a number
    // is refused as the thing it is, not as a minute count it failed to be.
    const refused = [
      ['30', 'estimateMinutes must be a number of minutes, got "30"'],
      [true, 'estimateMinutes must be a number of minutes, got true'],
      [30.5, 'estimateMinutes must be a whole number of minutes, at least zero, got 30.5'],
      [-1, 'estimateMinutes must be a whole number of minutes, at least zero, got -1'],
    ] as const;

    for (const [estimateMinutes, sentence] of refused) {
      const { status, json } = await call('POST', '/boards/bd_core/work-items', {
        id: 'wi_a',
        title: 'T',
        estimateMinutes,
      });

      expect(status).toBe(400);
      expect(failure(json).code).toBe('INVALID_ESTIMATE');
      expect(failure(json).message).toBe(sentence);
    }

    const absent = await call('POST', '/boards/bd_core/work-items', { id: 'wi_b', title: 'T' });
    const unset = await call('POST', '/boards/bd_core/work-items', { id: 'wi_c', title: 'T', estimateMinutes: null });

    expect(absent.json).toMatchObject({ estimateMinutes: null });
    expect(unset.json).toMatchObject({ estimateMinutes: null });
  });

  it('refuses a schedule the engine refuses, naming the engine code', async () => {
    await withBoard();
    const schedule = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' };

    const good = await call('POST', '/boards/bd_core/work-items', { id: 'wi_a', title: 'T', schedule });
    const badZone = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_b',
      title: 'T',
      schedule: { ...schedule, tz: 'Mars/Olympus_Mons' },
    });
    const badFreq = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_c',
      title: 'T',
      schedule: { ...schedule, freq: 'HOURLY' },
    });
    const badInterval = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_d',
      title: 'T',
      schedule: { ...schedule, interval: 0 },
    });
    const noZone = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_e',
      title: 'T',
      schedule: { dtStart: schedule.dtStart, freq: 'DAILY' },
    });

    expect(good.json).toMatchObject({ schedule });
    expect(failure(badZone.json).code).toBe('INVALID_TIME_ZONE');
    expect(failure(badFreq.json).code).toBe('INVALID_FREQUENCY');
    expect(failure(badInterval.json).code).toBe('INVALID_INTERVAL');
    expect(failure(noZone.json).code).toBe('INVALID_TIME_ZONE');
  });

  it('names the field the client wrote, not the engine parameter that received it', async () => {
    await withBoard();
    const iso = '2026-03-28T01:30:00.000Z';

    const { status, json } = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_a',
      title: 'T',
      schedule: { tz: 'Europe/Berlin', dtStart: iso, freq: 'DAILY' },
    });

    expect(status).toBe(400);
    expect(failure(json).code).toBe('INVALID_INSTANT');
    expect(failure(json).message).toContain('dtStart');
    expect(failure(json).message).not.toContain('after');
  });

  it('refuses an assignee id that does not declare itself a member', async () => {
    await withBoard();

    const { status, json } = await call('POST', '/boards/bd_core/work-items', {
      id: 'wi_a',
      title: 'T',
      assigneeId: 'bd_core',
    });

    expect(status).toBe(400);
    expect(failure(json).message).toContain('member');
  });

  it('refuses a title the way it refuses a board name', async () => {
    await withBoard();

    for (const title of ['   ', 'x'.repeat(201), 42]) {
      const { status, json } = await call('POST', '/boards/bd_core/work-items', { id: 'wi_a', title });

      expect(status).toBe(400);
      expect(failure(json).code).toBe('INVALID_TITLE');
    }
  });

  it('refuses a schedule that is neither null nor an object', async () => {
    await withBoard();

    for (const schedule of ['daily', 42, []]) {
      const { status, json } = await call('POST', '/boards/bd_core/work-items', { id: 'wi_a', title: 'T', schedule });

      expect(status).toBe(400);
      expect(failure(json).code).toBe('INVALID_SCHEDULE');
    }
  });

  it('refuses a second item under an id it already holds, across boards', async () => {
    await call('POST', '/boards', { id: 'bd_a', name: 'Alpha' });
    await call('POST', '/boards', { id: 'bd_b', name: 'Beta' });
    await call('POST', '/boards/bd_a/work-items', { id: 'wi_shared', title: 'First' });

    const sameBoard = await call('POST', '/boards/bd_a/work-items', { id: 'wi_shared', title: 'Again' });
    const otherBoard = await call('POST', '/boards/bd_b/work-items', { id: 'wi_shared', title: 'Elsewhere' });

    expect(sameBoard.status).toBe(409);
    expect(otherBoard.status).toBe(409);
  });

  it('lists only the items of the board in the path, in creation order', async () => {
    await call('POST', '/boards', { id: 'bd_a', name: 'Alpha' });
    await call('POST', '/boards', { id: 'bd_b', name: 'Beta' });
    await call('POST', '/boards/bd_a/work-items', { id: 'wi_1', title: 'One' });
    await call('POST', '/boards/bd_a/work-items', { id: 'wi_2', title: 'Two' });
    await call('POST', '/boards/bd_b/work-items', { id: 'wi_3', title: 'Three' });

    const forA = await call('GET', '/boards/bd_a/work-items');

    expect((forA.json as WorkItem[]).map((candidate): string => candidate.title)).toEqual(['One', 'Two']);
    expect((await call('GET', '/boards/bd_ghost/work-items')).status).toBe(404);
  });
});

describe('moving an item', () => {
  async function seeded(): Promise<void> {
    await call('POST', '/boards', { id: 'bd_core', name: 'Core platform' });
    await call('POST', '/boards/bd_core/work-items', { id: 'wi_deploy', title: 'Deploy the release' });
  }

  it('changes the status and answers with the whole stored item', async () => {
    await seeded();

    const { status, json } = await call('PATCH', '/work-items/wi_deploy', { status: 'in_progress' });

    expect(status).toBe(200);
    expect(json).toMatchObject({ id: 'wi_deploy', status: 'in_progress' });
    expect((await call('GET', '/boards/bd_core/work-items')).json).toMatchObject([
      { id: 'wi_deploy', status: 'in_progress' },
    ]);
  });

  it('refuses a status outside the vocabulary without touching the item', async () => {
    await seeded();

    const refused = await call('PATCH', '/work-items/wi_deploy', { status: 'cancelled' });

    expect(refused.status).toBe(400);
    expect(failure(refused.json).code).toBe('INVALID_STATUS');
    expect((await call('GET', '/boards/bd_core/work-items')).json).toMatchObject([{ status: 'backlog' }]);
  });

  it('answers 404 for an item it does not have, and 400 for one it cannot name', async () => {
    await seeded();

    const missing = await call('PATCH', '/work-items/wi_ghost', { status: 'done' });
    const malformed = await call('PATCH', '/work-items/not_an_id', { status: 'done' });

    expect(missing.status).toBe(404);
    expect(failure(missing.json).code).toBe('NOT_FOUND');
    expect(malformed.status).toBe(400);
  });

  it('answers 400 when the body carries no status, a status that is not a string, or one that means unset', async () => {
    await seeded();

    const empty = await call('PATCH', '/work-items/wi_deploy', {});
    const wrongType = await call('PATCH', '/work-items/wi_deploy', { status: 7 });
    const explicitNull = await call('PATCH', '/work-items/wi_deploy', { status: null });

    expect(failure(empty.json).code).toBe('INVALID_STATUS');
    expect(failure(wrongType.json).code).toBe('INVALID_STATUS');
    expect(failure(explicitNull.json).message).toContain('null');
    expect((await call('GET', '/boards/bd_core/work-items')).json).toMatchObject([{ status: 'backlog' }]);
  });

  it('ignores keys it has no meaning for, and says so by returning the item unchanged apart from the status', async () => {
    await seeded();

    const { status, json } = await call('PATCH', '/work-items/wi_deploy', {
      status: 'done',
      title: 'Renamed by a typo',
      statuse: 'backlog',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ title: 'Deploy the release', status: 'done' });
  });
});

describe('the shape of every answer', () => {
  it('answers a route it does not have with the same envelope', async () => {
    const { status, json } = await call('GET', '/boards/bd_core/unknown');

    expect(status).toBe(404);
    expect(failure(json).code).toBe('NOT_FOUND');
  });

  it('calls a path it knows a method it does not have the same 404, in the same envelope', async () => {
    const { status, json } = await call('DELETE', '/boards');

    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'NOT_FOUND', message: 'no route for DELETE /boards' } });
  });

  it('refuses a body that is not an object', async () => {
    const { status, json } = await call('POST', '/boards', ['Core platform']);

    expect(status).toBe(400);
    expect(failure(json).code).toBe('INVALID_BODY');
  });

  it('wraps a body Fastify itself refuses in the same envelope', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/boards',
      body: '{"id":',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(failure(response.json()).code).toBe('INVALID_BODY');
  });

  it('answers a store failure with 500 in the same envelope, without repeating what the store said', async () => {
    const broken: BoardStore = {
      loadBoard: (): Promise<Board | null> => Promise.resolve(null),
      listBoards: (): Promise<readonly Board[]> => Promise.reject(new Error('the pool is closed')),
      saveBoard: (): Promise<void> => Promise.resolve(),
    };

    const response = await createApp({ boards: broken, workItems: createMemoryStores().workItems, clock, logger: false }).inject({
      method: 'GET',
      url: '/boards',
    });

    expect(response.statusCode).toBe(500);
    expect(failure(response.json()).code).toBe('INTERNAL');
    expect(response.body).not.toContain('the pool is closed');
  });
});

describe('closing', () => {
  it('does not wait for a client that has gone quiet', async () => {
    const listening = newApp();
    const address = await listening.listen({ host: '127.0.0.1', port: 0 });

    // One completed request leaves the connection in the client's keep-alive pool: open, and with
    // nothing left to finish on it. The stop path depends on the server not waiting for that socket,
    // because a load balancer or a browser holds it until its own idle timeout says otherwise.
    const response = await fetch(`${address}/healthz`);
    await response.text();

    const outcome = await Promise.race([
      listening.close().then(() => 'closed'),
      new Promise((resolve) => {
        setTimeout(() => resolve('waiting'), 500).unref();
      }),
    ]);

    try {
      expect(outcome).toBe('closed');
    } finally {
      // If it ever comes back `waiting` the shutdown is what needs fixing, not this timer — but the
      // sockets are what the pending close is waiting on, so destroy them and let it finish.
      listening.server.closeAllConnections();
      await listening.close();
    }
  });
});
