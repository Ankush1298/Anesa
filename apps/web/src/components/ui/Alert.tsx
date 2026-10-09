import type { ReactNode } from 'react';

type Tone = 'error' | 'info' | 'success';

/** role="alert" interrupts (errors); role="status" is polite (info/success). */
export function Alert({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
