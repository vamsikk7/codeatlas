/**
 * BUG-POLAR-26: the Tour empty state showed "No tour steps yet — initialize the
 * workspace, then re-open the tour" for BOTH tour modes. On the "Recent changes"
 * tour of an already-INITIALIZED but clean workspace that misleads the user into
 * re-initializing — there are simply no recent changes. Make the message
 * mode-aware so "not initialized" and "initialized but clean" read differently.
 */

export type TourMode = 'codebase' | 'recent';

export function tourEmptyMessage(mode: TourMode, loading: boolean): string {
    if (loading) return 'Building tour…';
    return mode === 'recent'
        ? 'No recent changes to walk through — edit some files (or switch to the Codebase tour).'
        : 'No tour steps yet — initialize the workspace, then re-open the tour.';
}
