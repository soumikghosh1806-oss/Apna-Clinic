/// <reference types="vite/client" />

/**
 * Settings the app reads from the environment. Vite copies every VITE_ variable into the public website,
 * so only values that are safe to show to anyone may be listed here. Never add a secret or service role key.
 */
interface ImportMetaEnv {
  /** "demo" (default, local sample data) or "supabase". */
  readonly VITE_BACKEND?: string;
  /** Project URL, for example https://abcdefgh.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /** The publishable key (sb_publishable_...) or the legacy anon key. Never a secret or service role key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
