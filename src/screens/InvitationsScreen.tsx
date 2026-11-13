// A person who already has an Apna Clinic account is never added to a clinic behind their back. The clinic owner sends
// an invitation, and it only takes effect when the person accepts it here.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSupabaseAuth } from '../backend/auth';
import type { Invitation } from '../backend/mappers';
import { Button, EmptyState, LiveRegion, Notice, PageHeader } from '../components/ui';
import { ROLE_HOME } from '../domain/permissions';

const ROLE_LABEL = { doctor: 'Doctor', reception: 'Receptionist', owner: 'Clinic owner' } as const;

export function InvitationsScreen() {
  const auth = useSupabaseAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState('');
  const { listInvitations } = auth;

  const load = useCallback(async () => {
    const result = await listInvitations();
    if (result.ok) setItems(result.value);
    else setProblem(result.message);
  }, [listInvitations]);

  useEffect(() => {
    if (auth.phase === 'signed_in') void load();
  }, [auth.phase, load]);

  async function answer(id: string, accept: boolean) {
    setBusyId(id);
    setProblem('');
    const result = await auth.respondInvitation(id, accept);
    setBusyId('');
    if (!result.ok) {
      setProblem(result.message);
      void load();
      return;
    }
    setNote(accept ? 'You have joined the clinic.' : 'The invitation was declined.');
    await load();
    if (accept) navigate('/login', { replace: true });
  }

  if (auth.phase === 'loading') return <p className="muted" role="status">One moment.</p>;
  if (auth.phase !== 'signed_in') {
    return (
      <>
        <PageHeader title="Clinic invitations" />
        <Notice kind="info" title="Sign in to see your invitations.">
          <p>
            <Link to="/login">Go to the login page</Link>
          </p>
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Clinic invitations" intro="A clinic owner has asked you to join. Nothing changes on your account until you accept." />
      <LiveRegion>
        {note && <Notice kind="success" title={note} />}
        {problem && <Notice kind="error" title={problem} />}
      </LiveRegion>
      {items === null && !problem && <p className="muted" role="status">Loading...</p>}
      {items?.length === 0 && (
        <EmptyState title="No invitations waiting">
          {auth.active ? <Link to={ROLE_HOME[auth.active.role]}>Go to your clinic screens</Link> : 'You are not part of a clinic yet.'}
        </EmptyState>
      )}
      <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
        {items?.map((inv) => (
          <li key={inv.id} className="card">
            <h2 className="card__title">{inv.clinicName}</h2>
            <p>
              {inv.invitedBy || 'The clinic owner'} invited you to join as <strong>{ROLE_LABEL[inv.role]}</strong>.
            </p>
            <div className="row">
              <Button variant="primary" disabled={busyId === inv.id} onClick={() => void answer(inv.id, true)}>
                Accept<span className="sr-only"> invitation from {inv.clinicName}</span>
              </Button>
              <Button disabled={busyId === inv.id} onClick={() => void answer(inv.id, false)}>
                Decline<span className="sr-only"> invitation from {inv.clinicName}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
