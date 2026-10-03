import './wsBridge'; // Must be first — sets up window.vscodeApi shim in browser mode
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Issue #724 — fire-and-forget Sentry init. No-op until @sentry/react
// is installed AND a DSN is provisioned AND the user hasn't opted out
// of telemetry. Promise discarded — render starts immediately so a
// slow SDK load doesn't block first paint.
void import('./errors/sentryBrowser').then(({ initSentryBrowser }) => initSentryBrowser()).catch(() => {});

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
