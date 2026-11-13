// Which data source this page load uses. Decided once at start up from the settings, never changes while the page is open.
// That is what lets screens pick a demo or a Supabase hook at module level without breaking the rules of hooks.

import { configResult } from '../config';

export const IS_SUPABASE: boolean = configResult.ok && configResult.config.backend === 'supabase';
export const IS_DEMO: boolean = !IS_SUPABASE;

/** What the product is called on pages that belong to no single clinic. The demo keeps its original name. */
export const PLATFORM_NAME: string = IS_SUPABASE ? 'Apna Clinic' : 'Cliniq';
