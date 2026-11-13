// "Book Your Doctor Appointment": the public clinic directory on the home page.
//
// What a visitor sees is only what a clinic owner chose to make public: the clinic's name and place, a public phone
// number, its doctors, and queue numbers. No patient, owner or staff details exist in this data.
//
// Links to a clinic's own pages are plain links (a full page load) because each clinic's pages live under their own
// address (/c/<clinic>) and the app reads that address when it starts.

import { MapPin, Phone, Search, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { clinicPath } from '../backend/clinicRoute';
import { placeLine, useDirectory, useDirectoryFilters, type DirectoryClinic, type DirectoryDoctor } from '../backend/directory';
import { availabilityLine, queueLine, timingText } from '../domain/availabilityText';
import { Button, LiveRegion, Notice, SelectField, TextField } from './ui';

const PAGE_SIZE = 8;

function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setShown(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return shown;
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

function DoctorRow({ clinic, doctor }: { clinic: DirectoryClinic; doctor: DirectoryDoctor }) {
  const today = doctor.today;
  const sessions = today.sessions ?? [];
  const book = `${clinicPath(clinic.slug, 'book')}?doctor=${encodeURIComponent(doctor.id)}`;
  const queue = `${clinicPath(clinic.slug, 'queue')}?doctor=${encodeURIComponent(doctor.id)}`;
  return (
    <li className="doctor-row">
      <div className="doctor-row__who">
        <p className="doctor-row__name">
          <Stethoscope size={16} aria-hidden="true" /> <strong>{doctor.name}</strong>
        </p>
        <p className="muted small">
          {[doctor.specialization, doctor.opd].filter(Boolean).join(' · ')}
        </p>
      </div>
      <dl className="facts facts--tight">
        <dt>Today</dt>
        <dd>
          {today.reason === 'online_disabled' ? 'Online booking is off' : availabilityLine(today)}
          {sessions.length > 0 && <span className="muted small"> · {sessions.map(timingText).join(' and ')}</span>}
        </dd>
        <dt>Queue</dt>
        <dd>{queueLine(doctor.queue)}</dd>
      </dl>
      <div className="doctor-row__actions">
        <a className="btn btn--primary btn--sm" href={book}>
          Book appointment<span className="sr-only"> with {doctor.name} at {clinic.name}</span>
        </a>
        <a className="btn btn--sm" href={queue}>
          Live queue<span className="sr-only"> for {doctor.name} at {clinic.name}</span>
        </a>
      </div>
    </li>
  );
}

function ClinicCard({ clinic }: { clinic: DirectoryClinic }) {
  const place = placeLine(clinic);
  const headingId = `clinic-${clinic.slug}`;
  return (
    <li>
      <article className="card clinic-card" aria-labelledby={headingId}>
        <div className="clinic-card__head">
          <h3 id={headingId}>{clinic.name}</h3>
          <span className={`pill ${clinic.anyOpen ? 'pill--open' : 'pill--closed'}`}>
            {clinic.anyOpen ? 'Taking bookings today' : 'Not taking bookings today'}
          </span>
        </div>
        {place && (
          <p className="muted clinic-card__line">
            <MapPin size={16} aria-hidden="true" /> <span>{place}</span>
          </p>
        )}
        {clinic.phone && (
          <p className="clinic-card__line">
            <Phone size={16} aria-hidden="true" />{' '}
            <a href={telHref(clinic.phone)}>
              {clinic.phone}
              <span className="sr-only"> (call {clinic.name})</span>
            </a>
          </p>
        )}
        <ul className="doctor-list">
          {clinic.doctors.map((d) => (
            <DoctorRow key={d.id} clinic={clinic} doctor={d} />
          ))}
        </ul>
      </article>
    </li>
  );
}

export function ClinicDirectory() {
  const [typed, setTyped] = useState('');
  const [doctorTyped, setDoctorTyped] = useState('');
  const [specialization, setSpecialization] = useState('');
  const query = useDebounced(typed, 350);
  const doctor = useDebounced(doctorTyped, 350);
  // The page belongs to one search. A new search starts from the first page without loading twice.
  const searchKey = `${query}|${doctor}|${specialization}`;
  const [paging, setPaging] = useState({ key: searchKey, offset: 0 });
  const offset = paging.key === searchKey ? paging.offset : 0;
  const setOffset = (next: number) => setPaging({ key: searchKey, offset: next });
  const filters = useDirectoryFilters();
  const result = useDirectory({ query, specialization, doctor, offset }, PAGE_SIZE);

  const page = result.data;
  const searching = typed.trim() !== '' || doctorTyped.trim() !== '' || specialization !== '';
  const tooShort = (typed.trim().length === 1) || (doctorTyped.trim().length === 1);
  const from = page && page.total > 0 ? page.offset + 1 : 0;
  const to = page ? page.offset + page.clinics.length : 0;

  return (
    <section id="find-clinic" className="directory" aria-labelledby="directory-title">
      <h2 id="directory-title">Find your clinic</h2>

      <form className="card directory__search" role="search" aria-label="Find a clinic" onSubmit={(e) => e.preventDefault()}>
        <TextField
          label="Search clinic by name or location"
          name="clinic-search"
          type="search"
          icon={Search}
          autoComplete="off"
          maxLength={60}
          placeholder="For example Sunrise Clinic, or Pune"
          hint={tooShort ? 'Type at least 2 letters to search.' : undefined}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <div className="directory__filters">
          <SelectField label="Specialisation" name="specialization" value={specialization} onChange={(e) => setSpecialization(e.target.value)}>
            <option value="">All specialisations</option>
            {(filters.data ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Doctor name"
            name="doctor-search"
            autoComplete="off"
            maxLength={60}
            placeholder="Optional"
            value={doctorTyped}
            onChange={(e) => setDoctorTyped(e.target.value)}
          />
        </div>
        {searching && (
          <div>
            <Button
              size="sm"
              onClick={() => {
                setTyped('');
                setDoctorTyped('');
                setSpecialization('');
              }}
            >
              Clear search and filters
            </Button>
          </div>
        )}
      </form>

      <LiveRegion>
        {page && !result.failure && (
          <p className="muted directory__count">
            {page.total === 0 ? '' : `Showing ${from} to ${to} of ${page.total} ${page.total === 1 ? 'clinic' : 'clinics'}.`}
          </p>
        )}
      </LiveRegion>

      {result.failure && !page && (
        <Notice kind="error" title={result.failure.message}>
          <p>Check your internet connection. This page will try again by itself.</p>
        </Notice>
      )}
      {!page && !result.failure && (
        <p className="muted" role="status">
          Searching...
        </p>
      )}

      {page && page.total === 0 && (
        <Notice kind="info" live={false} title={searching ? 'No clinic matches your search.' : 'No clinics are listed yet.'}>
          <p>
            {searching
              ? 'Try a different name or place, or clear the filters.'
              : 'If your clinic gave you a link, open it to book. Clinic owners can choose to list their clinic here.'}
          </p>
        </Notice>
      )}

      {page && page.clinics.length > 0 && (
        <ul className="clinic-list">
          {page.clinics.map((c) => (
            <ClinicCard key={c.slug} clinic={c} />
          ))}
        </ul>
      )}

      {page && page.total > PAGE_SIZE && (
        <nav className="row row--between" aria-label="More clinics">
          <Button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
            Previous clinics
          </Button>
          <Button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= page.total}>
            Next clinics
          </Button>
        </nav>
      )}
    </section>
  );
}
