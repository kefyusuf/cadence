import { describe, expect, it } from 'vitest';

import { waitForStopSignal, type SignalSource, type StopSignal } from '../src/server/shutdown.js';

/**
 * Stands in for the process. It records which names were attached and hands back the listeners on
 * request, so the behaviour under test — which signals are answered, and whether every listener is let
 * go again — is visible from outside instead of inferred from a real signal, which would have taken the
 * test runner down with it.
 */
interface FakeProcess {
  readonly source: SignalSource;
  readonly attached: () => readonly StopSignal[];
  readonly emit: (signal: StopSignal) => void;
}

function fakeProcess(): FakeProcess {
  const listeners = new Map<StopSignal, Set<() => void>>();

  function slot(signal: StopSignal): Set<() => void> {
    const existing = listeners.get(signal);
    if (existing !== undefined) return existing;

    const created = new Set<() => void>();
    listeners.set(signal, created);
    return created;
  }

  return {
    source: {
      on: (signal, listener) => {
        slot(signal).add(listener);
      },
      off: (signal, listener) => {
        listeners.get(signal)?.delete(listener);
      },
    },
    attached: () =>
      [...listeners.entries()]
        .filter(([, slot]) => slot.size > 0)
        .map(([signal]) => signal),
    emit: (signal) => {
      for (const listener of [...slot(signal)]) listener();
    },
  };
}

describe('waitForStopSignal', () => {
  it('resolves with the signal that arrived', async () => {
    const world = fakeProcess();
    const stopping = waitForStopSignal(world.source, ['SIGTERM', 'SIGINT']);

    world.emit('SIGINT');

    await expect(stopping).resolves.toBe('SIGINT');
  });

  it('listens for exactly the signals it was handed, and answers nothing else', () => {
    const world = fakeProcess();

    void waitForStopSignal(world.source, ['SIGTERM']);

    expect(world.attached()).toEqual(['SIGTERM']);

    world.emit('SIGINT');

    expect(world.attached()).toEqual(['SIGTERM']);
  });

  it('lets go of every listener once a stop has been asked for', async () => {
    const world = fakeProcess();
    const stopping = waitForStopSignal(world.source, ['SIGTERM', 'SIGINT']);

    world.emit('SIGTERM');
    await expect(stopping).resolves.toBe('SIGTERM');

    expect(world.attached()).toEqual([]);
  });

  it('settles on the first signal and ignores the one after it', async () => {
    const world = fakeProcess();
    const stopping = waitForStopSignal(world.source, ['SIGTERM', 'SIGINT']);

    world.emit('SIGTERM');
    // A supervisor that did not get an answer the first time sends another. It must not re-enter the
    // shutdown path, and it must not throw now that nothing is listening.
    world.emit('SIGINT');

    await expect(stopping).resolves.toBe('SIGTERM');
    expect(world.attached()).toEqual([]);
  });
});
