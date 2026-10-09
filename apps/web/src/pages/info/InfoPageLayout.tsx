import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/Badge';
import { usePageTitle } from '../../components/usePageTitle';

export interface InfoPageLayoutProps {
  title: string;
  subtitle?: string;
  badge?: string;
  children: ReactNode;
}

export function InfoPageLayout({ title, subtitle, badge, children }: InfoPageLayoutProps) {
  usePageTitle(title);

  return (
    <article className="info-article">
      <header className="info-header">
        {badge ? <Badge>{badge}</Badge> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="lead">{subtitle}</p> : null}
      </header>
      <div className="prose">{children}</div>
    </article>
  );
}
