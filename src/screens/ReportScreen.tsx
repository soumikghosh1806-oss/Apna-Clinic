// Screen 10: Daily report (owner, also open to doctors)

import { Download } from 'lucide-react';
import { useState } from 'react';
import { ClinicNotice } from '../components/ClinicNotice';
import { WeekChart } from '../components/WeekChart';
import { Button, DemoTag, Notice, PageHeader, SelectField } from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { formatDate, formatShortDate, formatWeekday, relativeDayLabel, toDateKey } from '../domain/dates';
import { activeDoctors } from '../domain/queue';
import { lastSevenDays, type DoctorFilter } from '../domain/reports';
import { useLiveQueue } from '../state/hooks';
import { useReportData } from '../state/staffData';

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

export function ReportScreen() {
  const { state, now } = useLiveQueue();
  const today = toDateKey(now);
  const days = lastSevenDays(today);
  const doctors = activeDoctors(state);

  const [dayChoice, setDayChoice] = useState(today);
  const [doctor, setDoctor] = useState<DoctorFilter>('all');
  const [monthChoice, setMonthChoice] = useState('');

  const date = days.includes(dayChoice) ? dayChoice : today;
  const scope: DoctorFilter = doctor === 'all' || doctors.some((d) => d.id === doctor) ? doctor : 'all';
  const scopeLabel = scope === 'all' ? 'All OPDs' : (doctors.find((d) => d.id === scope)?.opd ?? 'All OPDs');

  const { load, message, stats, week, months, month, csv, csvRows } = useReportData(today, date, scope, monthChoice);

  function download() {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = IS_SUPABASE ? `clinic-report-${month}.csv` : `clinic-report-${month}-demo.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Daily report"
        intro={
          IS_SUPABASE ? (
            'Numbers are counted from this clinic\'s own records, in the clinic\'s time zone.'
          ) : (
            <>
              Numbers are counted from the demo records. <DemoTag>Demo data</DemoTag>
            </>
          )
        }
      />

      {load !== 'ready' && (
        <div style={{ marginBottom: 16 }}>
          <ClinicNotice load={load} message={message} />
        </div>
      )}

      <form className="card" onSubmit={(e) => e.preventDefault()} aria-label="Report filters" style={{ marginBottom: 16 }}>
        <div className="grid grid--2">
          <SelectField label="Day" value={date} onChange={(e) => setDayChoice(e.target.value)}>
            {[...days].reverse().map((d) => (
              <option key={d} value={d}>
                {relativeDayLabel(d, today) === formatDate(d) ? formatDate(d) : `${relativeDayLabel(d, today)}, ${formatDate(d)}`}
              </option>
            ))}
          </SelectField>
          <SelectField label="Doctor or OPD" value={scope} onChange={(e) => setDoctor(e.target.value)}>
            <option value="all">All OPDs</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.opd} ({d.name})
              </option>
            ))}
          </SelectField>
        </div>
      </form>

      <section aria-label={`Figures for ${formatDate(date)}`} className="grid grid--4">
        <div className="kpi">
          <div className="kpi__label">Total patients</div>
          <div className="kpi__value">{stats.total}</div>
          <div className="kpi__note">Tokens issued, cancelled not counted</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Average waiting time</div>
          <div className="kpi__value">{stats.averageWaitMinutes === null ? 'None yet' : `${stats.averageWaitMinutes} min`}</div>
          <div className="kpi__note">
            {stats.waitSamples === 0
              ? 'No patient has both an arrival and a call time'
              : `From ${stats.waitSamples} ${stats.waitSamples === 1 ? 'patient' : 'patients'}`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Completed consultations</div>
          <div className="kpi__value">{stats.completed}</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">No-shows</div>
          <div className="kpi__value">{stats.noShow}</div>
          {stats.cancelled > 0 && <div className="kpi__note">{stats.cancelled} cancelled by patients</div>}
        </div>
      </section>
      <p className="muted small" style={{ marginTop: 8 }}>
        Waiting time is the time from the reception marking a patient as arrived (or a walk-in being created) to the
        doctor calling them. Patients called without a recorded arrival are left out.
      </p>

      <section className="card" aria-labelledby="week-title" style={{ marginTop: 16 }}>
        <h2 id="week-title">Patients per day, last 7 days</h2>
        <p className="muted small">
          {scopeLabel}. Tokens issued each day. Select a day to see its figures above. <DemoTag>Demo data</DemoTag>
        </p>
        <WeekChart data={week} selectedDate={date} today={today} scopeLabel={scopeLabel} onSelect={setDayChoice} />

        <details>
          <summary>View the same numbers as a table</summary>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Patients per day for the last 7 days, {scopeLabel}</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col" className="num">
                    Patients
                  </th>
                  <th scope="col" className="num">
                    Completed
                  </th>
                  <th scope="col" className="num">
                    No-shows
                  </th>
                  <th scope="col" className="num">
                    Average wait (min)
                  </th>
                </tr>
              </thead>
              <tbody>
                {week.map((d) => (
                  <tr key={d.date}>
                    <th scope="row">
                      {formatWeekday(d.date)} {formatShortDate(d.date)}
                      {d.date === today && ' (today)'}
                    </th>
                    <td className="num">{d.total}</td>
                    <td className="num">{d.completed}</td>
                    <td className="num">{d.noShow}</td>
                    <td className="num">{d.averageWaitMinutes ?? 'None'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card" aria-labelledby="export-title" style={{ marginTop: 16 }}>
        <h2 id="export-title">Monthly report export</h2>
        <p className="muted">
          Download a CSV file with one row per OPD per day. It has counts only, with no patient names or phone numbers.
          {IS_SUPABASE ? '' : ' The demo only holds the last few days, so the file covers those days of the month.'}
        </p>
        {months.length === 0 ? (
          <Notice kind="info" title="There is no data to export." live={false} />
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ minWidth: 220 }}>
              <SelectField label="Month" value={month} onChange={(e) => setMonthChoice(e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="field">
              <Button icon={Download} onClick={download} disabled={csvRows === 0}>
                Download CSV ({csvRows} rows)
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
