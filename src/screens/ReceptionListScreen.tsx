// Screen 4: Today's reception list

import { Check, Search, Undo2, UserX } from 'lucide-react';
import { useState } from 'react';
import { Button, ArrivalBadge, DemoTag, EmptyState, LiveRegion, Notice, PageHeader, SelectField, StatusBadge, TextField, TokenNumber } from '../components/ui';
import { formatTime, toDateKey } from '../domain/dates';
import { activeDoctors, currentToken, getDoctor, getPatient } from '../domain/queue';
import { receptionRows, type StatusFilter } from '../domain/reception';
import { dayStats } from '../domain/reports';
import type { Result, Token } from '../domain/types';
import { maskPhone } from '../domain/validation';
import { useActions } from '../state/context';
import { useLiveQueue } from '../state/hooks';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'not_arrived', label: 'Waiting, not arrived' },
  { value: 'arrived', label: 'Waiting, arrived' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'no_show', label: 'No-show' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function ReceptionListScreen() {
  const { state, now } = useLiveQueue();
  const actions = useActions();
  const today = toDateKey(now);
  const doctors = activeDoctors(state);

  const [query, setQuery] = useState('');
  const [doctorId, setDoctorId] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const allRows = receptionRows(state, today, { query: '', doctorId: 'all', status: 'all' });
  const rows = receptionRows(state, today, { query, doctorId, status });
  const totals = dayStats(state, today, 'all');
  const count = (s: Token['status']) => allRows.filter((r) => r.token.status === s).length;
  const filtered = query.trim() !== '' || doctorId !== 'all' || status !== 'all';

  async function report(pending: Promise<Result<Token>>, success: (t: Token) => string) {
    const result = await pending;
    setMessage(result.ok ? { kind: 'success', text: success(result.value) } : { kind: 'error', text: result.message });
  }

  return (
    <>
      <PageHeader
        title="Today's list"
        intro={
          <>
            All tokens for today, online and walk-in, in one list. <DemoTag />
          </>
        }
      />

      <section aria-label="Today's totals" className="grid grid--4" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi__label">Tokens today</div>
          <div className="kpi__value">{totals.total}</div>
          <div className="kpi__note">Cancelled tokens not counted</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Waiting</div>
          <div className="kpi__value">{count('waiting')}</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Completed</div>
          <div className="kpi__value">{count('completed')}</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">No-show</div>
          <div className="kpi__value">{count('no_show')}</div>
        </div>
      </section>

      <section aria-label="Currently serving" className="grid grid--2" style={{ marginBottom: 16 }}>
        {doctors.map((doctor) => {
          const current = currentToken(state, doctor.id, today);
          const patient = current ? getPatient(state, current.patientId) : undefined;
          return (
            <div className="card" key={doctor.id}>
              <div className="kpi__label">Now serving, {doctor.opd}</div>
              {current ? (
                <p className="row" style={{ margin: 0 }}>
                  <TokenNumber number={current.number} className="kpi__value" />
                  <span>{patient?.name}</span>
                </p>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  No patient is with {doctor.name} right now.
                </p>
              )}
            </div>
          );
        })}
      </section>

      <form className="card" onSubmit={(e) => e.preventDefault()} role="search" aria-label="Search and filter tokens">
        <div className="grid grid--3">
          <TextField
            label="Search by name, phone or token"
            type="search"
            name="query"
            icon={Search}
            autoComplete="off"
            placeholder="Name, phone or #12"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <SelectField label="Doctor or OPD" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="all">All doctors</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.opd} ({d.name})
              </option>
            ))}
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
      </form>

      <div style={{ margin: '16px 0' }}>
        <LiveRegion>{message && <Notice kind={message.kind} title={message.text} />}</LiveRegion>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={filtered ? 'No tokens match your search.' : 'No tokens have been issued today.'}>
          {filtered && (
            <p>
              <Button
                size="sm"
                onClick={() => {
                  setQuery('');
                  setDoctorId('all');
                  setStatus('all');
                }}
              >
                Clear search and filters
              </Button>
            </p>
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption>
              Showing {rows.length} of {allRows.length} tokens
            </caption>
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col">Patient</th>
                <th scope="col">OPD</th>
                <th scope="col">Booked</th>
                <th scope="col">Arrival</th>
                <th scope="col">Queue status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ token, patient }) => {
                const doctor = getDoctor(state, token.doctorId);
                const open = token.status === 'waiting' || token.status === 'skipped' || token.status === 'on_hold';
                const label = (text: string) => (
                  <>
                    {text}
                    <span className="sr-only"> for token {token.number}</span>
                  </>
                );
                return (
                  <tr key={token.id}>
                    <td data-label="Token">
                      <TokenNumber number={token.number} />
                    </td>
                    <td data-label="Patient">
                      <strong>{patient.name}</strong>
                      <br />
                      <span className="muted small mono">{maskPhone(patient.phone)}</span>
                    </td>
                    <td data-label="OPD">{doctor?.opd}</td>
                    <td data-label="Booked">{token.source === 'online' ? 'Online' : 'Walk-in'}</td>
                    <td data-label="Arrival">
                      <ArrivalBadge token={token} />
                      {token.arrivedAt && open && (
                        <span className="muted small"> {formatTime(new Date(token.arrivedAt))}</span>
                      )}
                    </td>
                    <td data-label="Queue status">
                      <StatusBadge status={token.status} />
                    </td>
                    <td data-label="Actions">
                      <div className="actions">
                        {open && !token.arrivedAt && (
                          <Button
                            size="sm"
                            icon={Check}
                            onClick={() => report(actions.markArrived(token.id), (t) => `Token #${t.number} marked as arrived.`)}
                          >
                            {label('Mark arrived')}
                          </Button>
                        )}
                        {open && (
                          <Button
                            size="sm"
                            icon={UserX}
                            onClick={() => report(actions.markNoShow(token.id), (t) => `Token #${t.number} marked as no-show.`)}
                          >
                            {label('No-show')}
                          </Button>
                        )}
                        {(token.status === 'skipped' || token.status === 'no_show') && (
                          <Button
                            size="sm"
                            icon={Undo2}
                            onClick={() =>
                              report(actions.requeue(token.id), (t) => `Token #${t.number} is back at the end of the line.`)
                            }
                          >
                            {label('Return to queue')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
