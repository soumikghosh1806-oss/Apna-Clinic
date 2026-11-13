// Small building blocks used on every screen.

import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock,
  Info,
  Pause,
  Play,
  SkipForward,
  TriangleAlert,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { IS_SUPABASE } from '../backend/mode';
import { statusLabel } from '../domain/queue';
import type { Token, TokenStatus } from '../domain/types';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';
type ButtonSize = 'sm' | 'md' | 'lg';

function buttonClass(variant: ButtonVariant, size: ButtonSize, block?: boolean): string {
  return ['btn', variant !== 'secondary' && `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block']
    .filter(Boolean)
    .join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, icon: Icon, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, block)} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 16 : 20} aria-hidden="true" />}
      {children}
    </button>
  );
});

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: LucideIcon;
}

export function ButtonLink({ variant = 'secondary', size = 'md', block, icon: Icon, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClass(variant, size, block)} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 16 : 20} aria-hidden="true" />}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (ids: { inputId: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, hint and error message wired to one control with the correct aria attributes. */
function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {children({ inputId: id, describedBy, invalid: Boolean(error) })}
      {error && (
        <div className="field__error" id={errorId} role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Text shown in front of the input, for example +91. */
  prefix?: string;
  /** Decorative icon shown inside the input, for example a magnifier on search boxes. */
  icon?: LucideIcon;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, prefix, icon: Icon, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ inputId, describedBy, invalid }) => {
        const input = (
          <input
            ref={ref}
            id={inputId}
            className="input"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            {...rest}
          />
        );
        if (prefix) {
          return (
            <div className="input-group">
              <span className="input-group__prefix" aria-hidden="true">
                {prefix}
              </span>
              {input}
            </div>
          );
        }
        if (Icon) {
          return (
            <div className="search-box">
              <Icon size={18} aria-hidden="true" />
              {input}
            </div>
          );
        }
        return input;
      }}
    </FieldShell>
  );
});

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, children, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ inputId, describedBy, invalid }) => (
        <select
          ref={ref}
          id={inputId}
          className="select"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
});

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { label, hint, error, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ inputId, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={inputId}
          className="textarea"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

type NoticeKind = 'info' | 'success' | 'warning' | 'error';

const NOTICE_ICON: Record<NoticeKind, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
};

interface NoticeProps {
  kind: NoticeKind;
  title?: string;
  children?: ReactNode;
  /** Errors are announced at once. Other notices are announced politely. */
  live?: boolean;
}

export function Notice({ kind, title, children, live = true }: NoticeProps) {
  const Icon = NOTICE_ICON[kind];
  const role = !live ? undefined : kind === 'error' ? 'alert' : 'status';
  return (
    <div className={`notice notice--${kind}`} role={role}>
      <Icon size={20} aria-hidden="true" />
      <div className="notice__body">
        {title && (
          <p>
            <strong>{title}</strong>
          </p>
        )}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/**
 * An always present region for messages. Screen readers announce changes inside it,
 * which only works reliably when the region exists before the message appears.
 */
export function LiveRegion({ children }: { children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {children}
    </div>
  );
}

export function DemoTag({ children = 'Sample data' }: { children?: ReactNode }) {
  // The real backend holds real records, so the "sample data" label would be wrong there.
  if (IS_SUPABASE) return null;
  return <span className="badge badge--demo">{children}</span>;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<TokenStatus, LucideIcon> = {
  waiting: Clock,
  in_progress: Play,
  completed: CheckCircle2,
  no_show: UserX,
  skipped: SkipForward,
  on_hold: Pause,
  cancelled: Ban,
};

/** Status shown as icon plus words, so it never depends on colour alone. */
export function StatusBadge({ status }: { status: TokenStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={`badge badge--${status}`}>
      <Icon size={14} aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

export function ArrivalBadge({ token }: { token: Token }) {
  if (token.status === 'completed' || token.status === 'in_progress') {
    return (
      <span className="badge badge--neutral">
        <CheckCircle2 size={14} aria-hidden="true" />
        Seen at clinic
      </span>
    );
  }
  if (token.status === 'no_show' || token.status === 'cancelled') {
    return <span className="muted">Not applicable</span>;
  }
  return token.arrivedAt ? (
    <span className="badge badge--completed">
      <CheckCircle2 size={14} aria-hidden="true" />
      Arrived
    </span>
  ) : (
    <span className="badge badge--neutral">
      <Clock size={14} aria-hidden="true" />
      Not arrived
    </span>
  );
}

/** "#12" with a spoken label of "Token 12". The img role is what allows a name on a span. */
export function TokenNumber({ number, className = '' }: { number: number; className?: string }) {
  return (
    <span className={`token-number ${className}`.trim()} role="img" aria-label={`Token ${number}`}>
      <span aria-hidden="true">#{number}</span>
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card card--flat">
      <p>
        <strong>{title}</strong>
      </p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, intro, actions }: { title: string; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function CardTitle({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <h2 className="card__title">
      {Icon && <Icon size={20} aria-hidden="true" />}
      {children}
    </h2>
  );
}
