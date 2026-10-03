/**
 * UpstreamChangesChip.tsx — #817.5 (2026-06-11).
 *
 * Passive indicator for cross-repo pushes that don't affect the current
 * view: a fixed chip listing how many upstream changes are pending and
 * which consumers they touch. Clicking navigates to the first affected
 * consumer's L1 (and clears); ✕ dismisses without navigating.
 */

export interface UpstreamChangeEntry {
    producerRepoName: string;
    consumerRepoName: string;
    method: string;
    route: string;
}

export function UpstreamChangesChip({
    changes,
    onOpen,
    onDismiss,
}: {
    changes: UpstreamChangeEntry[];
    onOpen: (consumerRepoName: string) => void;
    onDismiss: () => void;
}) {
    if (changes.length === 0) return null;
    const consumers = [...new Set(changes.map((c) => c.consumerRepoName))];
    const title = changes
        .slice(0, 8)
        .map((c) => `${c.producerRepoName} → ${c.consumerRepoName}: ${c.method} ${c.route}`)
        .join('\n');
    return (
        <div
            data-testid="ca-upstream-changes-chip"
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed', bottom: 18, right: 18, zIndex: 1050,
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', borderRadius: 20,
                background: 'rgba(59, 130, 246, 0.92)', color: '#fff',
                fontSize: 12.5, boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
            }}
        >
            <button
                type="button"
                data-testid="ca-upstream-changes-open"
                title={title}
                onClick={() => onOpen(consumers[0])}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 'inherit', padding: 0 }}
            >
                🔗 {changes.length} upstream change{changes.length === 1 ? '' : 's'} — {consumers.slice(0, 2).join(', ')}{consumers.length > 2 ? '…' : ''}
            </button>
            <button
                type="button"
                aria-label="Dismiss upstream changes"
                data-testid="ca-upstream-changes-dismiss"
                onClick={onDismiss}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, padding: 0, opacity: 0.8 }}
            >✕</button>
        </div>
    );
}
