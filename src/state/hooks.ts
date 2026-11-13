import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { IS_SUPABASE } from '../backend/mode';
import { useAppState, useLiveClock } from './context';

/**
 * Shared state, the current time and the moment the screen last got fresh data.
 * The screen updates at once when anything changes in this browser, and is also checked every 10 seconds.
 */
export function useLiveQueue(): { state: ReturnType<typeof useAppState>; now: Date; updatedAt: Date } {
  const state = useAppState();
  const now = useLiveClock(10000);
  const updatedAt = useMemo(() => new Date(), [state, now]);
  return { state, now, updatedAt };
}

// ---------------------------------------------------------------------------
// "My tokens": which tokens this browser booked or looked at, so the patient can come back to them.
// Stored on this device only. There are no patient accounts.
// ---------------------------------------------------------------------------

// A separate key for a real clinic, so leftover demo ids on the same address are never mistaken for real token keys.
const MY_TOKENS_KEY = IS_SUPABASE ? 'cliniq-my-tokens-v1' : 'clinic-queue-demo-my-tokens';
const listeners = new Set<() => void>();

function readRaw(): string {
  try {
    return window.localStorage.getItem(MY_TOKENS_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeIds(ids: string[]) {
  try {
    window.localStorage.setItem(MY_TOKENS_KEY, JSON.stringify(ids.slice(-10)));
  } catch {
    // Storage blocked: the patient can still use the page they are on.
  }
  listeners.forEach((l) => l());
}

export function rememberToken(id: string) {
  const ids = parseIds(readRaw()).filter((x) => x !== id);
  writeIds([...ids, id]);
}

export function forgetAllTokens() {
  writeIds([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** Token ids remembered on this device, newest last. */
export function useMyTokenIds(): string[] {
  const raw = useSyncExternalStore(subscribe, readRaw, () => '[]');
  return useMemo(() => parseIds(raw), [raw]);
}

/** Moves keyboard focus to the first field with an error after a failed submit. */
export function useFocusFirstError() {
  return useCallback((form: HTMLFormElement | null) => {
    window.requestAnimationFrame(() => {
      form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }, []);
}
