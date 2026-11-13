// Password fields with one "Show passwords" switch for the whole form, so people can check what they typed.

import { useState, type ReactNode } from 'react';
import { TextField } from './ui';

export function useShowPasswords() {
  const [show, setShow] = useState(false);
  const toggle: ReactNode = (
    <label className="row" style={{ gap: 8, margin: '4px 0 12px' }}>
      <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
      <span>Show passwords</span>
    </label>
  );
  return { type: show ? ('text' as const) : ('password' as const), toggle };
}

export function PasswordField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: 'text' | 'password';
  error?: string;
  hint?: ReactNode;
  autoComplete: 'new-password' | 'current-password' | 'off';
}) {
  return (
    <TextField
      label={props.label}
      type={props.type}
      autoComplete={props.autoComplete}
      autoCapitalize="none"
      spellCheck={false}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      error={props.error}
      hint={props.hint}
    />
  );
}
