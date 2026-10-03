import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LspFallbackResolver, offsetToLineCol, extractBaseType, extractTypeParams } from '../lspFallbackResolver';
import type { DefinitionProviderFn } from '../lspClient';
import type { FileRecord } from '../../graph/graphTypes';

function makeFileRecord(functions: string[], vars: string[] = []): FileRecord {
    return {
        content: '',
        symbols: {
            functions: functions.map((name) => ({ name, kind: 'function' as const, span: { start: 0, end: 0 }, bodyText: '' })),
            variables: vars.map((name) => ({ name, kind: 'variable' as const, exported: true })),
            imports: [],
        },
        lastModified: 0,
    } as FileRecord;
}

describe('LspFallbackResolver — snapshot scan (Tier 1)', () => {
    let resolver: LspFallbackResolver;

    beforeEach(() => {
        resolver = new LspFallbackResolver({ enabled: false });
    });

    afterEach(() => {
        resolver.dispose();
    });

    it('resolves a class name to the file that defines it', () => {
        const files: Record<string, FileRecord> = {
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
            'src/controllers/todoController.ts': makeFileRecord(['handleGet']),
        };
        const result = resolver.resolveFromSnapshot('TodoService', files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/services/todoService.ts');
        expect(result!.typeName).toBe('TodoService');
    });

    it('resolves case-insensitively', () => {
        const files: Record<string, FileRecord> = {
            'src/repo.ts': makeFileRecord(['TodoRepository']),
        };
        const result = resolver.resolveFromSnapshot('todorepository', files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/repo.ts');
    });

    it('resolves dotted names (e.g. ClassName.method → ClassName)', () => {
        const files: Record<string, FileRecord> = {
            'src/auth.ts': makeFileRecord(['AuthService.validate', 'AuthService.login']),
        };
        const result = resolver.resolveFromSnapshot('AuthService', files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/auth.ts');
        expect(result!.typeName).toBe('AuthService');
    });

    it('resolves via exported vars', () => {
        const files: Record<string, FileRecord> = {
            'src/config.ts': makeFileRecord([], ['AppConfig']),
        };
        const result = resolver.resolveFromSnapshot('AppConfig', files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/config.ts');
    });

    it('returns null when no match found', () => {
        const files: Record<string, FileRecord> = {
            'src/foo.ts': makeFileRecord(['Foo']),
        };
        const result = resolver.resolveFromSnapshot('BarService', files);
        expect(result).toBeNull();
    });
});

describe('LspFallbackResolver — LSP definition lookup (Tier 2)', () => {
    let resolver: LspFallbackResolver;
    let mockProvider: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        resolver = new LspFallbackResolver({ enabled: true, timeout: 500, idleShutdownMs: 100 });
        mockProvider = vi.fn();
        resolver.setDefinitionProvider(mockProvider as DefinitionProviderFn);
    });

    afterEach(() => {
        resolver.dispose();
    });

    it('returns null when LSP is disabled', async () => {
        resolver.updateOptions({ enabled: false });
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
        expect(mockProvider).not.toHaveBeenCalled();
    });

    it('returns null when no definition provider is set', async () => {
        const bare = new LspFallbackResolver({ enabled: true });
        const result = await bare.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
        bare.dispose();
    });

    it('calls the definition provider with correct arguments', async () => {
        mockProvider.mockResolvedValue([
            { filePath: 'src/services/todoService.ts', line: 5, column: 0 },
        ]);
        const files: Record<string, FileRecord> = {
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
        };
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, files);
        expect(mockProvider).toHaveBeenCalledWith('src/ctrl.ts', 10, 5);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/services/todoService.ts');
    });

    it('returns null when LSP returns empty locations', async () => {
        mockProvider.mockResolvedValue([]);
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
    });

    it('returns null when LSP returns null', async () => {
        mockProvider.mockResolvedValue(null);
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
    });

    it('times out if LSP takes too long', async () => {
        mockProvider.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve([{ filePath: 'x.ts', line: 0, column: 0 }]), 2000)),
        );
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
    });

    it('handles LSP errors gracefully (returns null, does not throw)', async () => {
        mockProvider.mockRejectedValue(new Error('LSP crashed'));
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
    });

    it('prefers snapshot-matched definition location', async () => {
        mockProvider.mockResolvedValue([
            { filePath: 'src/generated/types.ts', line: 100, column: 0 },
            { filePath: 'src/services/todoService.ts', line: 5, column: 0 },
        ]);
        const files: Record<string, FileRecord> = {
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
        };
        // First location not in snapshot, second is
        const result = await resolver.resolveViaLsp('todoService', 'src/ctrl.ts', 10, 5, files);
        expect(result!.filePath).toBe('src/services/todoService.ts');
    });
});

describe('LspFallbackResolver — combined resolution', () => {
    let resolver: LspFallbackResolver;
    let mockProvider: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        resolver = new LspFallbackResolver({ enabled: true, timeout: 500, idleShutdownMs: 100 });
        mockProvider = vi.fn();
        resolver.setDefinitionProvider(mockProvider as DefinitionProviderFn);
    });

    afterEach(() => {
        resolver.dispose();
    });

    it('uses snapshot scan first (LSP not called when snapshot resolves)', async () => {
        const files: Record<string, FileRecord> = {
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
        };
        const result = await resolver.resolveReceiverType('TodoService', 'src/ctrl.ts', 10, 5, files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/services/todoService.ts');
        expect(mockProvider).not.toHaveBeenCalled();
    });

    it('falls through to LSP when snapshot scan fails', async () => {
        mockProvider.mockResolvedValue([
            { filePath: 'src/services/todoService.ts', line: 5, column: 0 },
        ]);
        const files: Record<string, FileRecord> = {
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
        };
        // Receiver name doesn't match any function/var
        const result = await resolver.resolveReceiverType('todoSvc', 'src/ctrl.ts', 10, 5, files);
        expect(mockProvider).toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/services/todoService.ts');
    });

    it('returns null when both tiers fail', async () => {
        mockProvider.mockResolvedValue([]);
        const result = await resolver.resolveReceiverType('unknownService', 'src/ctrl.ts', 10, 5, {});
        expect(result).toBeNull();
    });
});

describe('LspFallbackResolver — idle shutdown', () => {
    it('clears idle timer on dispose', () => {
        const resolver = new LspFallbackResolver({ enabled: true, idleShutdownMs: 50 });
        resolver.setDefinitionProvider(vi.fn().mockResolvedValue(null) as DefinitionProviderFn);
        resolver.dispose();
        // Should not throw or leak
    });
});

describe('LspFallbackResolver — option toggles', () => {
    it('enabled getter reflects current state', () => {
        const resolver = new LspFallbackResolver({ enabled: false });
        expect(resolver.enabled).toBe(false);
        resolver.updateOptions({ enabled: true });
        expect(resolver.enabled).toBe(true);
        resolver.dispose();
    });
});

// ---------------------------------------------------------------------------
// offsetToLineCol
// ---------------------------------------------------------------------------

describe('offsetToLineCol', () => {
    it('converts offset 5 in "abc\\ndef\\n" to line 1, col 1', () => {
        const result = offsetToLineCol('abc\ndef\n', 5);
        expect(result).toEqual({ line: 1, col: 1 });
    });

    it('offset 0 returns line 0, col 0', () => {
        expect(offsetToLineCol('hello', 0)).toEqual({ line: 0, col: 0 });
    });

    it('offset at newline returns end of line', () => {
        // "abc\n" → offset 3 is 'c', offset 4 is '\n' (but we clamp before it triggers)
        expect(offsetToLineCol('abc\ndef', 3)).toEqual({ line: 0, col: 3 });
    });

    it('offset past end of string is clamped', () => {
        expect(offsetToLineCol('ab', 100)).toEqual({ line: 0, col: 2 });
    });

    it('empty content returns line 0, col 0', () => {
        expect(offsetToLineCol('', 5)).toEqual({ line: 0, col: 0 });
    });

    it('multiline file computes correct line:col', () => {
        const content = 'line0\nline1\nline2\n';
        // 'l' of line2 is at offset 12
        expect(offsetToLineCol(content, 12)).toEqual({ line: 2, col: 0 });
        // 'e' of line2 is at offset 16
        expect(offsetToLineCol(content, 16)).toEqual({ line: 2, col: 4 });
    });
});

// ---------------------------------------------------------------------------
// extractBaseType / extractTypeParams
// ---------------------------------------------------------------------------

describe('extractBaseType', () => {
    it('Repository<Todo> → Repository', () => {
        expect(extractBaseType('Repository<Todo>')).toBe('Repository');
    });

    it('plain type unchanged', () => {
        expect(extractBaseType('TodoService')).toBe('TodoService');
    });

    it('nested generics: Map<String, List<Int>> → Map', () => {
        expect(extractBaseType('Map<String, List<Int>>')).toBe('Map');
    });
});

describe('extractTypeParams', () => {
    it('Repository<Todo> → ["Todo"]', () => {
        expect(extractTypeParams('Repository<Todo>')).toEqual(['Todo']);
    });

    it('Map<String, Int> → ["String", "Int"]', () => {
        expect(extractTypeParams('Map<String, Int>')).toEqual(['String', 'Int']);
    });

    it('no generics → empty', () => {
        expect(extractTypeParams('TodoService')).toEqual([]);
    });

    it('nested: Map<String, List<Todo>> → ["String", "List<Todo>"]', () => {
        expect(extractTypeParams('Map<String, List<Todo>>')).toEqual(['String', 'List<Todo>']);
    });
});

// ---------------------------------------------------------------------------
// Re-export resolution
// ---------------------------------------------------------------------------

describe('LspFallbackResolver — re-export resolution', () => {
    let resolver: LspFallbackResolver;

    beforeEach(() => {
        resolver = new LspFallbackResolver({ enabled: false });
    });

    afterEach(() => {
        resolver.dispose();
    });

    it('resolves through index.ts re-export (1 hop)', () => {
        const files: Record<string, FileRecord> = {
            'src/services/index.ts': {
                content: '',
                symbols: {
                    functions: [],
                    variables: [],
                    imports: [
                        {
                            source: './todoService',
                            specifiers: [{ local: 'TodoService', imported: 'TodoService' }],
                            span: { start: 0, end: 0 },
                            stableKey: 'i1',
                        },
                    ],
                },
            } as unknown as FileRecord,
            'src/services/todoService.ts': makeFileRecord(['TodoService']),
        };
        const result = resolver.resolveFromSnapshot('TodoService', files);
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('src/services/todoService.ts');
    });

    it('does not follow re-exports deeper than 1 hop', () => {
        // index.ts re-exports from another index — we only follow 1 level
        const files: Record<string, FileRecord> = {
            'src/index.ts': {
                content: '',
                symbols: {
                    functions: [],
                    variables: [],
                    imports: [
                        {
                            source: './services',
                            specifiers: [{ local: 'DeepService', imported: 'DeepService' }],
                            span: { start: 0, end: 0 },
                            stableKey: 'i1',
                        },
                    ],
                },
            } as unknown as FileRecord,
            'src/services/index.ts': {
                content: '',
                symbols: {
                    functions: [],
                    variables: [],
                    imports: [
                        {
                            source: './deepService',
                            specifiers: [{ local: 'DeepService', imported: 'DeepService' }],
                            span: { start: 0, end: 0 },
                            stableKey: 'i2',
                        },
                    ],
                },
            } as unknown as FileRecord,
        };
        // Should NOT resolve since the chain is 2 hops and target file doesn't exist in snapshot
        const result = resolver.resolveFromSnapshot('DeepService', files);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Generic type resolution
// ---------------------------------------------------------------------------

describe('LspFallbackResolver — generic type resolution', () => {
    let resolver: LspFallbackResolver;

    beforeEach(() => {
        resolver = new LspFallbackResolver({ enabled: false });
    });

    afterEach(() => {
        resolver.dispose();
    });

    it('Repository<Todo> resolves to file containing Repository', () => {
        const files: Record<string, FileRecord> = {
            'src/repo.ts': makeFileRecord(['Repository']),
        };
        const result = resolver.resolveFromSnapshot('Repository<Todo>', files);
        expect(result).not.toBeNull();
        expect(result!.typeName).toBe('Repository');
    });

    it('generic type param resolved when base type not found', () => {
        const files: Record<string, FileRecord> = {
            'src/models/todo.ts': makeFileRecord(['Todo']),
        };
        // Repository not in snapshot, but Todo is → resolves to Todo
        const result = resolver.resolveFromSnapshot('Repository<Todo>', files);
        expect(result).not.toBeNull();
        expect(result!.typeName).toBe('Todo');
    });

    it('plain type still works (no generics)', () => {
        const files: Record<string, FileRecord> = {
            'src/svc.ts': makeFileRecord(['TodoService']),
        };
        const result = resolver.resolveFromSnapshot('TodoService', files);
        expect(result).not.toBeNull();
    });
});
