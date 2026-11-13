import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './ui';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** For forms with a lot in them, such as the schedule editor. */
  wide?: boolean;
}

/**
 * Modal dialog built on the native <dialog> element.
 * The browser traps focus inside it, closes it on Escape and marks the page behind it as inert.
 * Focus returns to the control that opened it when the dialog closes.
 */
export function Dialog({ open, title, onClose, children, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Give focus back after closing, whichever way the dialog was closed.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      opener.current?.focus();
      opener.current = null;
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog--wide' : undefined}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the dimmed area outside the box closes the dialog.
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__inner">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export function ConfirmDialog({ open, title, confirmLabel, danger, onConfirm, onCancel, children }: ConfirmDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <div>{children}</div>
      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
