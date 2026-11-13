// Loads something from the server, keeps it fresh, and tells the screen when it is loading or has failed.
// Used by the patient pages and by the staff pages that read one record (history, search, reports).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Failure, Result } from '../domain/types';

export interface Remote<T> {
  data: T | undefined;
  failure: Failure | null;
  loading: boolean;
  updatedAt: Date | null;
  refresh(): void;
}

interface Options {
  /** Check again this often while the page is open and visible. 0 means load once. */
  intervalMs?: number;
  /** Do nothing (and show no data) while false. */
  enabled?: boolean;
}

export function useRemote<T>(
  fetcher: () => Promise<Result<T>>,
  deps: readonly unknown[],
  { intervalMs = 0, enabled = true }: Options = {},
): Remote<T> {
  const [state, setState] = useState<Omit<Remote<T>, 'refresh'>>({
    data: undefined,
    failure: null,
    loading: enabled,
    updatedAt: null,
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const sequence = useRef(0);

  const run = useCallback(async () => {
    const id = ++sequence.current;
    const result = await fetcherRef.current();
    // A newer request, or a change of inputs, makes this answer out of date.
    if (id !== sequence.current) return;
    setState((prev) =>
      result.ok
        ? { data: result.value, failure: null, loading: false, updatedAt: new Date() }
        : { data: prev.data, failure: result, loading: false, updatedAt: prev.updatedAt },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      sequence.current += 1;
      setState({ data: undefined, failure: null, loading: false, updatedAt: null });
      return;
    }
    setState({ data: undefined, failure: null, loading: true, updatedAt: null });
    void run();
    const timer = intervalMs > 0 ? window.setInterval(() => !document.hidden && void run(), intervalMs) : undefined;
    const onVisible = () => {
      if (!document.hidden && intervalMs > 0) void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      sequence.current += 1;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // The caller lists exactly the inputs that should restart loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, ...deps]);

  const refresh = useCallback(() => void run(), [run]);
  return { ...state, refresh };
}
