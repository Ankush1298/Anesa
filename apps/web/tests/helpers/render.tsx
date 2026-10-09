import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../../src/App';
import { AuthProvider } from '../../src/features/auth/AuthProvider';
import { ApiClient } from '../../src/lib/api/client';
import type { FakeBackend } from './fakeBackend';

export function renderApp(backend: FakeBackend, path = '/') {
  const client = new ApiClient({ basePath: '/api', fetchImpl: backend.fetch });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { client, ...view };
}
