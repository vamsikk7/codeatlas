/**
 * initProgressPhases.ts — #918 part (a).
 *
 * The orchestrator already emits NAMED phases (`scanning` / `parsing` /
 * `building` / `finalizing` / `complete`) plus, since #918, live `building`
 * sub-steps. This module turns the raw `{ phase, progress }` feed into a
 * step-breadcrumb + a rough ETA so the init UI is more than a bare bar.
 *
 * Pure functions only — unit-tested directly without rendering HomePage.
 */

export interface InitPhaseStep {
    /** Orchestrator phase keys that map onto this user-facing step. */
    keys: string[];
    /** Short label shown in the breadcrumb. */
    label: string;
}

/**
 * Ordered, user-facing init phases. `starting` / `resync` fold into Scanning
 * (they precede the first file read); `complete` is terminal and never shown
 * as an active step (the bar disappears at 100%).
 */
export const INIT_PHASES: InitPhaseStep[] = [
    { keys: ['starting', 'resync', 'scanning'], label: 'Scanning' },
    { keys: ['parsing'], label: 'Parsing' },
    { keys: ['building'], label: 'Building' },
    { keys: ['finalizing'], label: 'Finalizing' },
];

/**
 * Index of the currently-active step for a given orchestrator phase, or the
 * last step once the phase is `complete`. Returns 0 for unknown phases so a
 * surprise phase string never blanks the breadcrumb.
 */
export function phaseStepIndex(phase: string): number {
    if (phase === 'complete') return INIT_PHASES.length;
    const idx = INIT_PHASES.findIndex((p) => p.keys.includes(phase));
    return idx < 0 ? 0 : idx;
}

export type PhaseStepStatus = 'done' | 'active' | 'todo';

/** Per-step status for the breadcrumb given the active phase. */
export function phaseStepStatuses(phase: string): PhaseStepStatus[] {
    const cur = phaseStepIndex(phase);
    return INIT_PHASES.map((_p, i) =>
        i < cur ? 'done' : i === cur ? 'active' : 'todo',
    );
}

/**
 * Rough remaining-seconds estimate via linear extrapolation from elapsed time
 * and progress fraction. Deliberately conservative — returns null near the
 * ends (where the linear model is least reliable: the first 5% has no signal,
 * the last 5% is dominated by the finalize flush) so the UI shows an ETA only
 * in the stable middle band.
 */
export function estimateEtaSeconds(progress: number, elapsedMs: number): number | null {
    if (!(progress > 0.05) || progress >= 0.95) return null;
    if (!(elapsedMs > 0)) return null;
    const elapsedSec = elapsedMs / 1000;
    const totalSec = elapsedSec / progress;
    const remain = totalSec - elapsedSec;
    if (!isFinite(remain) || remain <= 0) return null;
    return Math.max(1, Math.round(remain));
}
