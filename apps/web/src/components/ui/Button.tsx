import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Disables the button and announces progress; the label stays so assistive tech keeps context. */
  pending?: boolean;
}

export function Button({
  variant = 'primary',
  pending = false,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={['btn', `btn-${variant}`, className].filter(Boolean).join(' ')}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? <span className="spinner spinner-inline" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
