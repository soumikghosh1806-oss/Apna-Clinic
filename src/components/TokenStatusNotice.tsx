import type { Token } from '../domain/types';
import { Notice } from './ui';

/** What a patient should do, in plain words, for each state their token can be in. */
export function TokenStatusNotice({ token }: { token: Token }) {
  switch (token.status) {
    case 'in_progress':
      return (
        <Notice kind="success" title="It is your turn.">
          Please go to the doctor now.
        </Notice>
      );
    case 'completed':
      return <Notice kind="info" title="Your consultation is complete." />;
    case 'cancelled':
      return <Notice kind="info" title="This token was cancelled." />;
    case 'no_show':
      return (
        <Notice kind="warning" title="Your token was marked as not arrived.">
          Please speak to the reception desk if you are at the clinic.
        </Notice>
      );
    case 'skipped':
      return (
        <Notice kind="warning" title="Your token was skipped.">
          Please speak to the reception desk to join the line again.
        </Notice>
      );
    case 'on_hold':
      return (
        <Notice kind="info" title="Your consultation is on hold.">
          The doctor will call you back shortly.
        </Notice>
      );
    default:
      return null;
  }
}
