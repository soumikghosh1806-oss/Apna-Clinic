// The browser's connection to Supabase. It uses only the project URL and the publishable key.
// Row level security in the database is what protects the data, not this key.
//
// The library is loaded on demand, so the demo build does not download it.

import type { SupabaseClient } from '@supabase/supabase-js';
import { configResult } from '../config';
import type { SupabaseConfig } from '../config/env';

export async function createSupabaseClient(
  config: Pick<SupabaseConfig, 'supabaseUrl' | 'supabaseKey'>,
): Promise<SupabaseClient> {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

let shared: Promise<SupabaseClient> | null = null;

/** One client for the whole page. Rejects when the app is not running in Supabase mode. */
export function getSupabase(): Promise<SupabaseClient> {
  const config = configResult.ok ? configResult.config : null;
  if (!config || config.backend !== 'supabase') {
    return Promise.reject(new Error('Supabase is not enabled. Set VITE_BACKEND=supabase and restart.'));
  }
  shared ??= createSupabaseClient(config);
  return shared;
}
