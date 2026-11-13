import { Link } from 'react-router-dom';
import { Notice } from './ui';

/** What a public page shows while its clinic data is not ready: loading, no clinic address, unknown clinic, or a problem. */
export function ClinicNotice({ load, message }: { load: 'loading' | 'no_clinic' | 'not_found' | 'error' | 'idle' | 'ready'; message?: string }) {
  switch (load) {
    case 'loading':
      return (
        <p className="muted" role="status">
          Loading...
        </p>
      );
    case 'no_clinic':
      return (
        <Notice kind="info" title="Open the link your clinic gave you." live={false}>
          <p>
            Each clinic has its own web address for booking and the live queue. Ask the clinic reception for it. Clinic
            staff can <Link to="/login">log in here</Link>.
          </p>
        </Notice>
      );
    case 'not_found':
      return (
        <Notice kind="warning" title="We could not find this clinic.">
          <p>Check the web address, or ask the clinic reception for the right link.</p>
        </Notice>
      );
    case 'error':
      return (
        <Notice kind="error" title={message ?? 'Something went wrong.'}>
          <p>Check your internet connection. This page will try again by itself.</p>
        </Notice>
      );
    default:
      return null;
  }
}
