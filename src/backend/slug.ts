// Clinic web address helpers. A clinic's address is 3 to 40 lowercase letters, numbers and single hyphens,
// the same rule the database enforces.

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** "Sunrise Family Clinic, Pune" becomes "sunrise-family-clinic-pune". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}
