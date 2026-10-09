import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppRoutes } from './App';
import { loadPublicConfig } from './config/env';
import { AuthProvider } from './features/auth/AuthProvider';
import { ApiClient } from './lib/api/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

const config = loadPublicConfig(import.meta.env);
const client = new ApiClient({ basePath: config.apiBasePath });

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider client={client}>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
