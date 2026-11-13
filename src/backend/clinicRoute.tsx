// Clinic web addresses. A clinic's public pages live under /c/<clinic address>, for example /c/sunrise-clinic/book.
//
// The address prefix becomes the router's basename, so every link inside the app (like /book) already points at
// the right clinic without any screen having to know about it.

import { createContext, useContext } from 'react';

const SLUG_IN_PATH = /^\/c\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\/|$)/;

export function clinicSlugFromPath(pathname: string): string | null {
  const match = SLUG_IN_PATH.exec(pathname);
  return match ? match[1] : null;
}

/** "/c/sunrise-clinic" for a clinic address, "" for everything else. */
export function clinicBasename(pathname: string): string {
  const slug = clinicSlugFromPath(pathname);
  return slug ? `/c/${slug}` : '';
}

export const ClinicSlugContext = createContext<string | null>(null);

/** The clinic address in the web address, or null on pages that are not tied to one clinic. */
export function useClinicSlug(): string | null {
  return useContext(ClinicSlugContext);
}

/** A full path for a clinic's public page, for places that cannot use the router (new tabs, copied links). */
export function clinicPath(slug: string, page: 'book' | 'queue' | 'tv' | ''): string {
  return `/c/${slug}${page ? `/${page}` : ''}`;
}
