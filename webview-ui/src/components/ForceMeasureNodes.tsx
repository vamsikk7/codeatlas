/**
 * ForceMeasureNodes — invisible RF child that forces handleBounds registration.
 *
 * Background (2026-06-09 live-verify finding):
 * React Flow v11's `ResizeObserver`-based node measurement misses on the
 * first-mount path when `defaultNodes` lands before the observer attaches.
 * Symptom: `nodeInternals` has the right shape (width/height/positionAbsolute
 * all populated) but `handleBounds` stays undefined; the `EdgeRenderer`'s
 * `getNodeData` returns `isValid = false` per edge; the inner
 * `<g.react-flow__edges>` group renders empty even when the prop carries
 * valid edges and handles render in the DOM.
 *
 * The reliable fix: directly call `updateNodeDimensions` against the RF
 * store for every visible node DOM element, with `forceUpdate: true`. That
 * synchronously runs `getDimensions` + `getHandleBounds(.source/.target,
 * nodeElement, ...)` and stamps `handleBounds` on the store; the next
 * `EdgeRenderer` pass sees a valid node and renders the edge SVG paths.
 *
 * Implementation: pulls the zustand store via `useStoreApi` (works because
 * this component lives INSIDE `<ReactFlow>`, which provides the context),
 * grabs the node DOM elements off `domNode`, and re-stamps dimensions on a
 * widening schedule after every `nodeIds` change, stopping early once every
 * node carries `handleBounds`.
 *
 * BUG-EXPLORE-3 (2026-07-15): a rAF-only schedule (~32ms) reliably measured
 * the FIRST mount but LOST the race on the DiagramView→DiagramView keyed
 * REMOUNT (navigating file↔flow↔file). There the outer `DiagramView` instance
 * persists and only `<ReactFlow key={graphId}>` remounts; the force fired
 * before RF had committed the new graph's node DOM + stamped `handleBounds`,
 * and RF's own later ResizeObserver measure left `handleBounds` unset, so
 * `EdgeRenderer` dropped every edge (0 edges after navigation, no recovery).
 * The fix: after the immediate + rAF passes, keep re-stamping on a setTimeout
 * ladder that OUTLASTS RF's settle, and bail as soon as all nodes are
 * measured. Cheap in steady state (the very first pass early-stops once
 * `handleBounds` are present).
 */
import { useEffect } from 'react';
import { useStoreApi } from 'reactflow';

interface Props {
    nodeIds: string[];
}

// setTimeout ladder (ms) that outlasts RF's ResizeObserver-driven remeasure on
// the keyed-remount path. Wide enough that the last re-stamp lands after the
// canvas has settled, so `handleBounds` sticks.
const FORCE_LADDER_MS = [16, 48, 120, 300, 600];

export function ForceMeasureNodes({ nodeIds }: Props) {
    const store = useStoreApi();
    useEffect(() => {
        if (nodeIds.length === 0) return;
        const rafs: number[] = [];
        const timers: number[] = [];
        let done = false;

        // Every requested node has real dimensions + handleBounds → edges can
        // render, so the remaining schedule is redundant.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allMeasured = (state: any): boolean => {
            const ni = state.nodeInternals;
            if (!ni || typeof ni.get !== 'function') return false;
            return nodeIds.every((id) => {
                const n = ni.get(id);
                return !!(n && n.handleBounds && n.width && n.height);
            });
        };

        const doForce = (): void => {
            if (done) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const state = store.getState() as any;
            const domNode = state.domNode as HTMLElement | null;
            if (!domNode) return;
            const updates = nodeIds.map((id) => {
                const el = domNode.querySelector(`.react-flow__node[data-id="${id}"]`);
                return el
                    ? { id, nodeElement: el as HTMLElement, forceUpdate: true }
                    : null;
            }).filter((u): u is { id: string; nodeElement: HTMLElement; forceUpdate: boolean } => u !== null);
            if (updates.length === 0) return;
            state.updateNodeDimensions(updates);
            if (allMeasured(store.getState())) {
                done = true;
                rafs.forEach((r) => window.cancelAnimationFrame(r));
                timers.forEach((t) => window.clearTimeout(t));
            }
        };

        // Immediate (nodes already committed) + a two-frame rAF chain (still
        // mounting) + a widening setTimeout ladder (keyed-remount settle race).
        doForce();
        rafs.push(window.requestAnimationFrame(() => {
            doForce();
            rafs.push(window.requestAnimationFrame(doForce));
        }));
        FORCE_LADDER_MS.forEach((ms) => {
            timers.push(window.setTimeout(doForce, ms));
        });

        return () => {
            done = true;
            rafs.forEach((r) => window.cancelAnimationFrame(r));
            timers.forEach((t) => window.clearTimeout(t));
        };
    }, [nodeIds, store]);
    return null;
}
