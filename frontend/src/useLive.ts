import { useEffect, useRef } from 'react';
import type { LiveEvent } from './types';
import { createLiveBatcher } from './liveBatch';

/** WebSocket to the ASM server with auto-reconnect; batches arrive as LiveEvent[]. */
const LIVE_PATH = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_STATIC_PREVIEW === '1' ? '' : '/ws';

export function useLive(
  onEvents: (evs: LiveEvent[]) => void,
  onStatus: (up: boolean) => void,
  enabled = true,
) {
  const cbRef = useRef(onEvents);
  cbRef.current = onEvents;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    if (!enabled) {
      statusRef.current(false);
      return;
    }
    let ws: WebSocket | null = null;
    let dead = false;
    let retry = 1000;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const batcher = createLiveBatcher<LiveEvent>((batch) => {
      if (!dead) cbRef.current(batch);
    });

    const connect = () => {
      if (dead) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${LIVE_PATH}`);
      ws.onopen = () => {
        retry = 1000;
        statusRef.current(true);
        pingTimer = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25000);
      };
      ws.onmessage = (m) => {
        try {
          const evs = JSON.parse(m.data);
          if (Array.isArray(evs)) batcher.enqueue(evs);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        batcher.flush();
        statusRef.current(false);
        if (!dead) {
          retryTimer = setTimeout(connect, retry);
          retry = Math.min(retry * 2, 10000);
        }
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      dead = true;
      if (pingTimer) clearInterval(pingTimer);
      if (retryTimer) clearTimeout(retryTimer);
      batcher.dispose();
      ws?.close();
    };
  }, [enabled]);
}
