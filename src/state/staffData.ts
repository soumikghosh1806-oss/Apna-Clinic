// What the staff screens read beyond the shared queue: patient search, one patient's history, and the reports.
// Demo mode computes these from the local sample data. A real clinic asks the database, which applies the role rules.

import { useEffect, useMemo, useState } from 'react';
import { useStaffClinic } from '../backend/staffGate';
import { IS_SUPABASE } from '../backend/mode';
import {
  mapHistory,
  mapPatientHits,
  mapReportMonth,
  mapReportSeries,
  mapStaffList,
  mapVisitList,
  type HistoryData,
  type PatientHit,
  type StaffList,
  type VisitListItem,
} from '../backend/mappers';
import { rpc } from '../backend/rpc';
import { useRemote } from '../backend/useRemote';

import { getDoctor, getPatient, searchPatients, visitsFor } from '../domain/queue';
import { dayStats, lastSevenDays, monthlyCsv, rowsToCsv, weekSeries, type DayStats, type DoctorFilter } from '../domain/reports';
import type { DateKey } from '../domain/types';
import { useAppState } from './context';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ---------------------------------------------------------------------------------------------------------------
// Patient search (reception)
// ---------------------------------------------------------------------------------------------------------------

export interface PatientSearchState {
  results: PatientHit[];
  loading: boolean;
  message?: string;
}

function useDemoPatientSearch(query: string): PatientSearchState {
  const state = useAppState();
  const results = useMemo(() => searchPatients(state, query), [state, query]);
  return { results, loading: false };
}

function useRemotePatientSearch(query: string): PatientSearchState {
  const { clinicId } = useStaffClinic();
  const text = useDebounced(query.trim(), 250);
  const enabled = text.length >= 2;
  const remote = useRemote(
    async () => {
      const answer = await rpc('search_patients', { p_clinic: clinicId, p_query: text });
      return answer.ok ? { ok: true as const, value: mapPatientHits(answer.data) } : answer;
    },
    [clinicId, text],
    { enabled },
  );
  return {
    results: enabled ? (remote.data ?? []) : [],
    loading: enabled && remote.loading,
    message: remote.failure?.message,
  };
}

export const usePatientSearch: (query: string) => PatientSearchState = IS_SUPABASE ? useRemotePatientSearch : useDemoPatientSearch;

export interface VisitListState {
  visits: VisitListItem[];
  loading: boolean;
}

function useDemoVisitList(patientId: string | null): VisitListState {
  const state = useAppState();
  const visits = useMemo(
    () =>
      patientId
        ? visitsFor(state, patientId).map((v) => ({
            id: v.id,
            date: v.date,
            title: v.title,
            doctorLabel: getDoctor(state, v.doctorId)?.opd ?? 'OPD',
          }))
        : [],
    [state, patientId],
  );
  return { visits, loading: false };
}

function useRemoteVisitList(patientId: string | null): VisitListState {
  const { clinicId } = useStaffClinic();
  const remote = useRemote(
    async () => {
      const answer = await rpc('get_patient_visit_list', { p_clinic: clinicId, p_patient_id: patientId });
      return answer.ok ? { ok: true as const, value: mapVisitList(answer.data).visits } : answer;
    },
    [clinicId, patientId],
    { enabled: patientId !== null },
  );
  return { visits: remote.data ?? [], loading: remote.loading };
}

export const usePatientVisitList: (patientId: string | null) => VisitListState = IS_SUPABASE ? useRemoteVisitList : useDemoVisitList;

// ---------------------------------------------------------------------------------------------------------------
// One patient's full history (doctor)
// ---------------------------------------------------------------------------------------------------------------

export interface HistoryState {
  load: 'loading' | 'ready' | 'not_found' | 'error';
  message?: string;
  data: HistoryData | null;
  reload(): void;
}

function useDemoHistory(patientId: string): HistoryState {
  const state = useAppState();
  const patient = getPatient(state, patientId);
  const data = useMemo<HistoryData | null>(
    () => (patient ? { patient, visits: visitsFor(state, patient.id), otherReports: [] } : null),
    [state, patient],
  );
  return { load: data ? 'ready' : 'not_found', data, reload: () => undefined };
}

function useRemoteHistory(patientId: string): HistoryState {
  const { clinicId } = useStaffClinic();
  const remote = useRemote(
    async () => {
      const answer = await rpc('get_patient_history', { p_clinic: clinicId, p_patient_id: patientId });
      return answer.ok ? { ok: true as const, value: mapHistory(answer.data) } : answer;
    },
    [clinicId, patientId],
  );
  let load: HistoryState['load'] = 'loading';
  if (remote.data) load = 'ready';
  else if (remote.failure) load = remote.failure.code === 'not_found' ? 'not_found' : 'error';
  return { load, message: remote.failure?.message, data: remote.data ?? null, reload: remote.refresh };
}

export const usePatientHistory: (patientId: string) => HistoryState = IS_SUPABASE ? useRemoteHistory : useDemoHistory;

// ---------------------------------------------------------------------------------------------------------------
// Reports (owner, doctor)
// ---------------------------------------------------------------------------------------------------------------

export interface ReportData {
  load: 'loading' | 'ready' | 'error';
  message?: string;
  stats: DayStats;
  week: DayStats[];
  months: string[];
  month: string;
  csv: string;
  csvRows: number;
}

const emptyDay = (date: DateKey): DayStats => ({
  date,
  total: 0,
  completed: 0,
  noShow: 0,
  cancelled: 0,
  averageWaitMinutes: null,
  waitSamples: 0,
});

function useDemoReport(today: DateKey, date: DateKey, scope: DoctorFilter, monthChoice: string): ReportData {
  const state = useAppState();
  const months = [...new Set(state.tokens.map((t) => t.date.slice(0, 7)))].sort().reverse();
  const month = months.includes(monthChoice) ? monthChoice : (months[0] ?? '');
  const csv = month ? monthlyCsv(state, month) : '';
  return {
    load: 'ready',
    stats: dayStats(state, date, scope),
    week: weekSeries(state, today, scope),
    months,
    month,
    csv,
    csvRows: csv ? csv.split('\n').length - 1 : 0,
  };
}

/** The current month and the eleven before it, newest first, as YYYY-MM. */
export function lastMonths(today: DateKey, count = 12): string[] {
  const months: string[] = [];
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}

function useRemoteReport(today: DateKey, date: DateKey, scope: DoctorFilter, monthChoice: string): ReportData {
  const { clinicId } = useStaffClinic();
  const days = lastSevenDays(today);
  const series = useRemote(
    async () => {
      const answer = await rpc('get_report_series', {
        p_clinic: clinicId,
        p_end: today,
        p_doctor_id: scope === 'all' ? null : scope,
      });
      return answer.ok ? { ok: true as const, value: mapReportSeries(answer.data) } : answer;
    },
    [clinicId, today, scope],
    { intervalMs: 30000 },
  );
  const months = useMemo(() => lastMonths(today), [today]);
  const month = months.includes(monthChoice) ? monthChoice : months[0];
  const rows = useRemote(
    async () => {
      const answer = await rpc('get_report_month', { p_clinic: clinicId, p_month: `${month}-01`, p_doctor_id: null });
      return answer.ok ? { ok: true as const, value: mapReportMonth(answer.data) } : answer;
    },
    [clinicId, month],
  );

  const week = days.map((d) => series.data?.find((row) => row.date === d) ?? emptyDay(d));
  const csv = useMemo(() => (rows.data && rows.data.length > 0 ? rowsToCsv(rows.data) : ''), [rows.data]);
  const failure = series.failure ?? rows.failure;
  return {
    load: series.data ? 'ready' : failure ? 'error' : 'loading',
    message: failure?.message,
    stats: week.find((d) => d.date === date) ?? emptyDay(date),
    week,
    months,
    month,
    csv,
    csvRows: rows.data?.length ?? 0,
  };
}

export const useReportData: (today: DateKey, date: DateKey, scope: DoctorFilter, monthChoice: string) => ReportData = IS_SUPABASE
  ? useRemoteReport
  : useDemoReport;

// ---------------------------------------------------------------------------------------------------------------
// Staff list (owner, real backend only)
// ---------------------------------------------------------------------------------------------------------------

export function useStaffList() {
  const { clinicId } = useStaffClinic();
  return useRemote<StaffList>(
    async () => {
      const answer = await rpc('list_staff', { p_clinic: clinicId });
      return answer.ok ? { ok: true as const, value: mapStaffList(answer.data) } : answer;
    },
    [clinicId],
  );
}
