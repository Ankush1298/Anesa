import { useEffect } from 'react';

/** Sets a descriptive document title for each page ("Sign in · Anesa"). */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Anesa`;
  }, [title]);
}
