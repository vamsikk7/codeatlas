/**
 * savedViews/filterViews.ts — #750 saved filter views (2026-06-06).
 *
 * Filter-snapshot persistence for the webview's Knowledge Map + API
 * List surfaces. A `SavedFilterView` captures the route + a free-form
 * `filters` blob at a moment in time so the user can restore the
 * exact view later.
 *
 * Storage: `<workspaceRoot>/.codeatlas/saved-filter-views.json` — an
 * array of records. Sister file to `.codeatlas/saved-queries.json`
 * (the SQL-query-based variant used by MCP). The two files are
 * intentionally separate to avoid coupling the two unrelated concerns.
 *
 * All four functions are pure: no extension-host or webview concerns.
 * Callers in `src/extension.ts` / `src/standalone/messageHandler.ts`
 * route WS messages through these.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SavedFilterView {
    /** Stable identifier — typically a slug of the name + timestamp. */
    id: string;
    /** Human-readable label shown in the picker. */
    name: string;
    /** Webview route to restore (hash without the `#`, e.g. `/apis/cluster:auth`). */
    route: string;
    /** Free-form filter blob — the view that owns the saved state defines the shape. */
    filters: Record<string, unknown>;
    /** ms-since-epoch creation timestamp. */
    createdAt: number;
    /** Optional free-form description. */
    description?: string;
}

const VIEWS_FILE = path.join('.codeatlas', 'saved-filter-views.json');

function viewsPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, VIEWS_FILE);
}

function isValidView(raw: unknown): raw is SavedFilterView {
    if (!raw || typeof raw !== 'object') return false;
    const v = raw as any;
    return typeof v.id === 'string'
        && typeof v.name === 'string'
        && typeof v.route === 'string'
        && v.filters != null
        && typeof v.filters === 'object'
        && typeof v.createdAt === 'number';
}

export function loadSavedFilterViews(workspaceRoot: string): SavedFilterView[] {
    const p = viewsPath(workspaceRoot);
    if (!fs.existsSync(p)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter(isValidView);
    } catch {
        return [];
    }
}

export function saveFilterView(workspaceRoot: string, view: SavedFilterView): SavedFilterView {
    if (!view || typeof view !== 'object') throw new Error('saveFilterView: view must be an object');
    if (typeof (view as any).id !== 'string' || !(view as any).id) throw new Error('saveFilterView: missing id');
    if (typeof (view as any).route !== 'string' || !(view as any).route) throw new Error('saveFilterView: missing route');
    const codeatlasDir = path.join(workspaceRoot, '.codeatlas');
    if (!fs.existsSync(codeatlasDir)) fs.mkdirSync(codeatlasDir, { recursive: true });
    const existing = loadSavedFilterViews(workspaceRoot);
    const idx = existing.findIndex(v => v.id === view.id);
    if (idx >= 0) existing[idx] = view;
    else existing.push(view);
    fs.writeFileSync(viewsPath(workspaceRoot), JSON.stringify(existing, null, 2));
    return view;
}

export function deleteFilterView(workspaceRoot: string, id: string): boolean {
    const existing = loadSavedFilterViews(workspaceRoot);
    if (existing.length === 0) return false;
    const idx = existing.findIndex(v => v.id === id);
    if (idx < 0) return false;
    existing.splice(idx, 1);
    fs.writeFileSync(viewsPath(workspaceRoot), JSON.stringify(existing, null, 2));
    return true;
}

export function findSavedFilterView(workspaceRoot: string, id: string): SavedFilterView | null {
    const existing = loadSavedFilterViews(workspaceRoot);
    return existing.find(v => v.id === id) ?? null;
}
