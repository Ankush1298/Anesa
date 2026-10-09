import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { usePageTitle } from '../../components/usePageTitle';
import { useAuth } from '../auth/AuthProvider';
import { roleLabel, shellKind, type ShellKind } from '../auth/identity';

interface Planned {
  name: string;
  note: string;
}

// Names of areas the product plans to add. No data, counts or status is shown for any of them.
const PLANNED: Record<ShellKind, readonly Planned[]> = {
  student: [
    { name: 'Attendance', note: 'Your attendance summary will appear here.' },
    { name: 'Timetable', note: 'Your class schedule will appear here.' },
    { name: 'Notices', note: 'Announcements from your institution will appear here.' },
  ],
  staff: [
    { name: 'My classes', note: 'Classes you teach will appear here.' },
    { name: 'Attendance entry', note: 'Marking attendance will appear here.' },
    { name: 'Requests', note: 'Items waiting for you will appear here.' },
  ],
  admin: [
    { name: 'People & structure', note: 'Campuses, departments and users will appear here.' },
    { name: 'Roles & access', note: 'Assigning roles will appear here.' },
    { name: 'Reports', note: 'Institution-wide reports will appear here.' },
  ],
};

const COPY: Record<ShellKind, { title: string; lead: string }> = {
  student: {
    title: 'Student home',
    lead: 'Your campus information will be available here as modules are added.',
  },
  staff: {
    title: 'Staff home',
    lead: 'Your teaching and work tools will be available here as modules are added.',
  },
  admin: {
    title: 'Administration home',
    lead: 'Institution management tools will be available here as modules are added.',
  },
};

export function HomePage() {
  const { identity } = useAuth();
  const kind = identity ? shellKind(identity) : 'student';
  usePageTitle(COPY[kind].title);
  if (!identity) return null;
  return (
    <>
      <h1>{COPY[kind].title}</h1>
      {/* React escapes this text: a hostile display name renders as plain characters. */}
      <p className="lead">
        Welcome{identity.displayName ? `, ${identity.displayName}` : ''}. {COPY[kind].lead}
      </p>
      <div className="grid">
        <Card title="Your access">
          <p className="muted">As recorded by your institution:</p>
          <ul className="chips" aria-label="Your roles">
            {identity.roles.map((r) => (
              <li key={r}>{roleLabel(r)}</li>
            ))}
          </ul>
        </Card>
        {PLANNED[kind].map((p) => (
          <Card key={p.name} title={p.name}>
            <Badge>Not yet available</Badge>
            <p className="muted">{p.note}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
