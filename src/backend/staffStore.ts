// The staff screens' shared data. It holds the same AppState shape the demo store holds, filled from one database call,
// and keeps it fresh two ways: a signal from the database whenever the queue changes, and a check every few seconds.

import type { AppState } from '../domain/types';
import type { Failure } from '../domain/types';
import type { StateSource } from '../state/store';
import { emptyState, mapSnapshot, type Membership, type StaffSnapshot } from './mappers';
import type { Dto, RpcResult } from './rpc';

export interface StaffStatus {
  phase: 'loading' | 'ready' | 'error';
  /** The last attempt to refresh failed, but older data is still on screen. */
  stale: boolean;
  failure: Failure | null;
  syncedAt: Date | null;
}

export interface StaffStore extends StateSource {
  getSnapshot(): StaffSnapshot | null;
  getStatus(): StaffStatus;
  subscribeStatus(listener: () => void): () => void;
  /** Reloads now, even in a hidden tab, and resolves when the new data is in place. */
  reload(): Promise<void>;
  dispose(): void;
}

export interface StaffStoreDeps {
  fetchSnapshot(clinicId: string): Promise<RpcResult>;
  /** Starts listening for "the queue changed" signals. Returns a function that stops listening. */
  listen(clinicId: string, onSignal: () => void): Promise<() => void>;
  signalDelayMs?: number;
}

/** The server clock changes on every call, so it is left out when checking whether anything really changed. */
function fingerprint(dto: Dto): string {
  const { now: _now, ...rest } = dto;
  return JSON.stringify(rest);
}

export function createStaffStore(clinic: Membership, deps: StaffStoreDeps): StaffStore {
  const stateListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  let state: AppState = emptyState(clinic.name);
  let snapshot: StaffSnapshot | null = null;
  let status: StaffStatus = { phase: 'loading', stale: false, failure: null, syncedAt: null };
  let lastPrint = '';
  let inFlight: Promise<void> | null = null;
  // The one extra request lined up behind the running one. Everyone who asks meanwhile shares it.
  let followUp: Promise<void> | null = null;
  let disposed = false;
  let stopListening: (() => void) | null = null;
  let signalTimer: ReturnType<typeof setTimeout> | undefined;

  const emitState = () => stateListeners.forEach((l) => l());
  const setStatus = (next: StaffStatus) => {
    status = next;
    statusListeners.forEach((l) => l());
  };

  async function load(): Promise<void> {
    const answer = await deps.fetchSnapshot(clinic.clinicId);
    if (disposed) return;
    if (!answer.ok) {
      setStatus(
        snapshot
          ? { ...status, stale: true, failure: answer }
          : { phase: 'error', stale: false, failure: answer, syncedAt: null },
      );
      return;
    }
    const print = fingerprint(answer.data);
    if (print !== lastPrint) {
      lastPrint = print;
      snapshot = mapSnapshot(answer.data);
      state = snapshot.state;
      emitState();
    }
    setStatus({ phase: 'ready', stale: false, failure: null, syncedAt: new Date() });
  }

  function start(): Promise<void> {
    const request: Promise<void> = load().finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  }

  /**
   * Only one request runs at a time. A caller who asks while one is running gets an extra request that starts after the
   * running one ends, and is told "done" only when that one finishes. Handing back the running request would be wrong:
   * it read the data before the caller's change, so the screen would still show the old queue when told it was current.
   * Any number of callers during one running request share a single follow-up.
   */
  function run(): Promise<void> {
    if (followUp) return followUp;
    if (!inFlight) return start();
    const next = () => {
      followUp = null;
      return disposed ? undefined : start();
    };
    // Also when the running request failed outright, so one bad request can never leave the store stuck.
    followUp = inFlight.then(next, next);
    return followUp;
  }

  function onSignal() {
    clearTimeout(signalTimer);
    signalTimer = setTimeout(() => void run(), deps.signalDelayMs ?? 300);
  }

  void run();
  deps
    .listen(clinic.clinicId, onSignal)
    .then((stop) => {
      if (disposed) stop();
      else stopListening = stop;
    })
    // No live signal is not a failure: the regular check still keeps the screens current.
    .catch(() => undefined);

  return {
    getState: () => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    refresh() {
      if (typeof document !== 'undefined' && document.hidden) return;
      void run();
    },
    getSnapshot: () => snapshot,
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    reload: () => run(),
    dispose() {
      disposed = true;
      clearTimeout(signalTimer);
      stopListening?.();
      stateListeners.clear();
      statusListeners.clear();
    },
  };
}
