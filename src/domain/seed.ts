// Builds the sample data the demo starts with. Everything here is invented.
// The data is generated from today's date so that "today" always has a believable queue.
// A fixed random seed keeps the result identical for the same date, which keeps tests stable.

import { addDays, fromDateKey, parseHM, toDateKey } from './dates';
import type {
  AppState,
  ArrivalSource,
  DateKey,
  Doctor,
  Patient,
  Token,
  TokenSource,
  TokenStatus,
  Visit,
} from './types';

export const GENERAL_DOCTOR_ID = 'doc-general';
export const CHILD_DOCTOR_ID = 'doc-child';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATIENT_NAMES = [
  'Meera Kapoor',
  'Aarav Kapoor',
  'Rahul Sen',
  'Priya Nair',
  'Imran Khan',
  'Sunita Devi',
  'Arjun Reddy',
  'Kavita Joshi',
  'Mohan Das',
  'Neha Gupta',
  'Vikram Singh',
  'Ananya Bose',
  'Farhan Ali',
  'Lakshmi Iyer',
  'Sanjay Patil',
  'Pooja Mishra',
  'Deepak Kumar',
  'Rekha Menon',
  'Amit Shah',
  'Shreya Ghosh',
  'Ravi Teja',
  'Nisha Verma',
  'Harish Rao',
  'Tanvi Desai',
  'Manoj Tiwari',
  'Fatima Sheikh',
  'Gopal Yadav',
  'Ishita Roy',
  'Karthik Subramanian',
  'Ritu Agarwal',
];

/** Generic, non medical wording. The demo never creates diagnoses or prescriptions. */
const VISIT_TEMPLATES = [
  {
    title: 'Fever and body ache',
    notes: 'Sample note: temperature checked, no other concerns recorded.',
    advice: 'Sample advice: rest and fluids, come back if it continues.',
  },
  {
    title: 'Cough and cold',
    notes: 'Sample note: symptoms for three days, breathing normal.',
    advice: 'Sample advice: warm drinks and rest, review after a week.',
  },
  {
    title: 'Routine check-up',
    notes: 'Sample note: general check-up, nothing unusual recorded.',
    advice: 'Sample advice: regular meals and sleep.',
  },
  {
    title: 'Follow-up visit',
    notes: 'Sample note: feeling better since the last visit.',
    advice: 'Sample advice: no further visit needed unless symptoms return.',
  },
  {
    title: 'Stomach upset',
    notes: 'Sample note: discomfort since yesterday, eating normally today.',
    advice: 'Sample advice: light food and plenty of water.',
  },
  {
    title: 'Skin rash',
    notes: 'Sample note: small area affected, no other symptoms recorded.',
    advice: 'Sample advice: keep the area clean and dry.',
  },
];

/** Patients 1 and 2 are a parent and child who share one phone number. */
function phoneFor(index: number): string {
  if (index <= 2) return '9000000001';
  return String(9000000000 + index);
}

export function createSeed(now: Date): AppState {
  const today = toDateKey(now);
  const rng = mulberry32(20260101);
  const nowMs = now.getTime();
  const ago = (minutes: number) => new Date(nowMs - minutes * 60000).toISOString();
  const at = (date: DateKey, minuteOfDay: number) => {
    const d = fromDateKey(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minuteOfDay).toISOString();
  };
  const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const doctors: Doctor[] = [
    {
      id: GENERAL_DOCTOR_ID,
      name: 'Dr. Asha Verma',
      opd: 'General OPD',
      sessions: [
        { start: '10:00', end: '14:00' },
        { start: '17:00', end: '21:00' },
      ],
      dailyLimit: null,
      minutesPerPatient: null,
      active: true,
    },
    {
      id: CHILD_DOCTOR_ID,
      name: 'Dr. Rohan Iyer',
      opd: 'Child OPD',
      sessions: [
        { start: '10:00', end: '13:00' },
        { start: '16:00', end: '19:00' },
      ],
      dailyLimit: null,
      minutesPerPatient: null,
      active: true,
    },
  ];

  const patients: Patient[] = PATIENT_NAMES.map((name, i) => ({
    id: `pat-s${String(i + 1).padStart(2, '0')}`,
    name,
    phone: phoneFor(i + 1),
    sample: true,
  }));
  const meera = patients[0];
  const aarav = patients[1];
  const pool = patients.slice(2);

  const tokens: Token[] = [];
  const visits: Visit[] = [];
  let tokenCounter = 0;
  let visitCounter = 0;

  const addVisit = (patientId: string, doctorId: string, date: DateKey, createdAt: string, tokenId?: string) => {
    const template = VISIT_TEMPLATES[Math.floor(rng() * VISIT_TEMPLATES.length)];
    visitCounter += 1;
    visits.push({
      id: `vis-seed-${visitCounter}`,
      patientId,
      doctorId,
      date,
      tokenId,
      title: template.title,
      notes: template.notes,
      advice: template.advice,
      attachments: [],
      sample: true,
      createdAt,
    });
  };

  interface TokenSpec {
    date: DateKey;
    doctorId: string;
    patientId: string;
    number: number;
    source: TokenSource;
    status: TokenStatus;
    createdAt: string;
    arrivedAt?: string;
    arrivalSource?: ArrivalSource;
    startedAt?: string;
    completedAt?: string;
  }

  const addToken = (spec: TokenSpec) => {
    tokenCounter += 1;
    const token: Token = { id: `tok-seed-${tokenCounter}`, orderKey: spec.number, ...spec };
    tokens.push(token);
    if (spec.status === 'completed') {
      addVisit(spec.patientId, spec.doctorId, spec.date, spec.completedAt ?? spec.createdAt, token.id);
    }
  };

  // Earlier visits so patient search has history to show.
  const olderVisit = (patientId: string, daysAgo: number, doctorId = GENERAL_DOCTOR_ID) => {
    const date = addDays(today, -daysAgo);
    addVisit(patientId, doctorId, date, at(date, 11 * 60));
  };
  olderVisit(meera.id, 58);
  olderVisit(meera.id, 40);
  olderVisit(meera.id, 12);
  olderVisit(aarav.id, 41, CHILD_DOCTOR_ID);
  for (const patient of pool) {
    const count = Math.floor(rng() * 3);
    for (let i = 0; i < count; i += 1) {
      olderVisit(patient.id, 8 + Math.floor(rng() * 80), rng() < 0.3 ? CHILD_DOCTOR_ID : GENERAL_DOCTOR_ID);
    }
  }

  // The six days before today, so the seven day chart has real records behind it.
  for (let offset = 6; offset >= 1; offset -= 1) {
    const date = addDays(today, -offset);
    for (const doctor of doctors) {
      const isGeneral = doctor.id === GENERAL_DOCTOR_ID;
      const count = isGeneral ? 9 + Math.floor(rng() * 9) : 3 + Math.floor(rng() * 5);
      const dayPatients = shuffle(pool).slice(0, count);
      const startMinute = parseHM(doctor.sessions[0].start);
      dayPatients.forEach((patient, i) => {
        const number = i + 1;
        const online = rng() < 0.6;
        const startedMin = startMinute + i * 6 + Math.floor(rng() * 3);
        const arrivedMin = startedMin - (4 + Math.floor(rng() * 18));
        const roll = rng();
        const status: TokenStatus = roll < 0.08 ? 'no_show' : roll < 0.11 ? 'cancelled' : 'completed';
        const arrived = status === 'completed';
        addToken({
          date,
          doctorId: doctor.id,
          patientId: patient.id,
          number,
          source: online ? 'online' : 'walk_in',
          status,
          createdAt: online ? at(addDays(date, -1), 19 * 60) : at(date, arrivedMin),
          ...(arrived
            ? {
                arrivedAt: at(date, arrivedMin),
                arrivalSource: online ? ('reception' as const) : ('walk_in' as const),
                startedAt: at(date, startedMin),
                completedAt: at(date, startedMin + 4 + Math.floor(rng() * 5)),
              }
            : {}),
        });
      });
    }
  }

  // Today, General OPD. Some tokens are done, one is with the doctor, the rest are in different states.
  const generalToday = shuffle(pool).slice(0, 17);
  const g = (n: number) => generalToday[n - 1].id;
  for (let n = 1; n <= 8; n += 1) {
    const startedAgo = (9 - n) * 7 + 4;
    const online = n % 2 === 1;
    addToken({
      date: today,
      doctorId: GENERAL_DOCTOR_ID,
      patientId: g(n),
      number: n,
      source: online ? 'online' : 'walk_in',
      status: 'completed',
      createdAt: online ? ago(startedAgo + 240) : ago(startedAgo + 12),
      arrivedAt: ago(startedAgo + 12),
      arrivalSource: online ? 'reception' : 'walk_in',
      startedAt: ago(startedAgo),
      completedAt: ago(startedAgo - 5),
    });
  }
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(9),
    number: 9,
    source: 'online',
    status: 'no_show',
    createdAt: ago(300),
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(10),
    number: 10,
    source: 'online',
    status: 'in_progress',
    createdAt: ago(280),
    arrivedAt: ago(20),
    arrivalSource: 'reception',
    startedAt: ago(2),
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(11),
    number: 11,
    source: 'walk_in',
    status: 'on_hold',
    createdAt: ago(45),
    arrivedAt: ago(45),
    arrivalSource: 'walk_in',
    startedAt: ago(18),
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: meera.id,
    number: 12,
    source: 'online',
    status: 'waiting',
    createdAt: ago(260),
    arrivedAt: ago(10),
    arrivalSource: 'reception',
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(13),
    number: 13,
    source: 'online',
    status: 'skipped',
    createdAt: ago(250),
    arrivedAt: ago(26),
    arrivalSource: 'reception',
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(14),
    number: 14,
    source: 'online',
    status: 'waiting',
    createdAt: ago(200),
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(15),
    number: 15,
    source: 'walk_in',
    status: 'waiting',
    createdAt: ago(6),
    arrivedAt: ago(6),
    arrivalSource: 'walk_in',
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(16),
    number: 16,
    source: 'online',
    status: 'waiting',
    createdAt: ago(150),
    arrivedAt: ago(3),
    arrivalSource: 'reception',
  });
  addToken({
    date: today,
    doctorId: GENERAL_DOCTOR_ID,
    patientId: g(17),
    number: 17,
    source: 'online',
    status: 'waiting',
    createdAt: ago(90),
  });

  // Today, Child OPD.
  const childToday = shuffle(pool.filter((p) => !generalToday.some((x) => x.id === p.id))).slice(0, 5);
  for (let n = 1; n <= 2; n += 1) {
    const startedAgo = (3 - n) * 8 + 6;
    addToken({
      date: today,
      doctorId: CHILD_DOCTOR_ID,
      patientId: childToday[n - 1].id,
      number: n,
      source: n === 1 ? 'online' : 'walk_in',
      status: 'completed',
      createdAt: ago(startedAgo + 120),
      arrivedAt: ago(startedAgo + 9),
      arrivalSource: n === 1 ? 'reception' : 'walk_in',
      startedAt: ago(startedAgo),
      completedAt: ago(startedAgo - 6),
    });
  }
  addToken({
    date: today,
    doctorId: CHILD_DOCTOR_ID,
    patientId: childToday[2].id,
    number: 3,
    source: 'online',
    status: 'in_progress',
    createdAt: ago(200),
    arrivedAt: ago(15),
    arrivalSource: 'reception',
    startedAt: ago(4),
  });
  addToken({
    date: today,
    doctorId: CHILD_DOCTOR_ID,
    patientId: aarav.id,
    number: 4,
    source: 'online',
    status: 'waiting',
    createdAt: ago(180),
    arrivedAt: ago(8),
    arrivalSource: 'reception',
  });
  addToken({
    date: today,
    doctorId: CHILD_DOCTOR_ID,
    patientId: childToday[3].id,
    number: 5,
    source: 'online',
    status: 'waiting',
    createdAt: ago(100),
  });
  addToken({
    date: today,
    doctorId: CHILD_DOCTOR_ID,
    patientId: childToday[4].id,
    number: 6,
    source: 'online',
    status: 'waiting',
    createdAt: ago(60),
  });

  // Tomorrow, a few online bookings so the "tomorrow" choice has something behind it.
  const tomorrow = addDays(today, 1);
  const tomorrowPatients = shuffle(pool).slice(0, 4);
  tomorrowPatients.slice(0, 3).forEach((patient, i) => {
    addToken({
      date: tomorrow,
      doctorId: GENERAL_DOCTOR_ID,
      patientId: patient.id,
      number: i + 1,
      source: 'online',
      status: 'waiting',
      createdAt: ago(30 + i * 10),
    });
  });
  addToken({
    date: tomorrow,
    doctorId: CHILD_DOCTOR_ID,
    patientId: tomorrowPatients[3].id,
    number: 1,
    source: 'online',
    status: 'waiting',
    createdAt: ago(20),
  });

  return {
    schema: 1,
    seededOn: today,
    updatedAt: now.toISOString(),
    idCounter: 1000,
    settings: {
      clinicName: 'Sample Clinic',
      onlineBookingEnabled: true,
      defaultDailyLimit: 60,
      defaultMinutesPerPatient: 5,
    },
    doctors,
    patients,
    tokens,
    visits,
  };
}
