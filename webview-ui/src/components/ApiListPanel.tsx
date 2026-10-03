import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { DiffFocusBar, DiffMinimap } from './DiffFocusBar';
import { computeChangeCounts, apiMatchesChangeFilter, type ChangeFilter } from '../lib/diffFocus';
import { trackWebviewEvent } from '../analytics';
import { isFrontendCategory, categoryFromGraph, orderMethodTabs, METHOD_TAB_LABEL } from '../lib/entryPointLabel';

export interface ApiRecord {
    apiId: string;
    method: string;
    route: string;
    handlerName: string;
    filePath: string;
    diff?: 'added' | 'modified' | 'unchanged' | 'deleted';
    /** Issue 368 — webhook intent flag set by `tagWebhookRoutes` in the detector. */
    /** Issue 408 — auth-middleware presence derived from `auth.required` / `auth.optional` args or JSDoc `@auth`. */
    meta?: {
        webhook?: boolean;
        webhookProvider?: string;
        middlewares?: string[];
        auth?: 'required' | 'optional';
        /** Issue 418 — Express 4-arg error-handling middleware flag. */
        error?: boolean;
        /** Issue 414 — for-loop-derived parameterized route cardinality. */
        dynamicRange?: { var: string; from: number; to: number; step: number; count: number };
        /** Issue #747 — inferred request body schema (from Zod / Joi / Yup / class-validator / JSDoc / ts-type). */
        requestSchema?: {
            kind: 'json' | 'form' | 'multipart' | 'raw';
            schema?: unknown;
            source: string;
        };
        /** Issue #747 — inferred response schemas keyed by status code. */
        responseSchema?: Array<{
            status: number;
            schema?: unknown;
            source: string;
            description?: string;
        }>;
    };
}

interface SubsystemItem {
    label: string;
    kind: string;
    filePath?: string;
}

/**
 * v2 phase 4 #485 — L2b content item for FE/mobile screens. Mirrors
 * the extension-side `L2bScreenItem`. Carries the section bucket +
 * sub-kind + display label that the 5-section renderer needs.
 */
interface L2bScreenItem {
    itemId: string;
    screenId: string;
    section: 'interactions' | 'data' | 'lifecycle' | 'nav-in' | 'nav-out' | 'visual';
    kind: string;
    label: string;
    handlerName?: string;
    visualKind?: string;
    route?: string;
    filePath: string;
    anchor: { filePath: string; lineStart?: number; lineEnd?: number };
}

interface ApiListPanelProps {
    graph: {
        graphId: string;
        meta: {
            clusterId?: string;
            clusterLabel?: string;
            serviceId?: string;
            apis?: ApiRecord[];
            files?: string[];
            entryPoints?: string[];
            subsystems?: SubsystemItem[];
            screens?: ApiRecord[];
            navRoutes?: ApiRecord[];
            networkCalls?: ApiRecord[];
            diBindings?: ApiRecord[];
            // v2 phase 4 #485 — when these fields are present the panel
            // renders the FE/mobile 5-section layout (Interactions /
            // Data sources / Lifecycle / Nav-in / Nav-out + collapsible
            // Visual elements) in place of the backend 10-section HTTP
            // layout.
            screenItems?: L2bScreenItem[];
            screenId?: string;
            routePath?: string;
            framework?: string;
            sectionCounts?: Record<string, number>;
        };
    };
    onApiClick: (api: ApiRecord, event?: React.MouseEvent) => void;
    onFileClick: (filePath: string, event?: React.MouseEvent) => void;
    highlightedNodes?: Record<string, string>;
    /** #750 (2026-06-06) — optional saved-views toolbar slot rendered
     *  in the panel header. Parent (App.tsx) supplies a fully-wired
     *  SavedViewsToolbar so this component stays presentation-only. */
    savedViewsSlot?: React.ReactNode;
}

export const methodColors: Record<string, string> = {
    GET: 'var(--ca-success)',
    POST: 'var(--ca-accent)',
    PUT: 'var(--ca-warning)',
    PATCH: 'var(--ca-color-patch)',
    DELETE: 'var(--ca-danger)',
    HEAD: 'var(--ca-color-purple)',
    OPTIONS: 'var(--ca-color-teal)',
    // Mobile/UI categories
    SCREEN: 'var(--ca-color-blue)',
    NAV_ROUTE: 'var(--ca-color-teal)',
    NETWORK: 'var(--ca-color-orange)',
    DI_BINDING: 'var(--ca-color-purple)',
    // Tier 1 (Issue 364) — non-HTTP entry-point categories.
    WS: 'var(--ca-color-blue)',
    SSE: 'var(--ca-color-teal)',
    SUBSCRIPTION: 'var(--ca-color-blue)',
    GRPC: 'var(--ca-color-purple)',
    RPC: 'var(--ca-color-purple)',
    JOB: 'var(--ca-color-orange)',
    MQ_CONSUMER: 'var(--ca-color-orange)',
    CLI_COMMAND: 'var(--ca-color-teal)',
    FILTER: 'var(--ca-color-purple)',
    MIDDLEWARE: 'var(--ca-color-purple)',
    SERVLET_FILTER: 'var(--ca-color-purple)',
    HANDLER_INTERCEPTOR: 'var(--ca-color-purple)',
    AOP_ASPECT: 'var(--ca-color-purple)',
    AOP_BEFORE: 'var(--ca-color-purple)',
    AOP_AROUND: 'var(--ca-color-purple)',
    AOP_AFTER: 'var(--ca-color-purple)',
    DB_MIGRATION: 'var(--ca-warning)',
    DB_SEED: 'var(--ca-success)',
    SIGNAL: 'var(--ca-color-orange)',
    // Tier 2 (Issue 365)
    SOCKET_EVENT: 'var(--ca-color-blue)',
    MODEL_HOOK: 'var(--ca-warning)',
    HEALTH: 'var(--ca-success)',
    PUSH_HANDLER: 'var(--ca-danger)',
    BG_TASK: 'var(--ca-color-orange)',
    LIFECYCLE: 'var(--ca-color-purple)',
    // Tier 3 (Issue 366)
    WIDGET: 'var(--ca-color-teal)',
    CONTENT_PROVIDER: 'var(--ca-color-purple)',
    DEEP_LINK: 'var(--ca-color-blue)',
};

const kindColors: Record<string, string> = {
    database: 'var(--ca-warning)',
    module: 'var(--ca-accent)',
    actor: 'var(--ca-success)',
    framework: 'var(--ca-color-purple)',
};

const diffBorderColor: Record<string, string> = {
    added: 'var(--ca-success)',
    modified: 'var(--ca-warning)',
    deleted: 'var(--ca-danger)',
    unchanged: 'transparent',
};

const diffLabel: Record<string, string> = {
    added: '+',
    modified: '~',
    deleted: '−',
};

const MOBILE_METHODS = new Set(['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING']);

// Tier 1 (Issue 364) — non-HTTP entry-point sections in the L2b panel.
// HTTP verbs (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/ANY) stay in the
// existing file-grouped flow at the bottom of the panel; everything
// else gets its own collapsible section above the file groups so users
// can scan workers, jobs, CLI commands, hooks, etc. as cohesive groups.
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY', 'ROUTE', 'INCLUDE', 'MOUNT', 'PATH', 'CONTROLLER', 'RESOURCE', 'SERVER_ACTION', 'STATIC_PATHS', 'DATA_FETCH']);
const REALTIME_METHODS = new Set(['WS', 'SSE', 'SUBSCRIPTION', 'GRPC', 'RPC', 'SOCKET_EVENT']);
const JOB_METHODS = new Set(['JOB', 'MQ_CONSUMER']);
const CLI_METHODS = new Set(['CLI_COMMAND']);
const DATA_METHODS = new Set(['DB_MIGRATION', 'DB_SEED', 'SIGNAL', 'MODEL_HOOK']);
const HOOK_METHODS = new Set(['FILTER', 'MIDDLEWARE', 'SERVLET_FILTER', 'HANDLER_INTERCEPTOR', 'AOP_ASPECT', 'AOP_BEFORE', 'AOP_AROUND', 'AOP_AFTER', 'AOP_AFTERRETURNING', 'AOP_AFTERTHROWING', 'EVENT_LISTENER', 'EVENT_EMIT', 'DI_DEPENDENCY']);
const OBSERVABILITY_METHODS = new Set(['HEALTH']);
const MOBILE_LIFECYCLE_METHODS = new Set(['PUSH_HANDLER', 'BG_TASK', 'LIFECYCLE', 'DEEP_LINK', 'WIDGET', 'CONTENT_PROVIDER']);

interface EntryPointSection {
    key: string;
    title: string;
    icon: string;
    color: string;
    match: (m: string) => boolean;
}

const ENTRY_POINT_SECTIONS: EntryPointSection[] = [
    { key: 'realtime', title: 'Real-Time', icon: '⚡', color: 'var(--ca-color-blue)', match: (m) => REALTIME_METHODS.has(m) },
    { key: 'jobs', title: 'Background Jobs', icon: '⚙️', color: 'var(--ca-color-orange)', match: (m) => JOB_METHODS.has(m) },
    { key: 'cli', title: 'CLI Commands', icon: '>_', color: 'var(--ca-color-teal)', match: (m) => CLI_METHODS.has(m) },
    { key: 'data', title: 'Data Lifecycle', icon: '\u{1F5C4}', color: 'var(--ca-warning)', match: (m) => DATA_METHODS.has(m) },
    { key: 'hooks', title: 'Request Hooks', icon: '\u{1F517}', color: 'var(--ca-color-purple)', match: (m) => HOOK_METHODS.has(m) },
    // Tier 2 (Issue 365)
    { key: 'observability', title: 'Observability', icon: '\u{1F4C8}', color: 'var(--ca-success)', match: (m) => OBSERVABILITY_METHODS.has(m) },
    { key: 'mobile-lifecycle', title: 'Mobile Lifecycle', icon: '\u{1F514}', color: 'var(--ca-color-purple)', match: (m) => MOBILE_LIFECYCLE_METHODS.has(m) },
];

function inferPlatform(filePath: string): string | null {
    if (/\.dart$/.test(filePath)) return 'Flutter';
    if (/\.(?:java|kt|kts)$/.test(filePath)) return 'Android';
    if (/\.swift$/.test(filePath)) return 'iOS';
    if (/\.(?:tsx?|jsx?)$/.test(filePath)) return 'React';
    return null;
}

const platformIcon: Record<string, string> = {
    Flutter: '\u{1F426}',  // 🐦
    Android: '\u{1F4F1}',  // 📱
    iOS: '\u{1F34E}',      // 🍎
    React: '\u269B\uFE0F', // ⚛️
};

/**
 * BUG-EXP-24 — a readable target for a Django `include(...)` aggregator row.
 * Several `path('api/', include('app.<name>.urls'))` mounts share the same
 * `/api/` route, so without the included module the rows are indistinguishable.
 * Returns the app name (the last meaningful segment, dropping trailing
 * `urls`/`routes`/`conf` noise): `conduit.apps.authentication.urls` → `authentication`.
 */
function includeTargetLabel(handler: string): string {
    const parts = String(handler).split('.').filter(Boolean);
    const meaningful = parts.filter(p => !/^(urls?|routes?|conf|config)$/i.test(p));
    return (meaningful.length ? meaningful[meaningful.length - 1] : parts[parts.length - 1]) || String(handler);
}

export function ApiRow({ api, onApiClick, showFile, nlHighlighted }: {
    api: ApiRecord;
    onApiClick: (api: ApiRecord, e: React.MouseEvent) => void;
    showFile?: boolean;
    nlHighlighted?: boolean;
}) {
    const d = api.diff ?? 'unchanged';
    // Issue #747: 1st click expands an inline schema panel (when
    // inferred validators are present); the embedded "→ Open
    // sequence" affordance preserves the previous one-click L3
    // navigation. Modifier-click (Cmd/Ctrl/middle) and routes without
    // inferred schemas skip the expand step so the UX stays familiar
    // for power users + leaf routes with no metadata to surface.
    const [expanded, setExpanded] = useState(false);
    const hasInferredSchema = !!(api.meta?.requestSchema?.schema || (api.meta?.responseSchema && api.meta.responseSchema.some(r => r.schema)));
    const handleRowClick = (e: React.MouseEvent) => {
        if (d === 'deleted') return;
        // Modifier-click goes straight to L3 (matches the prior UX so
        // muscle memory still works).
        if (e.metaKey || e.ctrlKey || (e as any).button === 1) {
            onApiClick(api, e);
            return;
        }
        if (hasInferredSchema) {
            setExpanded(v => !v);
            return;
        }
        onApiClick(api, e);
    };
    // Bug C (2026-06-04): the row is a clickable div with cursor:pointer
    // but no a11y signal — keyboard users couldn't focus it, screen
    // readers couldn't announce what activating it would do. Adding
    // role + aria-label + tabIndex + keydown activation closes the gap
    // without changing visual layout.
    const ariaLabel = hasInferredSchema
        ? `Expand schema for ${api.method} ${api.route}; press Enter to view sequence diagram`
        : `Open sequence diagram for ${api.method} ${api.route}`;
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (d === 'deleted') return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onApiClick(api, e as unknown as React.MouseEvent);
        }
    };
    return (
        <div
            className="ca-api-row"
            // diff-focus anchor: the minimap + jump-stepper query rows by apiId
            // to measure their position and scroll them into view.
            data-api-id={api.apiId}
            data-diff={d !== 'unchanged' ? d : undefined}
            role="button"
            tabIndex={d === 'deleted' ? -1 : 0}
            aria-label={ariaLabel}
            aria-disabled={d === 'deleted' || undefined}
            onClick={handleRowClick}
            onKeyDown={handleKeyDown}
            title={hasInferredSchema
                ? `Expand schema for ${api.method} ${api.route} (⌘-click for sequence)`
                : `Open sequence diagram for ${api.method} ${api.route}`}
            style={{
                position: 'relative',
                borderLeft: nlHighlighted ? '3px solid var(--ca-nl-query)' : `3px solid ${diffBorderColor[d] ?? 'transparent'}`,
                background: nlHighlighted ? 'var(--ca-nl-query-bg)' : undefined,
                opacity: d === 'deleted' ? 0.5 : 1,
                cursor: d === 'deleted' ? 'default' : 'pointer',
                flexDirection: 'column',
                alignItems: 'stretch',
            }}
        >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
            <span
                className="ca-method-badge"
                style={{ background: methodColors[api.method] ?? 'var(--ca-edge-unchanged)' }}
            >
                {api.method}
            </span>
            {MOBILE_METHODS.has(api.method) && (() => {
                const p = inferPlatform(api.filePath);
                return p ? (
                    <span title={p} style={{ fontSize: 11, marginRight: 2, flexShrink: 0 }}>
                        {platformIcon[p]}
                    </span>
                ) : null;
            })()}
            {/* Issue 368 — webhook intent marker (⚡) */}
            {api.meta?.webhook && (
                <span
                    title={`Webhook${api.meta.webhookProvider ? ` (${api.meta.webhookProvider})` : ''}`}
                    style={{ fontSize: 11, marginRight: 2, flexShrink: 0 }}
                >
                    ⚡
                </span>
            )}
            {/* Issue 408 — auth marker: 🔒 required, 🔓 optional, blank if no auth on route */}
            {api.meta?.auth && (
                <span
                    title={`Auth: ${api.meta.auth}${api.meta.middlewares?.length ? ` (${api.meta.middlewares.join(', ')})` : ''}`}
                    style={{ fontSize: 11, marginRight: 2, flexShrink: 0 }}
                >
                    {api.meta.auth === 'required' ? '🔒' : '🔓'}
                </span>
            )}
            {/* Issue 418 — error-middleware marker (⚠) for `app.use((err, req, res, next) => …)` */}
            {api.meta?.error && (
                <span
                    title="Error-handling middleware (4-arg)"
                    style={{ fontSize: 11, marginRight: 2, flexShrink: 0 }}
                >
                    ⚠
                </span>
            )}
            {/* UX-48 (2026-06-05) — middleware-chain length chip. Shows the
                length of `meta.middlewares` so a user can spot heavily-
                guarded routes (auth + rate-limit + validate + cache) at a
                glance without hovering on the auth marker. Hidden when
                no middlewares OR only one entry (the auth marker already
                surfaces that case). */}
            {(api.meta?.middlewares?.length ?? 0) >= 2 && (
                <span
                    title={`Middleware chain (${api.meta!.middlewares!.length}): ${api.meta!.middlewares!.join(' → ')}`}
                    style={{ fontSize: 11, marginRight: 2, flexShrink: 0, color: 'var(--ca-text-muted)' }}
                >
                    🔗{api.meta!.middlewares!.length}
                </span>
            )}
            {/* Issue 414 — for-loop unrolled route cardinality (e.g. ×25 for /random/:index) */}
            {api.meta?.dynamicRange && (
                <span
                    title={`Loop-registered: ${api.meta.dynamicRange.count} routes (${api.meta.dynamicRange.var} from ${api.meta.dynamicRange.from} to ${api.meta.dynamicRange.to})`}
                    style={{ fontSize: 11, marginRight: 2, flexShrink: 0, color: 'var(--ca-text-muted)' }}
                >
                    ×{api.meta.dynamicRange.count}
                </span>
            )}
            <span className="ca-api-route">{api.route}</span>
            {api.method === 'INCLUDE' && api.handlerName && (
                <span
                    className="ca-api-include-target"
                    style={{ color: 'var(--ca-accent)', opacity: 0.85, fontSize: 11, marginLeft: 4 }}
                    title={api.handlerName}
                >
                    → {includeTargetLabel(api.handlerName)}
                </span>
            )}
            {showFile && (
                <span className="ca-api-handler" style={{ color: 'var(--ca-text-muted)', fontStyle: 'italic' }} title={api.filePath}>
                    {api.filePath.split('/').slice(-2).join('/')}
                </span>
            )}
            {!showFile && (
                <span className="ca-api-handler">{api.handlerName}</span>
            )}
            {diffLabel[d] && (
                <span style={{
                    marginLeft: 'auto',
                    color: diffBorderColor[d],
                    fontWeight: 700,
                    fontSize: 13,
                    minWidth: 16,
                    textAlign: 'center',
                    flexShrink: 0,
                }}>
                    {diffLabel[d]}
                </span>
            )}
        </div>
        {expanded && hasInferredSchema && (
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    padding: '8px 12px',
                    marginTop: 4,
                    background: 'var(--ca-row-expanded-bg, rgba(120,140,180,0.06))',
                    borderTop: '1px solid var(--ca-border)',
                    borderRadius: 4,
                    fontSize: 12,
                    fontFamily: 'var(--ca-font-mono, ui-monospace, monospace)',
                    color: 'var(--ca-text-secondary, #c0c4cc)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {Boolean(api.meta?.requestSchema?.schema) && api.meta?.requestSchema && (
                    <div style={{ marginBottom: 6 }}>
                        <strong style={{ fontFamily: 'inherit', color: 'var(--ca-text)' }}>
                            Request body
                            <span style={{ fontWeight: 400, marginLeft: 6, color: 'var(--ca-text-muted)' }}>
                                (inferred from {api.meta.requestSchema.source})
                            </span>
                        </strong>
                        <pre style={{ margin: '4px 0 0', fontSize: 11, lineHeight: 1.4, overflow: 'auto' }}>
                            {JSON.stringify(api.meta.requestSchema.schema, null, 2)}
                        </pre>
                    </div>
                )}
                {api.meta?.responseSchema && api.meta.responseSchema.some(r => !!r.schema) && (
                    <div>
                        <strong style={{ fontFamily: 'inherit', color: 'var(--ca-text)' }}>Response</strong>
                        {api.meta.responseSchema
                            .filter(r => !!r.schema)
                            .map((r, i) => (
                                <div key={i} style={{ marginTop: 4 }}>
                                    <span style={{ fontSize: 11, color: 'var(--ca-text-muted)' }}>
                                        {r.status} — inferred from {r.source}
                                    </span>
                                    <pre style={{ margin: '2px 0 0', fontSize: 11, lineHeight: 1.4, overflow: 'auto' }}>
                                        {JSON.stringify(r.schema, null, 2)}
                                    </pre>
                                </div>
                            ))}
                    </div>
                )}
                <div style={{ marginTop: 8 }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onApiClick(api, e); }}
                        style={{
                            padding: '4px 10px',
                            background: 'var(--ca-accent, #5b8def)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 12,
                            fontFamily: 'inherit',
                        }}
                    >
                        → Open sequence
                    </button>
                </div>
            </div>
        )}
        </div>
    );
}

export function CollapsibleSection({ title, icon, color, count, children, defaultOpen, headerExtra, onHeaderClick, headerTitle, onToggle }: {
    title: string;
    icon?: string;
    color: string;
    count: number;
    children: React.ReactNode;
    defaultOpen?: boolean;
    headerExtra?: React.ReactNode;
    onHeaderClick?: (e: React.MouseEvent) => void;
    headerTitle?: string;
    onToggle?: (open: boolean) => void;
}) {
    const [open, setOpen] = useState(defaultOpen ?? count > 0);
    if (count === 0) return null;
    const toggle = () => {
        const next = !open;
        setOpen(next);
        onToggle?.(next);
    };
    return (
        <div style={{ marginBottom: 8 }}>
            <div
                onClick={(e) => {
                    // Caret area always toggles; header label area can route to
                    // a navigation handler when one is supplied.
                    const target = e.target as HTMLElement;
                    if (target.closest('.ca-collapsible-caret') || !onHeaderClick) {
                        toggle();
                    } else {
                        onHeaderClick(e);
                    }
                }}
                title={headerTitle}
                style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                    cursor: 'pointer', fontSize: 11, fontWeight: 700, color,
                    borderLeft: `3px solid ${color}`, background: 'var(--ca-node-body-bg)',
                }}
            >
                <span
                    className="ca-collapsible-caret"
                    onClick={(e) => { e.stopPropagation(); toggle(); }}
                    style={{ fontSize: 10, padding: '0 2px' }}
                >{open ? '▼' : '▶'}</span>
                {icon && <span>{icon}</span>}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                {headerExtra}
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 400, color: 'var(--ca-text-muted)', flexShrink: 0 }}>({count})</span>
            </div>
            {open && <div style={{ paddingLeft: 4 }}>{children}</div>}
        </div>
    );
}

/**
 * v2 phase 4 #485 — FE/mobile screen content panel.
 *
 * Renders five primary sections (Interactions / Data sources /
 * Lifecycle / Nav-in / Nav-out) plus a collapsible "Visual elements"
 * inventory at the bottom. Sections with zero items collapse to
 * "(0)" — kept visible so the absence is informative.
 */
function ScreenContentPanel({ graph, onFileClick }: { graph: ApiListPanelProps['graph']; onFileClick: ApiListPanelProps['onFileClick'] }) {
    const items: L2bScreenItem[] = (graph.meta.screenItems ?? []) as L2bScreenItem[];
    const routePath = graph.meta.routePath ?? '/';
    const framework = graph.meta.framework ?? 'unknown';
    const filePath = (graph.meta as { filePath?: string }).filePath ?? '';
    // Visual section is collapsed by default — it's typically the
    // largest bucket and most users only need totals at a glance.
    const [visualOpen, setVisualOpen] = useState(false);

    const bySection: Record<L2bScreenItem['section'], L2bScreenItem[]> = {
        interactions: [],
        data: [],
        lifecycle: [],
        'nav-in': [],
        'nav-out': [],
        visual: [],
    };
    for (const item of items) {
        if (bySection[item.section]) bySection[item.section].push(item);
    }

    const renderRow = (item: L2bScreenItem) => (
        <div
            key={item.itemId}
            onClick={(e) => onFileClick(item.anchor.filePath ?? item.filePath, e)}
            style={{
                display: 'flex', gap: 8, padding: '6px 8px',
                cursor: 'pointer', borderRadius: 4,
                background: 'var(--ca-bg-elev)', marginBottom: 2,
                fontSize: 12, alignItems: 'baseline',
            }}
        >
            <span style={{ fontFamily: 'var(--ca-mono)', color: 'var(--ca-text-muted)', fontSize: 10, minWidth: 92 }}>
                {item.kind.replace(/^[\w-]+:/, '')}
            </span>
            <span style={{ flex: 1, color: 'var(--ca-text)' }}>{item.label}</span>
            {item.route && (
                <span style={{ fontFamily: 'var(--ca-mono)', color: 'var(--ca-text-muted)', fontSize: 10 }}>{item.route}</span>
            )}
        </div>
    );

    const Section = ({ title, sectionItems, defaultOpen = true, controlOpen, onToggle }: {
        title: string;
        sectionItems: L2bScreenItem[];
        defaultOpen?: boolean;
        controlOpen?: boolean;
        onToggle?: (open: boolean) => void;
    }) => {
        const [localOpen, setLocalOpen] = useState(defaultOpen);
        const open = controlOpen ?? localOpen;
        const setOpen = onToggle ?? setLocalOpen;
        return (
            <div style={{ marginBottom: 8 }}>
                <div
                    onClick={() => setOpen(!open)}
                    style={{
                        display: 'flex', gap: 6, alignItems: 'baseline',
                        padding: '6px 8px', cursor: 'pointer',
                        background: 'var(--ca-bg-card)', borderRadius: 4,
                        fontWeight: 600, fontSize: 12,
                        color: 'var(--ca-text)',
                    }}
                >
                    <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
                    <span>{title}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 400, color: 'var(--ca-text-muted)' }}>
                        ({sectionItems.length})
                    </span>
                </div>
                {open && sectionItems.length > 0 && (
                    <div style={{ padding: '4px 4px 0 4px' }}>{sectionItems.map(renderRow)}</div>
                )}
            </div>
        );
    };

    return (
        <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: 16, fontFamily: 'var(--ca-font)', background: 'var(--ca-bg)' }}>
            <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--ca-text)' }}>{routePath}</div>
                <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                    {framework} · {filePath}
                </div>
            </div>
            <Section title="Interactions" sectionItems={bySection.interactions} defaultOpen={true} />
            <Section title="Data sources" sectionItems={bySection.data} defaultOpen={true} />
            <Section title="Lifecycle" sectionItems={bySection.lifecycle} defaultOpen={true} />
            <Section title="Navigation in" sectionItems={bySection['nav-in']} defaultOpen={true} />
            <Section title="Navigation out" sectionItems={bySection['nav-out']} defaultOpen={true} />
            <Section
                title="Visual elements"
                sectionItems={bySection.visual}
                defaultOpen={false}
                controlOpen={visualOpen}
                onToggle={setVisualOpen}
            />
        </div>
    );
}

function ApiListPanel({ graph, onApiClick, onFileClick, highlightedNodes, savedViewsSlot }: ApiListPanelProps) {
    // v2 phase 4 #485 — FE/mobile screen content panel. When the
    // graph carries `meta.screenItems`, render the 5-section layout
    // instead of the backend 10-section HTTP layout.
    if (graph.meta.screenItems && graph.graphId.startsWith('screen-content:')) {
        return <ScreenContentPanel graph={graph} onFileClick={onFileClick} />;
    }
    const { clusterLabel, serviceId, apis = [], files = [], subsystems = [],
        screens = [], navRoutes = [], networkCalls = [], diBindings = [] } = graph.meta;
    // Frontend/mobile clusters expose "entry points" (screens/routes/data
    // calls), not "APIs" — adapt the header noun. Backend → "API".
    const isFE = isFrontendCategory(categoryFromGraph(graph));
    const l2bItemNoun = isFE ? 'entry point' : 'API';
    const [filterMethod, setFilterMethod] = useState<string>('ALL');
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);

    // Issue 251: Debounce search to prevent layout thrashing on every keystroke
    useEffect(() => {
        const timer = setTimeout(() => setSearchQuery(searchInput), 200);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // "/" key focuses search input
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !document.querySelector('.ca-modal-overlay')) {
                e.preventDefault();
                searchRef.current?.focus();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, []);

    // Check if an API handler is NL-query highlighted
    const isNlHighlighted = useCallback((api: ApiRecord) => {
        if (!highlightedNodes) return false;
        const key = `${api.filePath}::${api.handlerName}`;
        return highlightedNodes[key] === 'nl-query';
    }, [highlightedNodes]);

    // Issue 150: compute counts from search-filtered APIs (but not method-filtered)
    // so tabs show how many of each method match the current search.
    // BUG-FE-BACKEND-FILTERS: for a frontend/mobile scope the entry points live
    // in the dedicated screens / navRoutes / networkCalls / diBindings buckets,
    // not `apis`. Fold those in so the tab set reflects SCREEN / NAV / NET / DI
    // (never the meaningless HTTP verbs) instead of an empty tab bar.
    const tabSource = useMemo(
        () => [...apis, ...(screens as ApiRecord[]), ...(navRoutes as ApiRecord[]),
            ...(networkCalls as ApiRecord[]), ...(diBindings as ApiRecord[])],
        [apis, screens, navRoutes, networkCalls, diBindings],
    );
    const methodCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        const q = searchQuery.toLowerCase();
        const source = q
            ? tabSource.filter(a => a.route.toLowerCase().includes(q) || a.handlerName.toLowerCase().includes(q))
            : tabSource;
        for (const api of source) {
            counts[api.method] = (counts[api.method] || 0) + 1;
        }
        return counts;
    }, [tabSource, searchQuery]);

    // BUG-FE-BACKEND-FILTERS: the tab set adapts to the KINDS actually present
    // (HTTP verbs for backend, SCREEN / NAV / NET / DATA_FETCH / LIFECYCLE for
    // frontend) instead of a hardcoded GET/POST/… list. `ALL` is always first.
    const orderedMethods = useMemo(() => orderMethodTabs(methodCounts), [methodCounts]);
    const methodTabs = useMemo(() => ['ALL', ...orderedMethods], [orderedMethods]);

    const filteredApis = useMemo(() => {
        return apis.filter((api) => {
            const matchMethod = filterMethod === 'ALL' || api.method === filterMethod;
            const q = searchQuery.toLowerCase();
            const matchSearch = !q ||
                api.route.toLowerCase().includes(q) ||
                api.handlerName.toLowerCase().includes(q);
            return matchMethod && matchSearch;
        });
    }, [apis, filterMethod, searchQuery]);

    // Filter helper for mobile/FE sections — applies search query AND the active
    // method tab (BUG-FE-BACKEND-FILTERS: a SCREEN / NET / NAV tab must narrow the
    // dedicated sections, not just the `apis` bucket).
    const filterItems = useCallback((items: ApiRecord[]) => {
        const q = searchQuery.toLowerCase();
        return items.filter(item => {
            if (filterMethod !== 'ALL' && item.method !== filterMethod) return false;
            if (!q) return true;
            return item.route.toLowerCase().includes(q) ||
                item.handlerName.toLowerCase().includes(q) ||
                item.filePath.toLowerCase().includes(q);
        });
    }, [searchQuery, filterMethod]);

    const filteredScreens = useMemo(() => filterItems(screens as ApiRecord[]), [screens, filterItems]);
    const filteredNavRoutes = useMemo(() => filterItems(navRoutes as ApiRecord[]), [navRoutes, filterItems]);
    const filteredNetworkCalls = useMemo(() => filterItems(networkCalls as ApiRecord[]), [networkCalls, filterItems]);
    const filteredDiBindings = useMemo(() => filterItems(diBindings as ApiRecord[]), [diBindings, filterItems]);

    // Changed APIs grouped by diff status — shown at top
    const changedByDiff = useMemo(() => {
        const map: Record<string, ApiRecord[]> = { added: [], modified: [], deleted: [] };
        for (const api of filteredApis) {
            if (api.diff && api.diff !== 'unchanged') map[api.diff].push(api);
        }
        return map;
    }, [filteredApis]);

    const hasChanges = changedByDiff.added.length + changedByDiff.modified.length + changedByDiff.deleted.length > 0;

    // ─── Diff-focus: the Changed / +/−/~ filter composes with the method tabs +
    // search (counts derive from `filteredApis`, already method+search-filtered).
    const [changeFilter, setChangeFilter] = useState<ChangeFilter>('all');
    const scrollRef = useRef<HTMLDivElement>(null);
    const changeCounts = useMemo(() => computeChangeCounts(filteredApis), [filteredApis]);
    // Changed rows in display order (added → modified → deleted) for the top
    // "Changes" group, the stepper, and the minimap.
    const orderedChanged = useMemo(
        () => [...changedByDiff.added, ...changedByDiff.modified, ...changedByDiff.deleted],
        [changedByDiff],
    );
    const shownChanged = useMemo(
        () => orderedChanged.filter((a) => apiMatchesChangeFilter(a.diff, changeFilter)),
        [orderedChanged, changeFilter],
    );
    const changedIds = useMemo(() => orderedChanged.map((a) => a.apiId), [orderedChanged]);
    useEffect(() => { if (!hasChanges && changeFilter !== 'all') setChangeFilter('all'); }, [hasChanges, changeFilter]);

    // Tier 1 (Issue 364) — bucket every API into one of the entry-point
    // sections. HTTP routes stay in the file-grouped flow below; everything
    // else lands in its dedicated section so users can scan workers / CLI /
    // hooks / migrations / real-time as cohesive groups.
    const sectionedApis = useMemo(() => {
        const buckets: Record<string, ApiRecord[]> = {};
        for (const section of ENTRY_POINT_SECTIONS) buckets[section.key] = [];
        for (const api of filteredApis) {
            if (api.diff && api.diff !== 'unchanged') continue; // changes already shown at top
            for (const section of ENTRY_POINT_SECTIONS) {
                if (section.match(api.method)) {
                    buckets[section.key].push(api);
                    break;
                }
            }
        }
        return buckets;
    }, [filteredApis]);

    // Unchanged HTTP APIs grouped by file. Non-HTTP, non-mobile methods
    // belong to the dedicated entry-point sections above (sectionedApis)
    // and are excluded here so they don't render twice.
    const unchangedByFile = useMemo(() => {
        const groups = new Map<string, ApiRecord[]>();
        for (const api of filteredApis) {
            if (api.diff && api.diff !== 'unchanged') continue;
            if (MOBILE_METHODS.has(api.method)) continue;
            const isHttp = HTTP_METHODS.has(api.method);
            const inSection = ENTRY_POINT_SECTIONS.some(s => s.match(api.method));
            if (!isHttp && inSection) continue;
            if (!groups.has(api.filePath)) groups.set(api.filePath, []);
            groups.get(api.filePath)!.push(api);
        }
        return groups;
    }, [filteredApis]);

    return (
        <div className="ca-api-list">
            {/* Header */}
            <div className="ca-api-panel-top">
                <div className="ca-header-title">
                    <span className="ca-header-badge">Feature Detail</span>
                    <span>{clusterLabel ?? graph.graphId}</span>
                </div>
                <div className="ca-header-stats">
                    {serviceId && (
                        <span className="ca-stat">Service: {serviceId.replace('service:', '')}</span>
                    )}
                    {apis.length > 0 && <span className="ca-stat">{apis.length} {l2bItemNoun}{apis.length !== 1 ? 's' : ''}</span>}
                    {(screens as ApiRecord[]).length > 0 && <span className="ca-stat">{(screens as ApiRecord[]).length} screen{(screens as ApiRecord[]).length !== 1 ? 's' : ''}</span>}
                    {(networkCalls as ApiRecord[]).length > 0 && <span className="ca-stat">{(networkCalls as ApiRecord[]).length} network call{(networkCalls as ApiRecord[]).length !== 1 ? 's' : ''}</span>}
                    <span className="ca-stat">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                    {savedViewsSlot}
                </div>
            </div>

            {/* Filter bar */}
            <div className="ca-api-filter-bar">
                <input
                    ref={searchRef}
                    className="ca-api-search"
                    type="text"
                    placeholder="Filter by route or handler… (press /)"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                {/* BUG-FE-BACKEND-FILTERS: tabs derive from the KINDS present in
                    scope (orderMethodTabs) — HTTP verbs for backend, SCREEN / NAV /
                    NET / DATA_FETCH / LIFECYCLE for frontend — with friendly labels.
                    Hidden when only one kind exists (a lone ALL tab carries no
                    signal on a pure-single-kind scope). */}
                {orderedMethods.length >= 2 && (
                <div className="ca-method-tabs">
                    {methodTabs.map((m) => {
                        const allFilteredCount = Object.values(methodCounts).reduce((s, c) => s + c, 0);
                        const count = m === 'ALL' ? allFilteredCount : (methodCounts[m] ?? 0);
                        if (m !== 'ALL' && count === 0) return null;
                        const label = m === 'ALL' ? 'ALL' : (METHOD_TAB_LABEL[m] ?? m);
                        return (
                            <button
                                key={m}
                                className={`ca-method-tab${filterMethod === m ? ' active' : ''}`}
                                style={filterMethod === m && m !== 'ALL'
                                    ? { borderColor: methodColors[m] ?? 'var(--ca-accent)', color: methodColors[m] ?? 'var(--ca-accent)' }
                                    : undefined}
                                onClick={() => setFilterMethod(m)}
                                title={m === 'ALL' ? 'All entry points' : `Filter to ${m}`}
                            >
                                {label}
                                <span className="ca-method-tab-count">{count}</span>
                            </button>
                        );
                    })}
                </div>
                )}
            </div>

            {/* Diff-focus: Changed / +/−/~ chips + jump stepper. Composes with the
                method tabs + search above (counts derive from filteredApis). */}
            <div style={{ padding: '0 12px' }}>
                <DiffFocusBar
                    counts={changeCounts}
                    filter={changeFilter}
                    onFilterChange={setChangeFilter}
                    changedIds={changedIds}
                    scrollContainerRef={scrollRef}
                />
            </div>

            {/* Main scrollable API section */}
            <div className="ca-api-list-main" ref={scrollRef}>
                {filteredApis.length === 0 && (
                    <div className="ca-api-list-empty">
                        {apis.length === 0 ? (
                            <>
                                <p>No API endpoints or screens detected in this area.</p>
                                <p style={{ fontSize: '0.85em', opacity: 0.8 }}>
                                    This may be a library or utility module without HTTP routes.
                                    Try exploring individual files at the <strong>File level (L4)</strong> or
                                    function control flow at the <strong>Flow level (L5)</strong> instead.
                                </p>
                            </>
                        ) : (
                            <p>No results match your filter.</p>
                        )}
                    </div>
                )}

                {/* Changes group — added / modified / deleted at top (collapsible) */}
                {hasChanges && (
                    <CollapsibleSection
                        key={`changes:${changeFilter}`}
                        title="Changes"
                        color="var(--ca-warning)"
                        count={shownChanged.length}
                        defaultOpen
                        headerExtra={
                            <>
                                {changedByDiff.added.length > 0 && (
                                    <span className="ca-changes-pill added">{changedByDiff.added.length} added</span>
                                )}
                                {changedByDiff.modified.length > 0 && (
                                    <span className="ca-changes-pill modified">{changedByDiff.modified.length} modified</span>
                                )}
                                {changedByDiff.deleted.length > 0 && (
                                    <span className="ca-changes-pill deleted">{changedByDiff.deleted.length} deleted</span>
                                )}
                            </>
                        }
                    >
                        <div className="ca-api-rows">
                            {shownChanged.map((api) => (
                                <ApiRow key={api.apiId} api={api} onApiClick={onApiClick} showFile nlHighlighted={isNlHighlighted(api)} />
                            ))}
                        </div>
                    </CollapsibleSection>
                )}

                {/* Tier 1 (Issue 364) — entry-point sections. Hidden when a
                    change filter is active (only the Changes group shows), so
                    the diff-focus filter isolates changes across all sections. */}
                {changeFilter === 'all' && ENTRY_POINT_SECTIONS.map((section) => {
                    const items = sectionedApis[section.key];
                    if (!items || items.length === 0) return null;
                    return (
                        <CollapsibleSection
                            key={section.key}
                            title={section.title}
                            icon={section.icon}
                            color={section.color}
                            count={items.length}
                            defaultOpen
                            onToggle={(open) => {
                                if (open) trackWebviewEvent('entry_point_section_opened', { section: section.key, count: items.length });
                            }}
                        >
                            <div className="ca-api-rows">
                                {items.map((api) => (
                                    <ApiRow key={api.apiId} api={api} onApiClick={onApiClick} showFile nlHighlighted={isNlHighlighted(api)} />
                                ))}
                            </div>
                        </CollapsibleSection>
                    );
                })}

                {/* Unchanged APIs grouped by file (each file is collapsible).
                    Hidden when a change filter is active — only the Changes group shows. */}
                {changeFilter === 'all' && [...unchangedByFile.entries()].map(([filePath, fileApis]) => (
                    <CollapsibleSection
                        key={filePath}
                        title={filePath.split('/').pop() || filePath}
                        icon="📄"
                        color="var(--ca-edge-unchanged)"
                        count={fileApis.length}
                        defaultOpen
                        headerTitle={fileApis.length > 0 ? `Click filename to open sequence: ${fileApis[0].method} ${fileApis[0].route}` : `Open file diagram: ${filePath}`}
                        onHeaderClick={(e) => {
                            // Issue 138: clicking the file header opens the first API's
                            // sequence diagram (L2b → L3) instead of the L4 file diagram.
                            if (fileApis.length > 0) onApiClick(fileApis[0], e as any);
                            else onFileClick(filePath, e);
                        }}
                        headerExtra={
                            <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--ca-text-muted)', flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filePath}>
                                {filePath}
                            </span>
                        }
                    >
                        <div className="ca-api-rows">
                            {fileApis.map((api) => (
                                <ApiRow key={api.apiId} api={api} onApiClick={onApiClick} nlHighlighted={isNlHighlighted(api)} />
                            ))}
                        </div>
                    </CollapsibleSection>
                ))}

                {/* ─── Mobile/UI sections + Subsystems — hidden when a change
                    filter is active so only the Changes group shows. ─── */}
                {changeFilter === 'all' && (<>
                {/* BUG-FE-NO-L3L4L5: a SCREEN row's handler is the screen/page
                    component — it has a real sequence (render-flow, L3) graph, so
                    clicking it drills to L3 like a backend endpoint (onApiClick →
                    openSequenceForApi). Nav / network / DI rows point at hook call
                    sites (useQuery / router.push) with no sequence graph, so those
                    keep file-level (L4) navigation. */}
                <CollapsibleSection title="Screens / Pages" icon="📱" color="var(--ca-color-blue)" count={filteredScreens.length}
                    onToggle={(open) => { if (open) trackWebviewEvent('mobile_section_opened', { section: 'screens', count: filteredScreens.length }); }}>
                    {filteredScreens.map((item: ApiRecord) => (
                        <ApiRow key={item.apiId} api={item} showFile={true} onApiClick={(_, e) => onApiClick(item, e)} nlHighlighted={isNlHighlighted(item)} />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title="Navigation Routes" icon="🧭" color="var(--ca-color-teal)" count={filteredNavRoutes.length}
                    onToggle={(open) => { if (open) trackWebviewEvent('mobile_section_opened', { section: 'nav_routes', count: filteredNavRoutes.length }); }}>
                    {filteredNavRoutes.map((item: ApiRecord) => (
                        <ApiRow key={item.apiId} api={item} showFile={true} onApiClick={(_, e) => onFileClick(item.filePath, e)} nlHighlighted={isNlHighlighted(item)} />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title="Network Calls" icon="🌐" color="var(--ca-color-orange)" count={filteredNetworkCalls.length}
                    onToggle={(open) => { if (open) trackWebviewEvent('mobile_section_opened', { section: 'network', count: filteredNetworkCalls.length }); }}>
                    {filteredNetworkCalls.map((item: ApiRecord) => (
                        <ApiRow key={item.apiId} api={item} showFile={true} onApiClick={(_, e) => onFileClick(item.filePath, e)} nlHighlighted={isNlHighlighted(item)} />
                    ))}
                </CollapsibleSection>

                <CollapsibleSection title="Dependencies" icon="📦" color="var(--ca-color-purple)" count={filteredDiBindings.length}
                    onToggle={(open) => { if (open) trackWebviewEvent('mobile_section_opened', { section: 'dependencies', count: filteredDiBindings.length }); }}>
                    {filteredDiBindings.map((item: ApiRecord) => (
                        <ApiRow key={item.apiId} api={item} showFile={true} onApiClick={(_, e) => onFileClick(item.filePath, e)} nlHighlighted={isNlHighlighted(item)} />
                    ))}
                </CollapsibleSection>

                {/* Subsystems (collapsible) */}
                <CollapsibleSection
                    title="Subsystems"
                    icon="🧩"
                    color="var(--ca-accent)"
                    count={subsystems.length}
                    defaultOpen={false}
                >
                    <div className="ca-api-subsystems-body">
                        {subsystems.map((sys) => (
                            <div
                                key={sys.label}
                                className={`ca-api-row ca-api-row-subsystem${sys.filePath ? ' ca-clickable' : ''}`}
                                onClick={(e) => sys.filePath && onFileClick(sys.filePath, e)}
                                title={sys.filePath ? `Open file diagram: ${sys.filePath}` : sys.label}
                            >
                                <span
                                    className="ca-method-badge"
                                    style={{ background: kindColors[sys.kind] ?? 'var(--ca-edge-unchanged)' }}
                                >
                                    {sys.kind}
                                </span>
                                <span className="ca-api-route">{sys.label}</span>
                                {sys.filePath && (
                                    <span className="ca-api-handler" style={{ color: 'var(--ca-text-muted)' }}>
                                        {sys.filePath}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </CollapsibleSection>
                </>)}
            </div>

            {/* Feature #3 — scrollbar change markers pinned to the panel's right edge. */}
            <DiffMinimap scrollContainerRef={scrollRef} version={`${changeFilter}:${graph.graphId}:${changeCounts.changed}`} />
        </div>
    );
}

export default ApiListPanel;
