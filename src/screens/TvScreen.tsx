// Screen 9: Waiting room display. Full screen, token numbers only, no patient names.

import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClinicNotice } from '../components/ClinicNotice';
import { IS_SUPABASE, PLATFORM_NAME } from '../backend/mode';
import { useBoard } from '../state/publicData';

const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function TvScreen() {
  const [params, setParams] = useSearchParams();
  const board = useBoard(params.get('doctor'));
  const [announce, setAnnounce] = useState(false);
  const lastSpoken = useRef<string | null>(null);

  const doctors = board.doctors;
  const doctor = board.doctor;
  const current = board.currentNumber;
  const next = board.upcoming;

  // Speak when a new token is called. This uses the browser's own voice and is only a simulation of a hall announcement.
  const currentKey = current !== null ? `${doctor?.id}:${current}` : null;
  useEffect(() => {
    if (!announce || !canSpeak || current === null || !doctor) {
      lastSpoken.current = currentKey;
      return;
    }
    if (lastSpoken.current === currentKey) return;
    lastSpoken.current = currentKey;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(`Token number ${current}, please go to ${doctor.opd}.`);
    utterance.lang = 'en-IN';
    window.speechSynthesis.speak(utterance);
  }, [announce, current, currentKey, doctor]);

  useEffect(() => () => {
    if (canSpeak) window.speechSynthesis.cancel();
  }, []);

  if (board.load !== 'ready') {
    return (
      <div className="tv">
        <main className="tv__main" id="main">
          <h1 className="tv__clinic" tabIndex={-1}>
            {board.clinicName || PLATFORM_NAME}
          </h1>
          <ClinicNotice load={board.load} message={board.message} />
        </main>
      </div>
    );
  }

  if (!doctor) {
    return (
      <div className="tv">
        <main className="tv__main" id="main">
          <h1 className="tv__clinic">{board.clinicName}</h1>
          <p className="tv__next-empty">No OPD is set up.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="tv">
      <main className="tv__main" id="main">
        <section aria-label="Now serving">
          <h1 className="tv__clinic" tabIndex={-1}>
            {board.clinicName}
          </h1>
          <p className="tv__opd">
            {doctor.opd}, {doctor.name}
          </p>
          <p className="tv__label">Now serving</p>
          {current !== null ? (
            <div className="tv__current" role="status" aria-label={`Now serving token ${current}`}>
              <span aria-hidden="true">#{current}</span>
            </div>
          ) : (
            <div className="tv__current tv__current--none" role="status">
              Please wait
            </div>
          )}
        </section>

        <section aria-label="Next tokens">
          <p className="tv__label">Next</p>
          {next.length === 0 ? (
            <p className="tv__next-empty">No one is waiting.</p>
          ) : (
            <ol className="tv__next-list">
              {next.map((number) => (
                <li key={number} aria-label={`Token ${number}`}>
                  <span aria-hidden="true">#{number}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>

      {/* Display controls. A clinic can fix the queue in the address (?doctor=...) and leave this bar at the bottom. */}
      <aside className="tv__bar" aria-label={IS_SUPABASE ? 'Display controls' : 'Demo controls'}>
        <strong>{IS_SUPABASE ? 'Display controls' : 'Demo controls'}</strong>
        <label>
          <span className="sr-only">Choose the queue to show</span>
          <select
            className="select"
            value={doctor.id}
            onChange={(e) => setParams({ doctor: e.target.value })}
            aria-label="Queue shown on this display"
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.opd} ({d.name})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--sm"
          aria-pressed={announce}
          disabled={!canSpeak}
          onClick={() => {
            setAnnounce((on) => !on);
            if (canSpeak) window.speechSynthesis.cancel();
          }}
        >
          {announce ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
          {announce ? 'Voice announcements on' : 'Voice announcements off'}
        </button>
        <span>
          {canSpeak
            ? IS_SUPABASE
              ? 'Uses your browser voice.'
              : 'Uses your browser voice. Demo only.'
            : 'This browser cannot speak announcements.'}
        </span>
        <Link to="/">{IS_SUPABASE ? 'Back to clinic home' : 'Back to demo home'}</Link>
      </aside>
    </div>
  );
}
