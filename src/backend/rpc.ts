// Calls to the database functions, in one place.
//
// Every function in the database answers { ok: true, ... } or { ok: false, code, message, field_errors?, existing_token_id? }.
// This file turns both shapes, and network problems, into the app's own Result type so screens handle one thing.

import type { ErrorCode, Failure } from '../domain/types';
import { getSupabase } from '../lib/supabase';
import { mapConflicts } from './scheduleMappers';

export type Dto = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RpcResult<T extends Dto = Dto> = { ok: true; data: T } | Failure;

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'forbidden',
  'online_disabled',
  'full',
  'doctor_unavailable',
  'invalid_date',
  'invalid_input',
  'duplicate',
  'not_found',
  'invalid_transition',
  'stale',
  'too_soon',
  'empty',
  'rate_limited',
  'slug_taken',
  'schedule_conflict',
  'otp_required',
  'otp_expired',
  'otp_invalid',
  'delivery_failed',
  'not_configured',
  'network',
]);

export const NETWORK_MESSAGE = 'Could not reach the server. Check your internet connection and try again.';

export function networkFailure(): Failure {
  return { ok: false, code: 'network', message: NETWORK_MESSAGE };
}

/** Turns what the database answered into a Failure. Unknown codes become a plain server error message. */
export function toFailure(body: Dto): Failure {
  const code = typeof body.code === 'string' && KNOWN_CODES.has(body.code) ? (body.code as ErrorCode) : 'invalid_input';
  const failure: Failure = {
    ok: false,
    code,
    message: typeof body.message === 'string' && body.message ? body.message : 'Something went wrong. Please try again.',
  };
  if (body.field_errors && typeof body.field_errors === 'object') {
    failure.fieldErrors = body.field_errors as Record<string, string>;
  }
  if (Array.isArray(body.conflicts)) failure.conflicts = mapConflicts(body.conflicts);
  if (typeof body.attempts_left === 'number') failure.attemptsLeft = body.attempts_left;
  // Patients get the secret key of their existing token (their link is /token/<key>); staff get the token id.
  if (typeof body.existing_access_key === 'string') failure.existingTokenId = body.existing_access_key;
  else if (typeof body.existing_token_id === 'string') failure.existingTokenId = body.existing_token_id;
  return failure;
}

/** Reads the answer of a function call. Exported so it can be tested without a network. */
export function readAnswer<T extends Dto>(answer: { data: unknown; error: { message?: string } | null }): RpcResult<T> {
  if (answer.error) {
    // A database error is not something a visitor can fix. Keep the detail out of the screen.
    return { ok: false, code: 'network', message: NETWORK_MESSAGE };
  }
  const body = answer.data;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_input', message: 'The server sent an answer the app did not understand.' };
  }
  if ((body as Dto).ok === true) return { ok: true, data: body as T };
  return toFailure(body as Dto);
}

export async function rpc<T extends Dto = Dto>(name: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
  try {
    const client = await getSupabase();
    return readAnswer<T>(await client.rpc(name, args));
  } catch {
    return networkFailure();
  }
}
