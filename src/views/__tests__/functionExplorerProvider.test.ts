import { describe, it, expect, vi } from 'vitest';
import { FunctionExplorerProvider } from '../functionExplorerProvider';
import type { FileRecord } from '../../core/graph/graphTypes';

// Mock vscode API dependencies
vi.mock('vscode', () => {
    return {
        EventEmitter: class {
            event = vi.fn();
            fire = vi.fn();
        },
        TreeItem: class {
            constructor(public label: string | any, public collapsibleState?: number) { }
        },
        TreeItemCollapsibleState: {
            None: 0,
            Collapsed: 1,
            Expanded: 2
        },
        ThemeIcon: class {
            constructor(public id: string, public color?: any) { }
        },
        ThemeColor: class {
            constructor(public id: string) { }
        },
    };
});

describe('FunctionExplorerProvider Differential Logic', () => {
    it('scopes deleted functions strictly to their specific source file and does not leak cross-file', () => {
        const provider = new FunctionExplorerProvider();

        // Simulate a baseline where db.js has a 'connect' function, and otherFile.js has a 'deleteMe' function
        const baseline: FileRecord[] = [
            {
                path: '/src/db.js',
                content: '',
                hash: '1',
                symbols: {
                    functions: [
                        { name: 'connect', stableKey: 'function:connect', signature: 'connect()', kind: 'function', bodyText: '{}' }
                    ] as any,
                    variables: [],
                    imports: []
                }
            } as any,
            {
                path: '/src/otherFile.js',
                content: '',
                hash: '1',
                symbols: {
                    functions: [
                        { name: 'deleteMe', stableKey: 'function:deleteMe', signature: 'deleteMe()', kind: 'function', bodyText: '{}' }
                    ] as any,
                    variables: [],
                    imports: []
                }
            } as any
        ];

        // Simulate a working state where otherFile.js no longer has 'deleteMe'
        const working: FileRecord[] = [
            {
                path: '/src/db.js',
                content: '',
                hash: '1',
                symbols: {
                    functions: [
                        { name: 'connect', stableKey: 'function:connect', signature: 'connect()', kind: 'function', bodyText: '{}' }
                    ] as any,
                    variables: [],
                    imports: []
                }
            } as any,
            {
                path: '/src/otherFile.js',
                content: '',
                hash: '2',
                symbols: {
                    functions: [], // 'deleteMe' is deleted
                    variables: [],
                    imports: []
                }
            } as any
        ];

        provider.setData(baseline, working);

        // Get file-level items (roots)
        const fileNodes = provider.getChildren();

        // db.js
        const dbJsNode = fileNodes.find((n: any) => n.tooltip === '/src/db.js');
        expect(dbJsNode).toBeDefined();

        // Get functions under db.js
        const dbJsFunctions = provider.getChildren(dbJsNode);

        // Before the fix, 'deleteMe' would bleed over to db.js as a ghost (since it iterates across all baselineKeys)
        // With the fix, it scopes cleanly. 'db.js' should only have 'connect()'.
        expect(dbJsFunctions.length).toBe(1);
        expect(dbJsFunctions[0].label).toBe('connect');
    });
});
