// Calls to our own Edge Functions (server code that holds the secret keys). The browser only ever sends its own sign
// in token. Every function answers { ok: true, ... } or { ok: false, code, message, field_errors? }, the same shape as
// the database functions, so the result is read the same way.

import type { Failure } from '../domain/types';
import { getSupabase } from '../lib/supabase';
import { networkFailure, toFailure, type Dto } from './rpc';

export async function callFunction(name: string, body: Dto): Promise<{ ok: true; data: Dto } | Failure> {
  try {
    const client = await getSupabase();
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      // A refused request still carries the function's own message in its body.
      let detail: Dto = {};
      try {
        detail = await (error as unknown as { context: Response }).context.json();
      } catch {
        /* no readable body: fall through to the network message */
      }
      return typeof detail.message === 'string' ? toFailure(detail) : networkFailure();
    }
    const answer = (data ?? {}) as Dto;
    return answer.ok === true ? { ok: true, data: answer } : toFailure(answer);
  } catch {
    return networkFailure();
  }
}

/** What happened to an email the server tried to send. "sent" means the email provider accepted it. */
export interface EmailOutcome {
  status: 'sent' | 'failed' | 'not_configured';
  message?: string;
}

export function readEmailOutcome(body: Dto): EmailOutcome {
  const e = (body.email ?? {}) as Dto;
  const status = e.status === 'sent' || e.status === 'failed' || e.status === 'not_configured' ? e.status : 'failed';
  return { status, message: typeof e.message === 'string' ? e.message : undefined };
}
