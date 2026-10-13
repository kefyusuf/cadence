import { occurrences, type Occurrence, type Recurrence } from './recurrence.js';

/**
 * An incremental view of a series. State lives in closures, so methods can be passed
 * around detached from the cursor and two cursors never share a position.
 */
export interface SeriesCursor {
  next(): Occurrence | null;
  peek(): Occurrence | null;
  reset(): void;
  consumed(): number;
}

export function createSeriesCursor(recurrence: Recurrence): SeriesCursor {
  let stream = occurrences(recurrence);
  let buffered: Occurrence | null = null;
  let hasBuffer = false;
  let consumed = 0;

  function head(): Occurrence | null {
    if (!hasBuffer) {
      const { done, value } = stream.next();
      buffered = done ? null : value;
      hasBuffer = true;
    }
    return buffered;
  }

  return {
    next() {
      const value = head();
      hasBuffer = false;
      buffered = null;
      if (value !== null) consumed += 1;
      return value;
    },

    peek() {
      return head();
    },

    reset() {
      stream = occurrences(recurrence);
      buffered = null;
      hasBuffer = false;
      consumed = 0;
    },

    consumed() {
      return consumed;
    },
  };
}
