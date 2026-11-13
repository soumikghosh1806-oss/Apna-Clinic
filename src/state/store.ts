// One shared store for the whole app. Every screen reads from it and every action writes to it,
// which is why a doctor pressing NEXT shows up on the reception list, the patient screen and the TV.
//
// Data is kept in the browser's localStorage so a refresh does not reset the demo.
// This is local demo persistence only. It is not a database and it is not secure.

import { toDateKey } from '../domain/dates';
import { createSeed } from '../domain/seed';
import type { AppState, Outcome, Result } from '../domain/types';

export const STORAGE_KEY = 'clinic-queue-demo-v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What screens need to read shared data. The demo store and the real backend's staff store both provide it. */
export interface StateSource {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  /** Checks for newer data. The demo store re-reads local storage; the real backend asks the server. */
  refresh(): void;
}

export interface Store extends StateSource {
  /** Applies a domain function to the latest state, saves the result and tells every screen. */
  run<T>(fn: (state: AppState) => Outcome<T>): Result<T>;
  /** Throws away all demo changes and starts again from the sample data. */
  reset(): void;
  /** False when the browser would not let the app save data. The demo then lives in memory only. */
  isPersistent(): boolean;
  dispose(): void;
}

function isValidState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<AppState>;
  return (
    s.schema === 1 &&
    typeof s.seededOn === 'string' &&
    typeof s.idCounter === 'number' &&
    typeof s.settings === 'object' &&
    s.settings !== null &&
    Array.isArray(s.doctors) &&
    Array.isArray(s.patients) &&
    Array.isArray(s.tokens) &&
    Array.isArray(s.visits)
  );
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Some browsers throw when storage is blocked.
  }
  return null;
}

export function createStore(options: { storage?: StorageLike | null; now?: () => Date } = {}): Store {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const listeners = new Set<() => void>();
  let persistent = storage !== null;
  let lastRaw: string | null = null;

  function readSaved(): AppState | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      lastRaw = raw;
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isValidState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function save(next: AppState) {
    if (!storage) return;
    try {
      const raw = JSON.stringify(next);
      storage.setItem(STORAGE_KEY, raw);
      lastRaw = raw;
    } catch {
      persistent = false;
    }
  }

  function load(): AppState {
    const saved = readSaved();
    if (saved && saved.seededOn === toDateKey(now())) return saved;
    const fresh = createSeed(now());
    save(fresh);
    return fresh;
  }

  let state = load();

  function emit() {
    listeners.forEach((l) => l());
  }

  function refresh() {
    const today = toDateKey(now());
    let changed = false;
    if (storage) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch {
        raw = lastRaw;
      }
      if (raw !== lastRaw) {
        const saved = readSaved();
        if (saved) {
          state = saved;
          changed = true;
        }
      }
    }
    if (state.seededOn !== today) {
      state = createSeed(now());
      save(state);
      changed = true;
    }
    if (changed) emit();
  }

  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY || event.key === null) refresh();
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run(fn) {
      refresh();
      const outcome = fn(state);
      if (outcome.state !== state) {
        state = { ...outcome.state, updatedAt: now().toISOString() };
        save(state);
        emit();
      }
      return outcome.result;
    },
    refresh,
    reset() {
      state = createSeed(now());
      save(state);
      emit();
    },
    isPersistent: () => persistent,
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      listeners.clear();
    },
  };
}

/** Simple in memory storage for tests and for browsers that block localStorage. */
export class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
