import Fastify, { type FastifyInstance } from 'fastify';

import type { Board } from '../domain/model.js';
import type { BoardStore, Clock, WorkItemStore } from '../domain/ports.js';
import type { LogLevel } from '../config/app-config.js';
import { asHttpError, HttpError } from './http-error.js';
import {
  parseCreateBoard,
  parseCreateWorkItem,
  parseStatusChange,
  readBoardId,
  readWorkItemId,
} from './requests.js';

export interface AppDependencies {
  readonly boards: BoardStore;
  readonly workItems: WorkItemStore;
  readonly clock: Clock;
  /** `false` is what a test passes: Fastify would otherwise print every request into the run output. */
  readonly logger: false | { readonly level: LogLevel };
}

/**
 * The application, assembled from its ports and nothing else: no route reaches for `process`, a timer
 * or a store implementation, so the same graph boots in a test with the in-memory stores and in a
 * container with the real ones. `createApp` does not listen — deciding where to bind belongs to the
 * entry point, and a test that only wants `inject()` must not open a socket.
 */
export function createApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger });

  app.get('/healthz', () => ({ ok: true }));

  app.post('/boards', async (request, reply) => {
    const input = parseCreateBoard(request.body);
    if ((await deps.boards.loadBoard(input.id)) !== null) {
      throw new HttpError(409, 'CONFLICT', `a board with id "${input.id}" is already stored`);
    }

    const board: Board = { id: input.id, name: input.name, memberIds: input.memberIds };
    await deps.boards.saveBoard(board);

    return reply.status(201).send(board);
  });

  app.get('/boards', async () => await deps.boards.listBoards());

  app.get<{ Params: { id: string } }>('/boards/:id', async (request) => {
    const id = readBoardId(request.params.id);
    const board = await deps.boards.loadBoard(id);
    if (board === null) throw new HttpError(404, 'NOT_FOUND', `no board with id "${id}"`);

    return board;
  });

  app.post<{ Params: { id: string } }>('/boards/:id/work-items', async (request, reply) => {
    const boardId = readBoardId(request.params.id);
    const input = parseCreateWorkItem(boardId, request.body);

    if ((await deps.boards.loadBoard(boardId)) === null) {
      throw new HttpError(404, 'BOARD_NOT_FOUND', `no board with id "${boardId}"`);
    }
    if ((await deps.workItems.load(input.id)) !== null) {
      throw new HttpError(409, 'CONFLICT', `a work item with id "${input.id}" is already stored`);
    }

    const item = { ...input, createdAt: deps.clock.now() };
    await deps.workItems.save(item);

    return reply.status(201).send(item);
  });

  app.get<{ Params: { id: string } }>('/boards/:id/work-items', async (request) => {
    const boardId = readBoardId(request.params.id);
    if ((await deps.boards.loadBoard(boardId)) === null) {
      throw new HttpError(404, 'BOARD_NOT_FOUND', `no board with id "${boardId}"`);
    }

    return await deps.workItems.listForBoard(boardId);
  });

  app.patch<{ Params: { id: string } }>('/work-items/:id', async (request) => {
    const id = readWorkItemId(request.params.id);
    const status = parseStatusChange(request.body);
    const item = await deps.workItems.load(id);
    if (item === null) throw new HttpError(404, 'NOT_FOUND', `no work item with id "${id}"`);

    const moved = { ...item, status };
    await deps.workItems.save(moved);

    return moved;
  });

  // One envelope for every refusal, whoever produced it: a route that throws, the engine behind a
  // route, and Fastify itself all answer the same way, so a client parses one shape.
  app.setErrorHandler((error, request, reply) => {
    const failure = asHttpError(error);
    if (failure.statusCode >= 500) request.log.error(failure);

    return reply.status(failure.statusCode).send({ error: { code: failure.code, message: failure.message } });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${request.url}` } });
  });

  return app;
}
