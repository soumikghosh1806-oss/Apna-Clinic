// Screen 6: Patient search (reception)

import { ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { DemoTag, EmptyState, PageHeader, TextField } from '../components/ui';
import { formatDate } from '../domain/dates';
import { IS_SUPABASE } from '../backend/mode';
import { maskPhone } from '../domain/validation';
import { usePatientSearch, usePatientVisitList } from '../state/staffData';

export function PatientSearchScreen() {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const search = usePatientSearch(query);
  const results = search.results;
  const selected = results.find((r) => r.patient.id === selectedId) ?? null;
  const tooShort = query.trim().length > 0 && query.trim().length < 2;
  const visits = usePatientVisitList(selected?.patient.id ?? null).visits;

  return (
    <>
      <PageHeader
        title="Patient search"
        intro={
          <>
            Find a patient by name or phone number. <DemoTag />
          </>
        }
      />

      <div className="grid grid--2">
        <div className="stack">
          <TextField
            label="Name or phone number"
            type="search"
            name="query"
            icon={Search}
            autoComplete="off"
            hint={
              IS_SUPABASE
                ? 'Type at least 2 letters or digits of the name or the mobile number.'
                : 'Type at least 2 letters or digits. Try the name Kapoor or the number 9000000001.'
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedId(null);
            }}
          />

          <div aria-live="polite">
            {query.trim() === '' && <p className="muted">Results appear here as you type.</p>}
            {tooShort && <p className="muted">Keep typing. Enter at least 2 characters.</p>}
            {search.message && <p className="muted">{search.message}</p>}
            {query.trim().length >= 2 && !search.loading && !search.message && results.length === 0 && (
              <EmptyState title="No patient found.">
                <p>Check the spelling or try the phone number.</p>
              </EmptyState>
            )}
            {results.length > 0 && (
              <p className="muted small">
                {results.length} {results.length === 1 ? 'patient' : 'patients'} found
              </p>
            )}
          </div>

          {results.length > 0 && (
            <ul className="list-plain stack--sm stack" aria-label="Matching patients">
              {results.map(({ patient, visitCount, lastVisitDate }) => (
                <li key={patient.id}>
                  <button
                    type="button"
                    className="search-result"
                    aria-pressed={patient.id === selected?.patient.id}
                    onClick={() => setSelectedId(patient.id)}
                  >
                    <span className="search-result__body">
                      <span className="search-result__name">{patient.name}</span>
                      <br />
                      <span className="muted small">
                        {visitCount} {visitCount === 1 ? 'visit' : 'visits'}
                        {lastVisitDate && <>. Last visit {formatDate(lastVisitDate)}</>}
                      </span>
                    </span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <section className="card" aria-label="Patient profile" aria-live="polite">
          {selected ? (
            <div className="stack">
              <div>
                <h2 style={{ marginBottom: 4 }}>{selected.patient.name}</h2>
                <p className="muted" style={{ margin: 0 }}>
                  Phone <span className="mono">{maskPhone(selected.patient.phone)}</span>{' '}
                  {selected.patient.sample ? <DemoTag>Sample record</DemoTag> : <DemoTag>Demo entry</DemoTag>}
                </p>
              </div>
              <dl className="facts">
                <dt>Total visits</dt>
                <dd>{selected.visitCount}</dd>
                <dt>Last visit</dt>
                <dd>{selected.lastVisitDate ? formatDate(selected.lastVisitDate) : 'No visits yet'}</dd>
              </dl>
              <div>
                <h3>Previous visits</h3>
                {visits.length === 0 ? (
                  <p className="muted">No visits on record.</p>
                ) : (
                  <ul className="list-plain list-rows">
                    {visits.map((visit) => (
                      <li key={visit.id}>
                        <span className="grow">
                          <strong>{formatDate(visit.date)}</strong>
                          <br />
                          <span className="muted small">
                            {visit.doctorLabel || 'OPD'}. {visit.title}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Reception sees visit dates and reasons only. Consultation notes are for the doctor.
              </p>
            </div>
          ) : (
            <>
              <h2>Patient profile</h2>
              <p className="muted">Choose a patient from the results to see their visits.</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
