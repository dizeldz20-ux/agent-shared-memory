export const LIVE_BATCH_WINDOW_MS = 80;

export interface LiveBatcher<T> {
  enqueue(items: T[]): void;
  flush(): void;
  dispose(): void;
}

/** Lossless short-window coalescing: render once per burst, retain every event. */
export function createLiveBatcher<T>(emit: (items: T[]) => void, delay = LIVE_BATCH_WINDOW_MS): LiveBatcher<T> {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !pending.length) return;
    const batch = pending;
    pending = [];
    emit(batch);
  };

  return {
    enqueue(items) {
      if (disposed || !items.length) return;
      pending.push(...items);
      if (!timer) timer = setTimeout(flush, delay);
    },
    flush,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}
