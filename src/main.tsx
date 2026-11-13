import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SupabaseAuthProvider } from './backend/auth';
import { ClinicSlugContext, clinicBasename, clinicSlugFromPath } from './backend/clinicRoute';
import { configResult } from './config';
import { StartupNotice } from './screens/StartupNotice';
import { AuthProvider, DemoActionsProvider, StoreProvider } from './state/context';
import { createStore } from './state/store';
import './styles/app.css';

const root = createRoot(document.getElementById('root')!);

if (!configResult.ok) {
  root.render(
    <StrictMode>
      <StartupNotice problems={configResult.problems} />
    </StrictMode>,
  );
} else if (configResult.config.backend === 'supabase') {
  // The real backend. A clinic's patient pages live under /c/<clinic address>, so that prefix becomes the router's
  // base and every link inside the app already points at the right clinic. Staff pages live at the top level.
  const { pathname } = window.location;
  root.render(
    <StrictMode>
      <SupabaseAuthProvider>
        <ClinicSlugContext.Provider value={clinicSlugFromPath(pathname)}>
          <BrowserRouter basename={clinicBasename(pathname)}>
            <App />
          </BrowserRouter>
        </ClinicSlugContext.Provider>
      </SupabaseAuthProvider>
    </StrictMode>,
  );
} else {
  // Demo mode: the local sample data store, exactly as before. The store is created only here, so Supabase mode never touches it.
  const store = createStore();
  root.render(
    <StrictMode>
      <StoreProvider store={store}>
        <AuthProvider>
          <DemoActionsProvider store={store}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </DemoActionsProvider>
        </AuthProvider>
      </StoreProvider>
    </StrictMode>,
  );
}
