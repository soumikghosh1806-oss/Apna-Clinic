// Clinic time. The screens read "today" and the time of day from a Date's local fields.
// For a real clinic those must be the clinic's own clock, not the visitor's device clock, so a Date is shifted
// so that its local fields show the time in the clinic's time zone. Screens then work without changes.

const cache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let f = cache.get(timeZone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  cache.set(timeZone, f);
  return f;
}

/** A Date whose year, month, day, hour, minute and second (read locally) match `date` on a clock in `timeZone`. */
export function shiftToZone(date: Date, timeZone: string | null | undefined): Date {
  if (!timeZone) return date;
  const f = formatterFor(timeZone);
  if (!f) return date;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
