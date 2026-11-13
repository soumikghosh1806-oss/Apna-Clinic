// Shown instead of the app when the start up settings are wrong. It never falls back to demo data silently,
// because that would hide the problem.

import { Notice, PageHeader } from '../components/ui';

export function StartupNotice({ problems }: { problems: string[] }) {
  return (
    <div className="app">
      <main id="main" tabIndex={-1}>
        <div className="container container--narrow">
          <PageHeader title="Cliniq cannot start" intro="The environment settings need attention." />
          <Notice kind="error" title="Fix these settings and restart">
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Notice>
          <p className="muted">
            Copy <code>.env.example</code> to <code>.env.local</code>, correct the values, then restart the development
            server.
          </p>
        </div>
      </main>
    </div>
  );
}
