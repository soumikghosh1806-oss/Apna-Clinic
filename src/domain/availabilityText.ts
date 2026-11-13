// Plain words about a doctor's day and queue, shared by the booking page and the clinic directory.

import { formatMinutes, parseHM } from './dates';
import type { Availability, QueueStatus } from './queue';

/** "10:00 am to 2:00 pm" from two HH:MM strings. */
export const timingText = (s: { start: string; end: string }) => `${formatMinutes(parseHM(s.start))} to ${formatMinutes(parseHM(s.end))}`;

/** One short line about a doctor's day. */
export function availabilityLine(info: Availability): string {
  switch (info.reason) {
    case 'doctor_unavailable':
      return 'Not available';
    case 'closed':
      return info.closedReason === 'holiday' ? 'Clinic closed' : info.closedReason === 'leave' ? 'Doctor not available' : 'No OPD on this day';
    case 'ended':
      return "Today's OPD is over";
    default:
      return `${Math.max(0, info.limit - info.issued)} of ${info.limit} tokens left`;
  }
}

/** The queue in a sentence: what the clinic says about it and how many are waiting. Numbers only, never names. */
export function queueLine(q: { status: QueueStatus; waitingCount: number; currentNumber: number | null; consulting: boolean }): string {
  if (q.status.code === 'closed') return q.status.label;
  if (q.consulting && q.currentNumber !== null) {
    return `Now serving token ${q.currentNumber}. ${q.waitingCount === 0 ? 'Nobody else is waiting.' : `${q.waitingCount} waiting.`}`;
  }
  return q.waitingCount > 0 ? `${q.status.label}. ${q.waitingCount} waiting.` : q.status.label;
}
