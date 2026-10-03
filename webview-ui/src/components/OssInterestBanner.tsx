import { useEffect, useState } from 'react';

const DISMISS_KEY = 'codeatlas.ossInterestBannerDismissed';
// The dashboard hosts the registration + login (Clerk). The MCP standalone has
// no editor, so this banner is the browser-view equivalent of the editor's
// daily reminder — it points users to the dashboard to register interest.
const DASHBOARD_URL = 'https://www.codeatlas.live/#oss-interest';

/**
 * Open-source-interest banner for the browser view. Shown in standalone / MCP
 * mode and the extension's browser view (there is no editor notification in the
 * MCP build). Dismissible; dismissal persists in localStorage.
 */
export function OssInterestBanner() {
    const [dismissed, setDismissed] = useState(true); // hidden until localStorage read (avoid flash)
    useEffect(() => {
        setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    }, []);
    if (dismissed) return null;
    return (
        <div
            role="note"
            data-testid="ca-oss-banner"
            style={{
                display: 'flex', alignItems: 'center', gap: 10,
                maxWidth: 560, margin: '10px auto 0', padding: '8px 14px',
                borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)',
                background: 'rgba(139,92,246,0.07)', fontSize: 13,
            }}
        >
            <span style={{ flex: 1 }}>
                💚 Should CodeAtlas open-source its visual engine?{' '}
                <a
                    href={DASHBOARD_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="ca-oss-banner-link"
                    style={{ fontWeight: 600 }}
                >
                    Register your interest →
                </a>
            </span>
            <button
                aria-label="Dismiss"
                data-testid="ca-oss-banner-dismiss"
                onClick={() => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, color: 'inherit', opacity: 0.6 }}
            >
                ×
            </button>
        </div>
    );
}
