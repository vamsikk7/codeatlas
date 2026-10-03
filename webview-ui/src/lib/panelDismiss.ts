/**
 * panelDismiss.ts — when should file-scoped floating panels auto-close?
 *
 * BUG-EXPLORE-8: the Impact / Blast-Radius panel (scoped to a specific file)
 * lingered across navigation to unrelated views (Knowledge Map, Domains,
 * Health) with a stale scope. It should stay open only while the user keeps
 * exploring FILE-LEVEL views (file / flow / sequence — where a blast radius is
 * meaningful and where clicking a dependent navigates), and auto-dismiss the
 * moment the user jumps to a non-file destination (L1 / L2 / map / domain /
 * health).
 */

export function shouldDismissFileScopedPanel(toGraphId: string | null | undefined): boolean {
    if (!toGraphId) return true;
    return !(
        toGraphId.startsWith('file:') ||
        toGraphId.startsWith('flow:') ||
        toGraphId.startsWith('sequence:')
    );
}
