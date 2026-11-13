// Owner only: whether the clinic appears in the public directory, what the public sees about it, and whether patients
// must verify their phone before booking. Listing is off until the owner turns it on.

import { Globe } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStaffClinic } from '../backend/staffGate';
import { rpc } from '../backend/rpc';
import { useFocusFirstError } from '../state/hooks';
import { Button, CardTitle, LiveRegion, Notice, TextField } from './ui';

interface Profile {
  listed: boolean;
  city: string;
  address: string;
  phone: string;
  requireOtp: boolean;
}

const EMPTY: Profile = { listed: false, city: '', address: '', phone: '', requireOtp: false };

export function PublicProfileCard() {
  const clinic = useStaffClinic();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<Profile>(EMPTY);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void rpc('get_public_settings', { p_clinic: clinic.clinicId }).then((answer) => {
      if (!live) return;
      if (!answer.ok) {
        setLoad('error');
        setLoadMessage(answer.message);
        return;
      }
      const d = answer.data;
      setForm({
        listed: d.listed === true,
        city: typeof d.city === 'string' ? d.city : '',
        address: typeof d.address === 'string' ? d.address : '',
        phone: typeof d.phone === 'string' ? d.phone : '',
        requireOtp: d.require_phone_otp === true,
      });
      setLoad('ready');
    });
    return () => {
      live = false;
    };
  }, [clinic.clinicId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaved('');
    const answer = await rpc('update_public_settings', {
      p_clinic: clinic.clinicId,
      p_listed: form.listed,
      p_city: form.city,
      p_address: form.address,
      p_phone: form.phone,
      p_require_otp: form.requireOtp,
    });
    setSaving(false);
    if (answer.ok) {
      setErrors({});
      setSaved(form.listed ? 'Saved. Your clinic is listed on the home page.' : 'Saved. Your clinic is not listed on the home page.');
      return;
    }
    setErrors(answer.fieldErrors ?? { form: answer.message });
    focusFirstError(formRef.current);
  }

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="public-profile">
      <CardTitle icon={Globe}>
        <span id="public-profile">Home page listing and booking security</span>
      </CardTitle>
      <p className="muted">
        Patients can find listed clinics on the Apna Clinic home page. Only what you enter here is shown: the clinic name, the place, a public
        phone number if you add one, your doctors, and queue numbers. Never a patient name or phone number.
      </p>

      {load === 'loading' && (
        <p className="muted" role="status">
          Loading...
        </p>
      )}
      {load === 'error' && <Notice kind="error" title={loadMessage || 'Could not load these settings.'} />}

      {load === 'ready' && (
        <form ref={formRef} onSubmit={(e) => void save(e)} noValidate className="stack">
          <div className="field">
            <label className="switch">
              <input type="checkbox" role="switch" checked={form.listed} onChange={(e) => set('listed', e.target.checked)} />
              <span>
                <strong>List my clinic on the home page: {form.listed ? 'on' : 'off'}</strong>
                <br />
                <span className="muted small">When off, patients can still use your clinic&apos;s own links.</span>
              </span>
            </label>
          </div>

          <div className="grid grid--2">
            <TextField
              label="City or town"
              maxLength={60}
              autoComplete="off"
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              error={errors.city}
              hint="Patients search by this."
            />
            <TextField
              label="Public phone number (optional)"
              type="tel"
              maxLength={20}
              autoComplete="off"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              error={errors.phone}
              hint="Shown to everyone. Use the reception number, not a personal one."
            />
          </div>
          <TextField
            label="Address (optional)"
            maxLength={160}
            autoComplete="off"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            error={errors.address}
          />

          <div className="field">
            <label className="switch">
              <input type="checkbox" role="switch" checked={form.requireOtp} onChange={(e) => set('requireOtp', e.target.checked)} />
              <span>
                <strong>Ask patients to verify with a code before booking: {form.requireOtp ? 'on' : 'off'}</strong>
                <br />
                <span className="muted small">
                  Patients get a 6 digit code by text message or email. This needs text message or email sending to be set up on the server. If
                  it is not, patients are told that no code could be sent and cannot book online.
                </span>
              </span>
            </label>
          </div>

          {errors.form && <Notice kind="error" title={errors.form} />}
          <LiveRegion>{saved && <Notice kind="success" title={saved} />}</LiveRegion>
          <div>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
