/**
 * BUG-POLAR-25: the FE/mobile L2a header showed a single dominant framework
 * ("expo-router · 421 screens") while every visible row was tagged a DIFFERENT
 * framework ("nextjs-app") — a repo with both a Next.js web app and an Expo
 * app reads as a contradiction. When screens span multiple frameworks, show a
 * per-framework breakdown instead of one label.
 */

interface ScreenNode { meta?: { framework?: string }; data?: { meta?: { framework?: string } } }

/** Count screens per framework, most-common first. */
export function screenFrameworkBreakdown(screens: ScreenNode[] | undefined): Array<{ framework: string; count: number }> {
    const counts = new Map<string, number>();
    for (const s of screens ?? []) {
        const fw = s?.meta?.framework ?? s?.data?.meta?.framework;
        if (!fw || fw === 'unknown') continue;
        counts.set(fw, (counts.get(fw) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([framework, count]) => ({ framework, count }))
        .sort((a, b) => b.count - a.count || a.framework.localeCompare(b.framework));
}

/**
 * Header framework label. Single framework → its name (matches the rows).
 * Multiple → top-3 breakdown with counts ("expo-router 220 · nextjs-app 201")
 * so the header can't contradict the per-row tags. Falls back to `dominant`
 * when no per-screen framework metadata is present.
 */
export function formatScreenFrameworkLabel(screens: ScreenNode[] | undefined, dominant?: string): string {
    const bd = screenFrameworkBreakdown(screens);
    if (bd.length === 0) return dominant ?? 'unknown';
    if (bd.length === 1) return bd[0].framework;
    return bd.slice(0, 3).map((b) => `${b.framework} ${b.count}`).join(' · ');
}
