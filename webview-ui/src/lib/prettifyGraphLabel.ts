/**
 * Issue UX-6 (2026-06-03) — single helper used by `document.title`,
 * breadcrumbs and panel labels so users never see raw graphIds.
 *
 * Mapping:
 *   - `microservice:workspace`              → "System Design"
 *   - `feature:workspace`                   → "Feature Areas"
 *   - `feature:service:<sid>`               → "Features: <sid>"
 *   - `feature:<id>`                        → "Features: <id>"
 *   - `api-list:cluster:<id>`               → "APIs: <id>"
 *   - `api-list:<id>`                       → "APIs: <id>"
 *   - `sequence:<file>:anonymous@<M>:<r>`   → "Sequence: <M> <r>"
 *   - `sequence:<file>:<handler>`           → "Sequence: <handler>()"
 *   - `flow:<file>:<fn>`                    → "Flow: <fn>()"
 *   - `file:<file>`                         → "File: <basename>"
 *   - `map:workspace`                       → "Knowledge Map"
 *   - `domain:workspace`                    → "Business Domains"
 *   - `tour:workspace`                      → "Tour"
 *   - `health:report`                       → "Health Report"
 *
 * Falls back to the caller-supplied label, then to the raw graphId.
 *
 * `category` (optional) makes the L2b `api-list:*` noun adapt: backend →
 * "APIs", frontend/mobile → "Entry Points". Omitted / backend → "APIs".
 */
export function prettifyGraphLabel(graphId: string | undefined, fallback?: string, category?: string): string {
    if (!graphId) return fallback ?? '';
    const l2bNoun = (category === 'frontend' || category === 'mobile') ? 'Entry Points' : 'APIs';

    if (graphId === 'microservice:workspace') return 'System Design';
    if (graphId === 'map:workspace') return 'Knowledge Map';
    if (graphId === 'domain:workspace') return 'Business Domains';
    if (graphId === 'tour:workspace') return 'Tour';
    if (graphId === 'health:report') return 'Health Report';
    if (graphId === 'feature:workspace') return 'Feature Areas';

    if (graphId.startsWith('feature:service:')) {
        return `Features: ${graphId.slice('feature:service:'.length)}`;
    }
    if (graphId.startsWith('feature:')) {
        return `Features: ${graphId.slice('feature:'.length)}`;
    }

    if (graphId.startsWith('api-list:cluster:')) {
        return `${l2bNoun}: ${graphId.slice('api-list:cluster:'.length)}`;
    }
    if (graphId.startsWith('api-list:')) {
        return `${l2bNoun}: ${graphId.slice('api-list:'.length)}`;
    }

    if (graphId.startsWith('sequence:')) {
        const rest = graphId.slice('sequence:'.length);
        // Anonymous shape: `<file>:anonymous@<METHOD>:<route>`. The route
        // itself may contain colons (`/articles/:slug`) so anchor the
        // match on the literal `:anonymous@` token.
        const anonMatch = rest.match(/^(.+?):anonymous@([A-Z]+):(.+)$/);
        if (anonMatch) {
            return `Sequence: ${anonMatch[2]} ${anonMatch[3]}`;
        }
        // Named-handler shape: `<file>:<handler>`. file has no colons in
        // practice, so lastIndexOf(':') splits cleanly.
        const lastColon = rest.lastIndexOf(':');
        if (lastColon < 0) return `Sequence: ${rest}`;
        const handlerPart = rest.slice(lastColon + 1);
        const filePart = rest.slice(0, lastColon);
        return `Sequence: ${handlerPart}() — ${basename(filePart)}`;
    }

    if (graphId.startsWith('flow:')) {
        const rest = graphId.slice('flow:'.length);
        const lastSep = rest.lastIndexOf(':');
        if (lastSep < 0) return `Flow: ${rest}`;
        const fn = rest.slice(lastSep + 1);
        return `Flow: ${fn}()`;
    }

    if (graphId.startsWith('file:')) {
        const fp = graphId.slice('file:'.length);
        return `File: ${basename(fp)}`;
    }

    return fallback ?? graphId;
}

function basename(filePath: string): string {
    const slash = filePath.lastIndexOf('/');
    return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}
