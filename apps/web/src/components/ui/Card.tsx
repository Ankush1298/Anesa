import type { ReactNode } from 'react';

export function Card({
  title,
  headingLevel = 2,
  children,
}: {
  title: string;
  headingLevel?: 2 | 3;
  children: ReactNode;
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="card">
      <H className="card-title">{title}</H>
      {children}
    </section>
  );
}
