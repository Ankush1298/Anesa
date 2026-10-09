import { Badge } from '../components/ui/Badge';
import { usePageTitle } from '../components/usePageTitle';

export function ComingSoonPage({ title, description }: { title: string; description: string }) {
  usePageTitle(title);
  return (
    <>
      <h1>{title}</h1>
      <Badge>Not yet available</Badge>
      <p className="lead">{description}</p>
      <p className="muted">
        This area has not been built yet. There is nothing to show here for now.
      </p>
    </>
  );
}
