import { describe, expect, it, vi } from 'vitest';
import { rowsToCsv } from '../domain/reports';
import { describeAuthError, MIN_PASSWORD_LENGTH } from './auth';
import { clinicBasename, clinicPath, clinicSlugFromPath } from './clinicRoute';
import {
  dayOf,
  emptyState,
  mapBookedToken,
  mapDoctor,
  mapMemberships,
  mapRole,
  mapSettings,
  mapSnapshot,
  mapStatus,
  mapToken,
} from './mappers';
import { reportFileType, reportPath, safeFileName } from './remoteActions';
import { NETWORK_MESSAGE, readAnswer, toFailure } from './rpc';
import { createStaffStore } from './staffStore';
import { isValidSlug, slugify } from './slug';
import { shiftToZone } from './time';
import type { Membership } from './mappers';

describe('clinic web address', () => {
  it('turns a clinic name into a valid address', () => {
    expect(slugify('Sunrise Family Clinic, Pune')).toBe('sunrise-family-clinic-pune');
    expect(slugify('  Dr. Rao’s  Clinic!! ')).toBe('dr-rao-s-clinic');
    expect(slugify('Clínica São José')).toBe('clinica-sao-jose');
  });
  it('never ends with a hyphen after cutting to 40 characters', () => {
    const slug = slugify('a'.repeat(39) + ' bbbb');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
  it('returns an empty string when nothing usable is left', () => {
    expect(slugify('!!!')).toBe('');
  });
  it('accepts only the shapes the database accepts', () => {
    expect(isValidSlug('sunrise-clinic')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a'.repeat(41))).toBe(false);
    expect(isValidSlug('Sunrise')).toBe(false);
    expect(isValidSlug('sun--rise')).toBe(false);
    expect(isValidSlug('-sunrise')).toBe(false);
    expect(isValidSlug('sunrise-')).toBe(false);
  });
});

describe('clinic routes', () => {
  it('reads the clinic address from a patient page path', () => {
    expect(clinicSlugFromPath('/c/sunrise-clinic/book')).toBe('sunrise-clinic');
    expect(clinicSlugFromPath('/c/sunrise-clinic')).toBe('sunrise-clinic');
    expect(clinicSlugFromPath('/c/sunrise-clinic/')).toBe('sunrise-clinic');
  });
  it('ignores paths that are not under a clinic', () => {
    expect(clinicSlugFromPath('/reception')).toBeNull();
    expect(clinicSlugFromPath('/c/')).toBeNull();
    expect(clinicSlugFromPath('/c/Bad_Slug/book')).toBeNull();
    expect(clinicSlugFromPath('/cc/sunrise/book')).toBeNull();
    expect(clinicSlugFromPath('/c/sunrise-clinicX/book')).toBeNull();
  });
  it('builds the router base and full paths', () => {
    expect(clinicBasename('/c/sunrise-clinic/queue')).toBe('/c/sunrise-clinic');
    expect(clinicBasename('/login')).toBe('');
    expect(clinicPath('sunrise-clinic', 'tv')).toBe('/c/sunrise-clinic/tv');
    expect(clinicPath('sunrise-clinic', '')).toBe('/c/sunrise-clinic');
  });
});

describe('database answers', () => {
  it('passes a successful answer through', () => {
    const answer = readAnswer({ data: { ok: true, value: 3 }, error: null });
    expect(answer).toEqual({ ok: true, data: { ok: true, value: 3 } });
  });
  it('hides a database error behind the network message', () => {
    const answer = readAnswer({ data: null, error: { message: 'permission denied for table patients' } });
    expect(answer).toEqual({ ok: false, code: 'network', message: NETWORK_MESSAGE });
    expect(JSON.stringify(answer)).not.toContain('permission denied');
  });
  it('rejects an answer that is not an object', () => {
    for (const data of [null, 5, 'x', [1, 2]]) {
      const answer = readAnswer({ data, error: null });
      expect(answer.ok).toBe(false);
    }
  });
  it('keeps the code, message and field errors of a refusal', () => {
    const failure = toFailure({ ok: false, code: 'invalid_input', message: 'Fix it.', field_errors: { name: 'Too short' } });
    expect(failure).toEqual({ ok: false, code: 'invalid_input', message: 'Fix it.', fieldErrors: { name: 'Too short' } });
  });
  it('treats an unknown code as invalid input and never invents a message', () => {
    expect(toFailure({ code: 'weird' }).code).toBe('invalid_input');
    expect(toFailure({}).message).toMatch(/Something went wrong/);
  });
  it('gives a patient the secret key, staff the token id', () => {
    expect(toFailure({ code: 'duplicate', existing_access_key: 'key-1', existing_token_id: 'id-1' }).existingTokenId).toBe('key-1');
    expect(toFailure({ code: 'duplicate', existing_token_id: 'id-1' }).existingTokenId).toBe('id-1');
  });
});

describe('sign in messages', () => {
  it('never says which half of the sign in was wrong', () => {
    const message = describeAuthError({ code: 'invalid_credentials', status: 400 }, 'sign_in');
    expect(message).toBe('The email or password is not correct.');
    expect(message.toLowerCase()).not.toMatch(/no account|not found|unknown|does not exist/);
  });
  it('does not confirm that an email already has an account when signing up', () => {
    expect(describeAuthError({ code: 'user_already_exists' }, 'sign_up')).not.toMatch(/already (registered|exists|has)/i);
  });
  it('explains rate limits, unconfirmed email and weak passwords', () => {
    expect(describeAuthError({ status: 429 }, 'sign_in')).toMatch(/Too many attempts/);
    expect(describeAuthError({ code: 'email_not_confirmed' }, 'sign_in')).toMatch(/Confirm your email/);
    expect(describeAuthError({ code: 'weak_password' }, 'password')).toContain(String(MIN_PASSWORD_LENGTH));
  });
});

describe('clinic time', () => {
  it('shows the clock of the clinic, not of the device', () => {
    // 20:00 UTC on 8 November is 01:30 on 9 November in India.
    const shifted = shiftToZone(new Date('2026-11-08T20:00:00Z'), 'Asia/Kolkata');
    expect([shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate(), shifted.getHours(), shifted.getMinutes()]).toEqual([
      2026, 11, 9, 1, 30,
    ]);
  });
  it('leaves the date alone for no zone or an unknown zone', () => {
    const date = new Date('2026-11-08T20:00:00Z');
    expect(shiftToZone(date, null)).toBe(date);
    expect(shiftToZone(date, 'Not/AZone')).toBe(date);
  });
});

describe('mappers', () => {
  it('maps roles and statuses between the database and the screens', () => {
    expect(mapRole('receptionist')).toBe('reception');
    expect(mapRole('owner')).toBe('owner');
    expect(mapRole('patient')).toBeNull();
    expect(mapStatus('serving')).toBe('in_progress');
    expect(mapStatus('arrived')).toBe('waiting');
    expect(mapStatus('on_hold')).toBe('on_hold');
    expect(mapStatus('nonsense')).toBe('waiting');
  });
  it('keeps only the day part of a timestamp', () => {
    expect(dayOf('2026-11-08T23:30:00+00:00')).toBe('2026-11-08');
    expect(dayOf(undefined)).toBe('');
  });
  it('maps a token and ignores unknown arrival sources', () => {
    const token = mapToken({
      id: 't1', number: 4, order_key: 4.5, doctor_id: 'd1', patient_id: 'p1', date: '2026-11-08', source: 'walk_in',
      status: 'serving', created_at: '2026-11-08T05:00:00Z', arrived_at: '2026-11-08T05:01:00Z', arrival_source: 'telepathy', visit_number: 3,
    });
    expect(token).toMatchObject({ id: 't1', number: 4, orderKey: 4.5, source: 'walk_in', status: 'in_progress', visitNumber: 3 });
    expect(token.arrivalSource).toBeUndefined();
    expect(mapToken({ id: 't2', number: 1 }).source).toBe('online');
  });
  it('maps a patient booking by its secret key, not its id', () => {
    const token = mapBookedToken({ access_key: 'secret-key', token: { id: 'internal-id', number: 7, doctor_id: 'd1', date: '2026-11-08' } });
    expect(token.id).toBe('secret-key');
    expect(token.number).toBe(7);
    expect(token.patientId).toBe('');
  });
  it('maps doctors and settings with safe fallbacks', () => {
    expect(mapDoctor({ id: 'd', name: 'Dr A', opd: 'General', sessions: [{ start: '09:00', end: '12:00' }], daily_limit: null, has_login: true })).toMatchObject({
      active: true, hasLogin: true, dailyLimit: null, sessions: [{ start: '09:00', end: '12:00' }],
    });
    expect(mapDoctor({ id: 'd', active: false }).active).toBe(false);
    const settings = mapSettings({}, 'Clinic');
    expect(settings).toMatchObject({ clinicName: 'Clinic', onlineBookingEnabled: true, maxOnlineBookingsPerPhone: 4 });
    expect(mapSettings({ online_booking_enabled: false, max_online_bookings_per_phone_per_day: 2 }, 'C')).toMatchObject({
      onlineBookingEnabled: false, maxOnlineBookingsPerPhone: 2,
    });
  });
  it('builds the staff state from one snapshot, deriving patients from tokens', () => {
    const snapshot = mapSnapshot({
      clinic: { id: 'c1', name: 'Sunrise', slug: 'sunrise', timezone: 'Asia/Kolkata' },
      today: '2026-11-08', now: '2026-11-08T05:00:00Z', role: 'receptionist', my_doctor_id: null,
      settings: { default_daily_limit: 30 },
      doctors: [{ id: 'd1', name: 'Dr A', opd: 'General', sessions: [] }],
      tokens: [
        { id: 't1', number: 1, doctor_id: 'd1', patient_id: 'p1', patient_name: 'Asha', patient_phone: '9876543210', date: '2026-11-08', status: 'waiting' },
        { id: 't2', number: 2, doctor_id: 'd1', patient_id: 'p1', patient_name: 'Asha', patient_phone: '9876543210', date: '2026-11-08', status: 'waiting' },
      ],
    });
    expect(snapshot.role).toBe('reception');
    expect(snapshot.state.patients).toHaveLength(1);
    expect(snapshot.state.tokens).toHaveLength(2);
    expect(snapshot.state.settings.defaultDailyLimit).toBe(30);
    expect(snapshot.state.visits).toEqual([]);
  });
  it('does not crash on an empty or damaged snapshot', () => {
    expect(mapSnapshot({}).state.tokens).toEqual([]);
    expect(mapSnapshot({ tokens: 'oops', doctors: null }).state.doctors).toEqual([]);
    expect(emptyState('X').settings.clinicName).toBe('X');
  });
  it('lists only the clinics with a role the app knows', () => {
    const result = mapMemberships({
      profile: { full_name: 'Asha', email: 'a@example.test' },
      clinics: [
        { id: 'c1', name: 'A', slug: 'a-clinic', role: 'owner' },
        { id: 'c2', name: 'B', slug: 'b-clinic', role: 'receptionist', doctor_id: null },
        { id: 'c3', name: 'C', slug: 'c-clinic', role: 'janitor' },
      ],
    });
    expect(result.memberships.map((m) => m.role)).toEqual(['owner', 'reception']);
    expect(result.email).toBe('a@example.test');
  });
});

describe('report files', () => {
  it('accepts only the file types the storage bucket allows', () => {
    expect(reportFileType({ name: 'scan.PDF', type: '' })).toBe('application/pdf');
    expect(reportFileType({ name: 'photo.jpeg', type: 'image/jpeg' })).toBe('image/jpeg');
    expect(reportFileType({ name: 'x.webp', type: '' })).toBe('image/webp');
    expect(reportFileType({ name: 'virus.exe', type: 'application/x-msdownload' })).toBeNull();
    expect(reportFileType({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
  });
  it('makes a storage file name with no folders or unusual characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('Blood test (final).pdf')).toBe('Blood_test_final_.pdf');
    expect(safeFileName('रिपोर्ट')).toBe('report');
    expect(safeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
  it('keeps every file under the clinic and patient folders the storage policy checks', () => {
    expect(reportPath('clinic-1', 'patient-1', '../x.pdf', 'u1')).toBe('clinic-1/patient-1/u1-x.pdf');
    expect(reportPath('c', 'p', 'a/b/c.pdf', 'u').split('/')).toHaveLength(3);
  });
});

describe('monthly report file', () => {
  it('writes counts only, escapes cells and blocks spreadsheet formulas', () => {
    const csv = rowsToCsv([
      { date: '2026-11-08', opd: 'General, East', total: 5, completed: 4, noShow: 1, cancelled: 0, averageWaitMinutes: 12 },
      { date: '2026-11-09', opd: '=SUM(A1)', total: 0, completed: 0, noShow: 0, cancelled: 1, averageWaitMinutes: null },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('date,opd,tokens_issued,completed,no_show,cancelled,average_wait_minutes');
    expect(lines[1]).toBe('2026-11-08,"General, East",5,4,1,0,12');
    expect(lines[2]).toBe("2026-11-09,'=SUM(A1),0,0,0,1,");
  });
});

const membership: Membership = { clinicId: 'c1', name: 'Sunrise', slug: 'sunrise', timezone: 'Asia/Kolkata', role: 'owner', doctorId: null };
const snapshotDto = (extra: Record<string, unknown> = {}) => ({
  ok: true, clinic: { id: 'c1', name: 'Sunrise', slug: 'sunrise' }, today: '2026-11-08', now: new Date().toISOString(), role: 'owner', tokens: [], doctors: [], ...extra,
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('staff data store', () => {
  it('loads once by itself at start, then reports ready', async () => {
    const fetchSnapshot = vi.fn(async () => ({ ok: true as const, data: snapshotDto() }));
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    expect(store.getStatus().phase).toBe('loading');
    await tick(10);
    expect(store.getStatus()).toMatchObject({ phase: 'ready', stale: false });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    store.dispose();
  });
  it('does not tell screens anything changed when only the server clock moved', async () => {
    let n = 0;
    const fetchSnapshot = async () => ({ ok: true as const, data: snapshotDto({ now: `2026-11-08T05:00:0${n++}Z` }) });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await store.reload();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.reload();
    await store.reload();
    expect(listener).not.toHaveBeenCalled();
    store.dispose();
  });
  it('tells screens when the data really changed', async () => {
    let tokens: unknown[] = [];
    const fetchSnapshot = async () => ({ ok: true as const, data: snapshotDto({ tokens }) });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await store.reload();
    const listener = vi.fn();
    store.subscribe(listener);
    tokens = [{ id: 't1', number: 1, doctor_id: 'd', patient_id: 'p', status: 'waiting', date: '2026-11-08' }];
    await store.reload();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().tokens).toHaveLength(1);
    store.dispose();
  });
  it('runs one request at a time and folds extra requests into one follow-up', async () => {
    let running = 0;
    let peak = 0;
    const fetchSnapshot = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(20);
      running -= 1;
      return { ok: true as const, data: snapshotDto() };
    });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await Promise.all([store.reload(), store.reload(), store.reload(), store.reload()]);
    await tick(60);
    expect(peak).toBe(1);
    expect(fetchSnapshot.mock.calls.length).toBeLessThanOrEqual(3);
    store.dispose();
  });
  it('a reload asked for while a request is running waits for a request that starts after the ask', async () => {
    // The running request read the queue before the action; the reload is asked for after it. The screen must not be told
    // "done" while it still shows the old queue (that let NEXT be sent from a stale screen).
    let tokens: unknown[] = [];
    const fetchSnapshot = vi.fn(async () => {
      const readAtStart = snapshotDto({ tokens });
      await tick(30);
      return { ok: true as const, data: readAtStart };
    });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    // The start up request is running now and has already read an empty queue.
    tokens = [{ id: 't1', number: 1, doctor_id: 'd', patient_id: 'p', status: 'on_hold', date: '2026-11-08' }];
    await store.reload();
    expect(store.getState().tokens).toHaveLength(1);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    store.dispose();
  });
  it('recovers when a request throws instead of answering', async () => {
    let calls = 0;
    const fetchSnapshot = vi.fn(async () => {
      calls += 1;
      await tick(10);
      if (calls === 1) throw new Error('boom');
      return { ok: true as const, data: snapshotDto() };
    });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await store.reload().catch(() => undefined);
    await store.reload();
    expect(store.getStatus()).toMatchObject({ phase: 'ready', stale: false });
    store.dispose();
  });
  it('requests that pile up during one running request still share a single follow-up request', async () => {
    const fetchSnapshot = vi.fn(async () => {
      await tick(20);
      return { ok: true as const, data: snapshotDto() };
    });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await Promise.all([store.reload(), store.reload(), store.reload(), store.reload(), store.reload()]);
    await tick(60);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    store.dispose();
  });
  it('keeps the old data and marks it stale when a refresh fails', async () => {
    let fail = false;
    const fetchSnapshot = async () =>
      fail ? { ok: false as const, code: 'network' as const, message: 'offline' } : { ok: true as const, data: snapshotDto({ doctors: [{ id: 'd1', name: 'Dr A', opd: 'General' }] }) };
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await store.reload();
    fail = true;
    await store.reload();
    expect(store.getStatus()).toMatchObject({ phase: 'ready', stale: true });
    expect(store.getState().doctors).toHaveLength(1);
    fail = false;
    await store.reload();
    expect(store.getStatus().stale).toBe(false);
    store.dispose();
  });
  it('shows an error, not an empty clinic, when the very first load fails', async () => {
    const fetchSnapshot = async () => ({ ok: false as const, code: 'forbidden' as const, message: 'No access' });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => () => undefined });
    await store.reload();
    expect(store.getStatus()).toMatchObject({ phase: 'error' });
    expect(store.getStatus().failure?.code).toBe('forbidden');
    store.dispose();
  });
  it('reloads shortly after a realtime signal, and stops listening when disposed', async () => {
    let signal: () => void = () => undefined;
    const stop = vi.fn();
    const fetchSnapshot = vi.fn(async () => ({ ok: true as const, data: snapshotDto() }));
    const store = createStaffStore(membership, {
      fetchSnapshot,
      listen: async (_id, onSignal) => {
        signal = onSignal;
        return stop;
      },
      signalDelayMs: 10,
    });
    await store.reload();
    await tick(5);
    const before = fetchSnapshot.mock.calls.length;
    signal();
    signal();
    signal();
    await tick(60);
    expect(fetchSnapshot.mock.calls.length).toBe(before + 1);
    store.dispose();
    expect(stop).toHaveBeenCalled();
  });
  it('treats a failure to start listening as harmless', async () => {
    const fetchSnapshot = async () => ({ ok: true as const, data: snapshotDto() });
    const store = createStaffStore(membership, { fetchSnapshot, listen: async () => Promise.reject(new Error('no realtime')) });
    await store.reload();
    expect(store.getStatus().phase).toBe('ready');
    store.dispose();
  });
});
