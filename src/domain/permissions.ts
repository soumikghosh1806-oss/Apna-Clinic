import type { Actor } from './types';

/**
 * Which demo role may do what. This is demo authorization for a frontend prototype.
 * A real deployment must enforce the same rules on a server.
 */
export type Action =
  | 'booking.create'
  | 'booking.cancel'
  | 'walkin.create'
  | 'arrival.mark'
  | 'noshow.mark'
  | 'queue.requeue'
  | 'queue.callNext'
  | 'queue.complete'
  | 'queue.skip'
  | 'queue.hold'
  | 'queue.resume'
  | 'visit.write'
  | 'history.read'
  | 'patients.search'
  | 'report.read'
  | 'settings.write'
  | 'demo.reset';

const ALL: Actor[] = ['patient', 'reception', 'doctor', 'owner'];

const MATRIX: Record<Action, Actor[]> = {
  'booking.create': ['patient'],
  'booking.cancel': ['patient'],
  'walkin.create': ['reception'],
  'arrival.mark': ['reception'],
  'noshow.mark': ['reception'],
  'queue.requeue': ['reception', 'doctor'],
  'queue.callNext': ['doctor'],
  'queue.complete': ['doctor'],
  'queue.skip': ['doctor'],
  'queue.hold': ['doctor'],
  'queue.resume': ['doctor'],
  'visit.write': ['doctor'],
  'history.read': ['doctor'],
  'patients.search': ['reception'],
  'report.read': ['owner', 'doctor'],
  'settings.write': ['owner'],
  'demo.reset': ALL,
};

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actor);
}

/** First screen each role sees after signing in. */
export const ROLE_HOME: Record<'reception' | 'doctor' | 'owner', string> = {
  reception: '/reception',
  doctor: '/doctor',
  owner: '/report',
};

/** Screens each role may open. Used to decide whether to send someone back to the page they asked for. */
const ROLE_PATHS: Record<'reception' | 'doctor' | 'owner', string[]> = {
  reception: ['/reception'],
  doctor: ['/doctor', '/report'],
  owner: ['/report', '/settings'],
};

export function canOpenPath(role: 'reception' | 'doctor' | 'owner', path: string): boolean {
  return ROLE_PATHS[role].some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));
}
