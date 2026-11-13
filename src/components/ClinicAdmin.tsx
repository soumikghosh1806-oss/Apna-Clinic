// Owner-only cards for the real backend: the clinic's public links and the staff list with invitations.

import { Copy, ExternalLink, Link2 } from 'lucide-react';
import { useState } from 'react';
import { clinicPath } from '../backend/clinicRoute';
import { useStaffClinic } from '../backend/staffGate';
import { Button, CardTitle, LiveRegion } from './ui';

const LINKS: { page: 'book' | 'queue' | 'tv'; label: string; note: string }[] = [
  { page: 'book', label: 'Book a token', note: 'Share this with patients.' },
  { page: 'queue', label: 'Live queue', note: 'Patients follow the queue on their own phones.' },
  { page: 'tv', label: 'Waiting room display', note: 'Open this on the screen in the waiting room.' },
];

export function PublicLinksCard() {
  const clinic = useStaffClinic();
  const [copied, setCopied] = useState('');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function copy(url: string, label: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(`${label} link copied.`);
    } catch {
      setCopied('Copying was blocked by the browser. Select the link and copy it by hand.');
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="public-links">
      <CardTitle icon={Link2}>
        <span id="public-links">Your clinic's public links</span>
      </CardTitle>
      <p className="muted">
        These pages show only token numbers and queue status. They never show patient names, phone numbers or medical
        information.
      </p>
      <ul className="list-plain">
        {LINKS.map(({ page, label, note }) => {
          const path = clinicPath(clinic.slug, page);
          const url = `${origin}${path}`;
          return (
            <li key={page} style={{ marginBottom: 12 }}>
              <strong>{label}</strong> <span className="muted small">{note}</span>
              <div className="row" style={{ marginTop: 4 }}>
                <code className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {url}
                </code>
                <Button size="sm" icon={Copy} onClick={() => void copy(url, label)}>
                  Copy<span className="sr-only"> {label} link</span>
                </Button>
                <a className="btn btn--sm" href={path} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={16} aria-hidden="true" />
                  Open<span className="sr-only"> {label} in a new tab</span>
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      <LiveRegion>{copied && <p className="muted small">{copied}</p>}</LiveRegion>
    </section>
  );
}

export { StaffSection } from './StaffAdmin';
export { PublicProfileCard } from './PublicProfileCard';
