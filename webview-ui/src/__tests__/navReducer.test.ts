import { describe, it, expect } from 'vitest';
import { navReducer, NavState, NavAction, NavEntry } from '../App';

describe('navReducer', () => {
    const createEntry = (id: string): NavEntry => ({
        graphId: id,
        mode: 'file',
        graph: { graphId: id, type: 'file', nodes: [], edges: [], anchors: {}, meta: {} },
        label: `Label ${id}`,
    });

    it('should push a new entry to an empty stack', () => {
        const initialState: NavState = { stack: [], index: -1 };
        const entry = createEntry('a');
        const action: NavAction = { type: 'push', entry };
        const nextState = navReducer(initialState, action);

        expect(nextState.stack.length).toBe(1);
        expect(nextState.index).toBe(0);
        expect(nextState.stack[0].graphId).toBe('a');
    });

    it('should push a new entry to a non-empty stack', () => {
        const initialState: NavState = {
            stack: [createEntry('a')],
            index: 0,
        };
        const entry = createEntry('b');
        const action: NavAction = { type: 'push', entry };
        const nextState = navReducer(initialState, action);

        expect(nextState.stack.length).toBe(2);
        expect(nextState.index).toBe(1);
        expect(nextState.stack[1].graphId).toBe('b');
    });

    it('should truncate the stack and replace the entry if the graphId already exists in the history (prevent infinite loop)', () => {
        const initialState: NavState = {
            stack: [createEntry('a'), createEntry('b'), createEntry('c')],
            index: 2,
        };
        // Pushing 'a' again should go back to index 0 and replace 'a'
        const entry = createEntry('a');
        entry.label = 'Updated Label A'; // simulate newer data
        const action: NavAction = { type: 'push', entry };
        const nextState = navReducer(initialState, action);

        expect(nextState.stack.length).toBe(1);
        expect(nextState.index).toBe(0);
        expect(nextState.stack[0].graphId).toBe('a');
    });

    it('should truncate forward history when pushing a new distinct entry from a middle index', () => {
        const initialState: NavState = {
            stack: [createEntry('a'), createEntry('b'), createEntry('c')],
            index: 0, // Currently looking at 'a', 'b' and 'c' are forward history
        };
        const entry = createEntry('d');
        const action: NavAction = { type: 'push', entry };
        const nextState = navReducer(initialState, action);

        expect(nextState.stack.length).toBe(2); // 'a' and 'd'
        expect(nextState.index).toBe(1);
        expect(nextState.stack[1].graphId).toBe('d');
    });

    it('should update index safely using go action', () => {
        const initialState: NavState = {
            stack: [createEntry('a'), createEntry('b'), createEntry('c')],
            index: 2,
        };
        
        // Go back to 0
        let nextState = navReducer(initialState, { type: 'go', index: 0 });
        expect(nextState.index).toBe(0);
        expect(nextState.stack.length).toBe(3); // Stack is preserved

        // Go forward to 1
        nextState = navReducer(nextState, { type: 'go', index: 1 });
        expect(nextState.index).toBe(1);

        // Out of bounds (negative)
        nextState = navReducer(nextState, { type: 'go', index: -5 });
        expect(nextState.index).toBe(0);

        // Out of bounds (positive)
        nextState = navReducer(nextState, { type: 'go', index: 10 });
        expect(nextState.index).toBe(2);
    });

    it('should completely clear the stack with clear action', () => {
        const initialState: NavState = {
            stack: [createEntry('a'), createEntry('b'), createEntry('c')],
            index: 2,
        };
        const nextState = navReducer(initialState, { type: 'clear' });

        expect(nextState.stack.length).toBe(0);
        expect(nextState.index).toBe(-1);
    });

    // ─── BREAD-1 (2026-06-07): workspace-root push resets the stack ──────────
    //
    // The live-verify finding: breadcrumb showed a non-monotonic chain like
    // `APIs › sequence › System Design › file` because each navbar click
    // (System Design between deeper layers) appended to history. The fix:
    // workspace-root graphIds (microservice:workspace, feature:workspace,
    // map:workspace, domain:workspace, tour:workspace, health:report) are
    // architectural ROOTS — navigating to them treats it as a fresh start
    // so the breadcrumb stays hierarchically consistent.
    describe('BREAD-1: workspace-root push resets the stack', () => {
        it('pushing microservice:workspace from a deep stack resets to length 1', () => {
            const initialState: NavState = {
                stack: [
                    createEntry('api-list:cluster:auth'),
                    createEntry('sequence:src/auth/auth.controller.ts:anonymous@POST:/users/login'),
                ],
                index: 1,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('microservice:workspace'),
            });
            expect(next.stack.length).toBe(1);
            expect(next.stack[0].graphId).toBe('microservice:workspace');
            expect(next.index).toBe(0);
        });

        it('pushing feature:workspace resets the stack', () => {
            const initialState: NavState = {
                stack: [createEntry('flow:src/x.ts:fn'), createEntry('file:src/x.ts')],
                index: 1,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('feature:workspace'),
            });
            expect(next.stack.length).toBe(1);
            expect(next.stack[0].graphId).toBe('feature:workspace');
        });

        it('pushing health:report resets the stack', () => {
            const initialState: NavState = {
                stack: [createEntry('file:a.ts'), createEntry('api-list:cluster:auth')],
                index: 1,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('health:report'),
            });
            expect(next.stack.length).toBe(1);
        });

        it('does NOT reset for non-root layers — file:* pushes normally', () => {
            const initialState: NavState = {
                stack: [createEntry('microservice:workspace')],
                index: 0,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('file:src/x.ts'),
            });
            expect(next.stack.length).toBe(2);
            expect(next.stack[1].graphId).toBe('file:src/x.ts');
        });

        it('does NOT reset for api-list:* (drill-in, not a root)', () => {
            const initialState: NavState = {
                stack: [createEntry('feature:workspace')],
                index: 0,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('api-list:cluster:auth'),
            });
            expect(next.stack.length).toBe(2);
        });

        it('does NOT reset when the root push duplicates an existing entry — falls through to existing dedup logic', () => {
            // microservice:workspace already at index 0; clicking it again
            // should still rewind to that entry (which is what the existing
            // dedup branch does), not start a fresh stack of length 1 at
            // a NEW index.
            const initialState: NavState = {
                stack: [createEntry('microservice:workspace'), createEntry('feature:workspace')],
                index: 1,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('microservice:workspace'),
            });
            expect(next.stack.length).toBe(1);
            expect(next.stack[0].graphId).toBe('microservice:workspace');
            expect(next.index).toBe(0);
        });
    });

    // ─── #784 (2026-06-07): back-button preserves history across root-to-root hops ──
    //
    // The BREAD-1 reset was too aggressive: even when the prior entry was
    // already a workspace-root (e.g. user landed at #/system-design directly,
    // then clicked the Feature Areas command-bar button), the reset wiped
    // System Design out of history. Result: clicking back went straight to
    // home instead of returning to System Design. The fix: only reset when
    // the prior entry was a DEEP drill-in. Root → root is a layer hop that
    // back-navigation should be able to undo.
    describe('#784: root-to-root push preserves back-nav history', () => {
        it('pushing feature:workspace WHEN prior is microservice:workspace keeps both in stack', () => {
            // Direct-URL entry: user landed at #/system-design (push
            // microservice:workspace into empty stack), then clicked the
            // Feature Areas command-bar button (push feature:workspace).
            // Stack should grow to length 2 so back returns to System Design,
            // NOT collapse to length 1 (which would send back to home).
            const initialState: NavState = {
                stack: [createEntry('microservice:workspace')],
                index: 0,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('feature:workspace'),
            });
            expect(next.stack.length).toBe(2);
            expect(next.stack[0].graphId).toBe('microservice:workspace');
            expect(next.stack[1].graphId).toBe('feature:workspace');
            expect(next.index).toBe(1);
        });

        it('chained workspace-root navigation preserves the full back history', () => {
            // microservice:workspace → feature:workspace → map:workspace.
            // Each hop is between two workspace-roots; the reset must not
            // fire, so all three remain in the stack.
            const start: NavState = { stack: [], index: -1 };
            const s1 = navReducer(start, { type: 'push', entry: createEntry('microservice:workspace') });
            const s2 = navReducer(s1, { type: 'push', entry: createEntry('feature:workspace') });
            const s3 = navReducer(s2, { type: 'push', entry: createEntry('map:workspace') });
            expect(s3.stack.length).toBe(3);
            expect(s3.stack.map((e) => e.graphId)).toEqual([
                'microservice:workspace',
                'feature:workspace',
                'map:workspace',
            ]);
            expect(s3.index).toBe(2);
        });

        it('still collapses when transitioning from a DEEP entry to a workspace-root (BREAD-1 still holds)', () => {
            // The original BREAD-1 case: drilled into APIs › sequence › file,
            // user clicks System Design — that intentionally wipes the deep
            // chain since the user is restarting at the top of a layer. The
            // #784 fix must preserve this behavior.
            const initialState: NavState = {
                stack: [
                    createEntry('api-list:cluster:auth'),
                    createEntry('sequence:src/auth/auth.controller.ts:anonymous@POST:/users/login'),
                    createEntry('file:src/auth/auth.controller.ts'),
                ],
                index: 2,
            };
            const next = navReducer(initialState, {
                type: 'push',
                entry: createEntry('microservice:workspace'),
            });
            expect(next.stack.length).toBe(1);
            expect(next.stack[0].graphId).toBe('microservice:workspace');
            expect(next.index).toBe(0);
        });
    });
});
