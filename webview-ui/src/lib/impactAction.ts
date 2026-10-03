/**
 * impactAction.ts — decide what the "Impact Analysis" toolbar button should do.
 *
 * BUG-EXPLORE-7: the toolbar Impact button always opened a "Select File" picker,
 * even when the user was already ON a file / flow / sequence view. When the
 * current graph identifies a file, run impact on THAT file directly (skip the
 * picker); otherwise fall back to the file picker.
 */

export type ImpactAction =
    | { type: 'requestImpact'; filePath: string }
    | { type: 'runCommand'; command: 'codeatlas.analyzeImpact' };

/** Extract the workspace-relative file path a graphId points at, if any. */
function filePathFromGraphId(graphId: string): string | null {
    // `file:<path>`
    if (graphId.startsWith('file:')) return graphId.slice('file:'.length) || null;
    // `flow:<path>:<fn>` / `sequence:<path>:<handler>` — the path is up to the
    // FIRST ':' after the prefix (workspace-relative paths never contain ':';
    // the handler name after it may — e.g. `anonymous@GET:/x`).
    for (const prefix of ['flow:', 'sequence:']) {
        if (graphId.startsWith(prefix)) {
            const rest = graphId.slice(prefix.length);
            const i = rest.indexOf(':');
            return i > 0 ? rest.slice(0, i) : null;
        }
    }
    return null;
}

/**
 * The message the Impact button should post given the currently-viewed graph.
 * When the graph resolves to a file, request impact on it directly; otherwise
 * open the file picker (legacy behaviour).
 */
export function impactActionForGraphId(graphId: string | null | undefined): ImpactAction {
    const filePath = graphId ? filePathFromGraphId(graphId) : null;
    if (filePath) return { type: 'requestImpact', filePath };
    return { type: 'runCommand', command: 'codeatlas.analyzeImpact' };
}
