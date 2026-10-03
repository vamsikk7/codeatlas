import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import HomePage from './HomePage';
import type { WorkspaceInfo } from '../App';

beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
});

afterEach(() => {
    delete (window as any).vscodeApi;
});

function makeWsInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
    return { name: 'test', fileCount: 0, apiCount: 0, serviceCount: 0, clusterCount: 0, initialized: false, isAuthenticated: true, hasGitRemote: false, gitHubConnected: false, ...overrides };
}

function sendWorkspaceInfo(info: Partial<WorkspaceInfo>) {
    act(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'workspaceInfo', ...makeWsInfo(info) },
        }));
    });
}

function sendInitProgress(progress: number, message = 'Scanning...') {
    act(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'initProgress', phase: 'scanning', progress, message },
        }));
    });
}

describe('HomePage', () => {
    // ── Rendering ──
    it('renders title "CodeAtlas"', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        expect(screen.getByText('CodeAtlas')).toBeDefined();
    });

    it('renders the "Get support" button with a mailto link (#544)', () => {
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, fileCount: 5 })} />);
        const link = screen.getByTestId('ca-home-support-btn') as HTMLAnchorElement;
        expect(link).toBeTruthy();
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toContain('mailto:vamsi.iiita+codeatlas@gmail.com');
        // Auto-populated body should include the workspace name and counts.
        const href = decodeURIComponent(link.getAttribute('href') ?? '');
        expect(href).toContain('CodeAtlas v');
        expect(href).toContain('files=5');
    });

    it('lays out AI surfaces in the right column (two-column grid) (#543)', () => {
        const { container } = render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true })} />);
        const grid = container.querySelector('.ca-home-grid') as HTMLElement;
        expect(grid).toBeTruthy();
        // The base layout is two-column on wide viewports; the CSS media query
        // collapses to one column under 1024px. Either way the grid wrapper exists.
        expect(grid.style.display).toBe('grid');
        // Right column hosts AI Review + Guidelines + (in browser mode) AI Config.
        const side = container.querySelector('.ca-home-grid-side');
        expect(side).toBeTruthy();
    });

    it('shows dashes for stats when no data', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: false })} />);
        const dashes = screen.getAllByText('—');
        // Stats row: 4 source counts (files / apis / services / features) + 3
        // diagram counts (file / function / sequence diagrams) = 7 total.
        expect(dashes.length).toBe(7);
    });

    it('shows actual stats when wsInfo prop provided', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ fileCount: 42, apiCount: 8, serviceCount: 2, clusterCount: 3, initialized: true })} />);
        expect(screen.getByText('42')).toBeDefined();
        expect(screen.getByText('8')).toBeDefined();
        expect(screen.getByText('2')).toBeDefined();
        expect(screen.getByText('3')).toBeDefined();
    });

    // ── #917 extraction confidence chip + GAP banner ──
    it('#917 — renders the confidence chip and GAP banner when a framework yields 0 routes', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({
            initialized: true, apiCount: 12,
            extractionConfidence: { totalEntryPoints: 12, frameworkCount: 3, gaps: [{ service: 'legacy', technology: 'rails' }] },
        })} />);
        const chip = screen.getByTestId('extraction-confidence-chip');
        expect(chip.textContent).toMatch(/12 entry points across 3 frameworks/);
        const banner = screen.getByTestId('extraction-gap-banner');
        expect(banner.textContent).toMatch(/0 routes/);
        expect(banner.textContent).toContain('legacy (rails)');
        expect(banner.textContent).toMatch(/detection gap/i);
    });

    it('#917 — no GAP banner when there are no gaps (chip still shows)', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({
            initialized: true, apiCount: 5,
            extractionConfidence: { totalEntryPoints: 5, frameworkCount: 1, gaps: [] },
        })} />);
        expect(screen.getByTestId('extraction-confidence-chip')).toBeDefined();
        expect(screen.queryByTestId('extraction-gap-banner')).toBeNull();
    });

    // ── Connection status ──
    it('shows connection status in browser mode', () => {
        render(<HomePage isBrowserMode={true} />);
        // Initially disconnected (WS hasn't connected yet), then updates on ws-status event
        act(() => { window.dispatchEvent(new CustomEvent('ws-status', { detail: 'connected' })); });
        expect(screen.getByText('Connected to CodeAtlas server')).toBeDefined();
    });

    it('shows disconnected state with reload button', () => {
        render(<HomePage isBrowserMode={true} />);
        act(() => { window.dispatchEvent(new CustomEvent('ws-status', { detail: 'disconnected' })); });
        expect(screen.getByText(/connection lost/i)).toBeDefined();
        expect(screen.getByText('Reload')).toBeDefined();
    });

    it('hides connection status in non-browser mode', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        expect(screen.queryByText('Connected to CodeAtlas server')).toBeNull();
    });

    // ── Command cards ──
    it('"System Design" card sends openMicroserviceDiagram', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('System Design'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'openMicroserviceDiagram' });
    });

    // (2026-07-21) "Feature Areas", "Compare Commits", and "PR Diff" home cards
    // were removed — Feature Areas is reached by drilling from L1; the static
    // Compare/Branch/PR diff cards are superseded by the Replay variants.

    it('"Health Report" card sends showHealthReport', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Health Report'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.showHealthReport' });
    });

    it('"Re-sync" card sends resyncEverything', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Re-sync'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.resyncEverything' });
    });

    it('"Impact Analysis" card sends analyzeImpact', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Impact Analysis'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.analyzeImpact' });
    });

    it('"Export Docs" card sends exportArchitectureDocs', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Export Docs'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.exportArchitectureDocs' });
    });

    // #912 — multi-repo: Impact + Export get the scope picker (Health-card
    // pattern). Single-repo keeps the workspace-wide runCommand (tested above).
    describe('#912 — multi-repo Impact + Export scope picker', () => {
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: '/ws/alpha' },
            { repoId: 'beta', name: 'beta', rootPath: '/ws/beta' },
        ];
        function sendExplorerData() {
            act(() => {
                window.dispatchEvent(new MessageEvent('message', { data: {
                    type: 'explorerData',
                    services: [
                        { id: 'service:alpha', label: 'alpha', repoId: 'alpha' },
                        { id: 'service:beta', label: 'beta', repoId: 'beta' },
                    ],
                    functions: [
                        { id: 'beta/b.ts:handler', label: 'handler', repoId: 'beta', action: { type: 'openFunctionFlow', filePath: 'beta/b.ts', functionName: 'handler' } },
                        { id: 'alpha/a.ts:foo', label: 'foo', repoId: 'alpha', action: { type: 'openFunctionFlow', filePath: 'alpha/a.ts', functionName: 'foo' } },
                    ],
                    features: [], apis: [],
                } }));
            });
        }
        const labelEls = () => screen.getAllByTestId('ca-scope-item-label');

        it('Export Docs opens the picker and posts requestArchitectureExport for the picked repo', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true })} repos={repos} />);
            sendExplorerData();
            fireEvent.click(screen.getByText('Export Docs'));
            expect(screen.getByTestId('ca-scope-picker')).toBeDefined();
            fireEvent.click(labelEls().find(el => el.textContent === 'beta')!);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'requestArchitectureExport', repoId: 'beta' });
        });

        it('Impact Analysis is two-step: pick repo → pick function → requestImpact scoped to that repo', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true })} repos={repos} />);
            sendExplorerData();
            fireEvent.click(screen.getByText('Impact Analysis'));
            // Step 1 — pick repo beta.
            fireEvent.click(labelEls().find(el => el.textContent === 'beta')!);
            // Step 2 — functions filtered to beta; alpha's `foo` must not appear.
            expect(labelEls().some(el => el.textContent === 'foo')).toBe(false);
            fireEvent.click(labelEls().find(el => el.textContent === 'handler')!);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'requestImpact', filePath: 'beta/b.ts', repoId: 'beta' });
        });
    });

    it('"Load Coverage" card sends loadCoverage', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Load Coverage'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.loadCoverage' });
    });

    it('does NOT render the Account section or sign-in/out cards (3.3.2: auth removed)', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        expect(screen.queryByText('Account')).toBeNull();
        expect(screen.queryByText('Sign In')).toBeNull();
        expect(screen.queryByText(/Sign Out/)).toBeNull();
    });

    it('"Search" card sends search', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Search'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.search' });
    });

    // ── Init progress ──
    it('"Re-initialize" card triggers init', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Re-initialize'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.initializeWorkspaceVisuals' });
    });

    it('shows init progress when initProgress message arrives', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        sendInitProgress(0.5, 'Scanning files...');
        expect(screen.getByText('Scanning files...')).toBeDefined();
        expect(screen.getByText('50%')).toBeDefined();
    });

    it('diagram cards disabled during initialization', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        sendInitProgress(0.1);
        const btn = screen.getByText('System Design').closest('button');
        expect(btn?.disabled).toBe(true);
    });

    // ── onNavigateDiagram ──
    it('calls onNavigateDiagram when System Design clicked', () => {
        const fn = vi.fn();
        render(<HomePage isBrowserMode={false} onNavigateDiagram={fn} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('System Design'));
        expect(fn).toHaveBeenCalled();
    });

    it('does not call onNavigateDiagram for non-diagram commands', () => {
        const fn = vi.fn();
        render(<HomePage isBrowserMode={false} onNavigateDiagram={fn} />);
        fireEvent.click(screen.getByText('Re-sync'));
        expect(fn).not.toHaveBeenCalled();
    });

    // ── Section headings ──
    it('renders all section headings (Account removed in 3.3.2)', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        expect(screen.getByText('Diagrams')).toBeDefined();
        expect(screen.getByText('Git & Diff')).toBeDefined();
        expect(screen.getByText('Tools')).toBeDefined();
        expect(screen.queryByText('Account')).toBeNull();
    });

    // ── Workspace name ──
    it('shows workspace name in subtitle when available', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ name: 'my-project', initialized: true })} />);
        expect(screen.getByText(/my-project/)).toBeDefined();
    });

    // ── Toast ──
    it('does not show "requested" toast on command execution', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        fireEvent.click(screen.getByText('Re-sync'));
        expect(screen.queryByText('Re-sync requested')).toBeNull();
    });

    // ── Reload button ──
    it('Reload Page button exists when disconnected', () => {
        const reloadMock = vi.fn();
        Object.defineProperty(window, 'location', { value: { reload: reloadMock }, writable: true });
        render(<HomePage isBrowserMode={true} />);
        act(() => { window.dispatchEvent(new CustomEvent('ws-status', { detail: 'disconnected' })); });
        fireEvent.click(screen.getByText('Reload'));
        expect(reloadMock).toHaveBeenCalled();
    });

    // ── LLM Config Section (browser mode only) ──
    it('shows AI / LLM section in browser mode with config details', () => {
        const onSetLlmConfig = vi.fn();
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ llmProvider: 'ollama', llmModel: 'llama3' })} onSetLlmConfig={onSetLlmConfig} />);
        expect(screen.getByText('AI Configuration')).toBeDefined();
        expect(screen.getByTestId('llm-status')).toBeDefined();
        expect(screen.getByText('Ollama (local)')).toBeDefined();
        expect(screen.getByText('llama3')).toBeDefined();
        // Table labels visible
        expect(screen.getByText('Provider')).toBeDefined();
        expect(screen.getByText('Model')).toBeDefined();
        expect(screen.getByText('API Key')).toBeDefined();
    });

    it('hides AI / LLM section in non-browser mode', () => {
        render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
        expect(screen.queryByText('AI Configuration')).toBeNull();
    });

    it('opens config form when Edit button clicked', () => {
        const onSetLlmConfig = vi.fn();
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ llmProvider: 'openrouter', llmModel: 'openrouter/free' })} onSetLlmConfig={onSetLlmConfig} />);
        fireEvent.click(screen.getByLabelText('Edit LLM configuration'));
        expect(screen.getByTestId('llm-config-form')).toBeDefined();
        expect(screen.getByLabelText('LLM provider')).toBeDefined();
    });

    it('saves config and calls onSetLlmConfig', () => {
        const onSetLlmConfig = vi.fn();
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ llmProvider: 'openrouter' })} onSetLlmConfig={onSetLlmConfig} />);
        fireEvent.click(screen.getByLabelText('Edit LLM configuration'));

        // Select ollama
        const select = screen.getByLabelText('LLM provider');
        fireEvent.change(select, { target: { value: 'ollama' } });

        // Set model
        const modelInput = screen.getByLabelText('Model name');
        fireEvent.change(modelInput, { target: { value: 'codellama' } });

        // Save
        fireEvent.click(screen.getByLabelText('Save LLM configuration'));
        expect(onSetLlmConfig).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'ollama',
            model: 'codellama',
            endpoint: 'http://localhost:11434/v1/chat/completions',
        }));
    });

    it('shows endpoint field only for ollama/custom providers', () => {
        const onSetLlmConfig = vi.fn();
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ llmProvider: 'openai' })} onSetLlmConfig={onSetLlmConfig} />);
        fireEvent.click(screen.getByLabelText('Edit LLM configuration'));

        // OpenAI — no endpoint field
        expect(screen.queryByLabelText('LLM endpoint URL')).toBeNull();

        // Switch to ollama — endpoint appears
        fireEvent.change(screen.getByLabelText('LLM provider'), { target: { value: 'ollama' } });
        expect(screen.getByLabelText('LLM endpoint URL')).toBeDefined();
    });

    it('cancel closes config form without saving', () => {
        const onSetLlmConfig = vi.fn();
        render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ llmProvider: 'openrouter' })} onSetLlmConfig={onSetLlmConfig} />);
        fireEvent.click(screen.getByLabelText('Edit LLM configuration'));
        expect(screen.getByTestId('llm-config-form')).toBeDefined();

        fireEvent.click(screen.getByLabelText('Cancel LLM configuration'));
        expect(screen.queryByTestId('llm-config-form')).toBeNull();
        expect(onSetLlmConfig).not.toHaveBeenCalled();
    });

    // Issue #145 — stats-card labels singularise at count=1.
    // Originally reported as "1 SERVICES" / "1 FEATURES" / "1 APIS" / "1 FILES".
    // The CSS uppercases the label via `text-transform: uppercase`, so the
    // count-aware switch in HomePage.tsx between 'Service' and 'Services'
    // (etc.) is the only place this can go wrong. Pin it.
    describe('stats-card pluralisation (#145)', () => {
        it('singular labels when count = 1', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 1, apiCount: 1, serviceCount: 1, clusterCount: 1,
            })} />);
            // Each "1 <Label>" should appear once — singular form.
            // The CSS uppercases these, so the DOM text is 'Service'/'API'/etc.
            // but with text-transform: uppercase — `textContent` keeps the case.
            expect(screen.getByText('File')).toBeTruthy();
            expect(screen.getByText('API')).toBeTruthy();
            expect(screen.getByText('Service')).toBeTruthy();
            expect(screen.getByText('Feature')).toBeTruthy();
        });

        it('plural labels when count ≠ 1', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 40, apiCount: 27, serviceCount: 4, clusterCount: 6,
            })} />);
            expect(screen.getByText('Files')).toBeTruthy();
            expect(screen.getByText('APIs')).toBeTruthy();
            expect(screen.getByText('Services')).toBeTruthy();
            expect(screen.getByText('Features')).toBeTruthy();
        });

        it('plural labels when count = 0 (zero is "many" for plural agreement)', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 0, apiCount: 0, serviceCount: 0, clusterCount: 0,
            })} />);
            expect(screen.getByText('Files')).toBeTruthy();
            expect(screen.getByText('APIs')).toBeTruthy();
            expect(screen.getByText('Services')).toBeTruthy();
            expect(screen.getByText('Features')).toBeTruthy();
        });

        it('mixed counts pick the right label per stat', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 1, apiCount: 27, serviceCount: 1, clusterCount: 6,
            })} />);
            expect(screen.getByText('File')).toBeTruthy();    // 1 → singular
            expect(screen.getByText('APIs')).toBeTruthy();    // 27 → plural
            expect(screen.getByText('Service')).toBeTruthy(); // 1 → singular
            expect(screen.getByText('Features')).toBeTruthy(); // 6 → plural
        });
    });

    // v2 phase 3 PR-F — `screenCount` stat chip visibility.
    //
    // Locks the rendering contract:
    //   - When `screenCount > 0` (FE / mobile workspace), the chip
    //     appears between Features and File-diagrams with singular
    //     "Screen" / plural "Screens" labels.
    //   - When `screenCount === 0 | undefined` (pure-backend workspace),
    //     the chip is HIDDEN entirely so the stats row doesn't
    //     advertise a feature the workspace doesn't use.
    describe('screen-count chip visibility (#484 PR-F)', () => {
        it('hides the Screens chip when screenCount is 0', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 40, apiCount: 27, serviceCount: 1, clusterCount: 6,
                screenCount: 0,
            })} />);
            expect(screen.queryByText('Screen')).toBeNull();
            expect(screen.queryByText('Screens')).toBeNull();
        });

        it('hides the Screens chip when screenCount is undefined (pre-v2 builds)', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 40, apiCount: 27, serviceCount: 1, clusterCount: 6,
            })} />);
            expect(screen.queryByText('Screen')).toBeNull();
            expect(screen.queryByText('Screens')).toBeNull();
        });

        it('shows the Screens chip with plural label when screenCount > 1', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 40, apiCount: 5, serviceCount: 1, clusterCount: 0,
                screenCount: 12,
            })} />);
            expect(screen.getByText('Screens')).toBeTruthy();
            expect(screen.getByText('12')).toBeTruthy();
        });

        it('shows the Screens chip with singular label when screenCount === 1', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({
                initialized: true,
                fileCount: 40, apiCount: 5, serviceCount: 1, clusterCount: 0,
                screenCount: 1,
            })} />);
            expect(screen.getByText('Screen')).toBeTruthy();
        });
    });

    // ── Two-step picker (2026-06-09) — multi-repo drill-in for L2b / L5 / L3 ──
    // User-reported (serverless-examples, 132 sub-repos): API List card opens a
    // picker with 203 workspace-wide clusters, Flow Chart shows 736 functions,
    // Sequence opens the API explorer search across the whole workspace. The
    // right flow is two steps: pick a repo first, then pick the entity within
    // that repo. After repo selection the second picker shows ONLY items whose
    // `repoId` matches the picked repo.
    describe('Two-step picker — apis / flow / sequence in multi-repo', () => {
        beforeEach(() => {
            try { localStorage.clear(); } catch { /* ignore */ }
            try { sessionStorage.clear(); } catch { /* ignore */ }
        });

        function sendMultiRepoExplorerData() {
            act(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: {
                        type: 'explorerData',
                        services: [
                            { id: 'service:api', label: 'api', subtitle: 'express', repoId: 'api', action: {} },
                            { id: 'service:web', label: 'web', subtitle: 'nextjs', repoId: 'web', action: {} },
                        ],
                        features: [
                            { id: 'cluster:api-auth', label: 'Auth', subtitle: 'api · 5 files', repoId: 'api', action: { type: 'openApiListForCluster', clusterId: 'cluster:api-auth' } },
                            { id: 'cluster:api-billing', label: 'Billing', subtitle: 'api · 3 files', repoId: 'api', action: { type: 'openApiListForCluster', clusterId: 'cluster:api-billing' } },
                            { id: 'cluster:web-home', label: 'Home', subtitle: 'web · 2 files', repoId: 'web', action: { type: 'openApiListForCluster', clusterId: 'cluster:web-home' } },
                        ],
                        apis: [],
                        files: [],
                        functions: [
                            { id: 'src/api/login.ts:doLogin', label: 'doLogin', subtitle: 'api/login.ts', repoId: 'api', action: { type: 'openFunctionFlow', filePath: 'src/api/login.ts', functionName: 'doLogin' } },
                            { id: 'src/api/charge.ts:charge', label: 'charge', subtitle: 'api/charge.ts', repoId: 'api', action: { type: 'openFunctionFlow', filePath: 'src/api/charge.ts', functionName: 'charge' } },
                            { id: 'src/web/home.tsx:Home', label: 'Home', subtitle: 'web/home.tsx', repoId: 'web', action: { type: 'openFunctionFlow', filePath: 'src/web/home.tsx', functionName: 'Home' } },
                        ],
                    },
                }));
            });
        }

        it('API List in multi-repo: step 1 shows repos, step 2 shows that repo\'s clusters only', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} repos={[{ repoId: 'api', name: 'api', rootPath: 'services/api' }, { repoId: 'web', name: 'web', rootPath: 'services/web' }]} />);
            sendMultiRepoExplorerData();

            // Step 1 — repo picker shows the 2 sub-repos.
            fireEvent.click(screen.getByText('API List'));
            expect(screen.getByTestId('ca-scope-picker')).toBeTruthy();
            const step1 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step1.length, 'step 1 must list every sub-repo').toBe(2);
            // Pick `api`.
            fireEvent.click(step1[0]);

            // Step 2 — picker re-renders with ONLY api's clusters.
            expect(screen.getByTestId('ca-scope-picker')).toBeTruthy();
            const step2 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step2.length, 'step 2 must filter clusters to picked repo').toBe(2);
            const step2Labels = step2.map(el => el.textContent ?? '');
            expect(step2Labels.some(l => l.includes('Auth'))).toBe(true);
            expect(step2Labels.some(l => l.includes('Billing'))).toBe(true);
            expect(step2Labels.some(l => l.includes('Home')), 'web\'s Home cluster must NOT appear').toBe(false);

            // Pick `Auth` — original action fires.
            fireEvent.click(step2[0]);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({
                type: 'openApiListForCluster',
                clusterId: 'cluster:api-auth',
            });
        });

        it('Flow Chart in multi-repo: step 1 shows repos, step 2 shows that repo\'s functions only', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} repos={[{ repoId: 'api', name: 'api', rootPath: 'services/api' }, { repoId: 'web', name: 'web', rootPath: 'services/web' }]} />);
            sendMultiRepoExplorerData();

            fireEvent.click(screen.getByText('Flow Chart'));
            const step1 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step1.length).toBe(2);
            fireEvent.click(step1[0]); // pick `api`

            const step2 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step2.length, 'step 2 must filter functions to picked repo (api has 2)').toBe(2);
            fireEvent.click(step2[0]); // pick `doLogin`
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({
                type: 'openFunctionFlow',
                filePath: 'src/api/login.ts',
                functionName: 'doLogin',
            });
        });

        it('Sequence in multi-repo: step 1 shows repos, step 2 shows that repo\'s APIs only', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} repos={[{ repoId: 'api', name: 'api', rootPath: 'services/api' }, { repoId: 'web', name: 'web', rootPath: 'services/web' }]} />);
            act(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: {
                        type: 'explorerData',
                        services: [
                            { id: 'service:api', label: 'api', subtitle: 'express', repoId: 'api', action: {} },
                            { id: 'service:web', label: 'web', subtitle: 'nextjs', repoId: 'web', action: {} },
                        ],
                        features: [],
                        apis: [
                            { id: 'POST:/login', label: 'POST /login', subtitle: 'doLogin', repoId: 'api', action: { type: 'openSequenceForApi', apiId: 'POST:/login' } },
                            { id: 'POST:/charge', label: 'POST /charge', subtitle: 'charge', repoId: 'api', action: { type: 'openSequenceForApi', apiId: 'POST:/charge' } },
                            { id: 'GET:/home', label: 'GET /home', subtitle: 'Home', repoId: 'web', action: { type: 'openSequenceForApi', apiId: 'GET:/home' } },
                        ],
                        files: [],
                        functions: [],
                    },
                }));
            });

            // Find the Sequence card button (button wrapping the title text).
            const seqCardButton = screen.getAllByText('Sequence').map(el => el.closest('button, [role=button]')).find(b => !!b);
            expect(seqCardButton, 'Sequence card button must exist').toBeTruthy();
            fireEvent.click(seqCardButton as HTMLElement);
            const step1 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step1.length).toBe(2);
            fireEvent.click(step1[0]); // pick `api`

            const step2 = screen.getAllByTestId('ca-scope-picker-item');
            expect(step2.length, 'step 2 must filter APIs to picked repo (api has 2)').toBe(2);
            fireEvent.click(step2[0]); // pick `POST /login`
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({
                type: 'openSequenceForApi',
                apiId: 'POST:/login',
            });
        });

        it('Single-repo workspace skips step 1 — same behaviour as before the two-step change', () => {
            // No `repos` prop means single-repo mode. The picker should show
            // entities directly (no repo gate).
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
            sendMultiRepoExplorerData();

            fireEvent.click(screen.getByText('API List'));
            const items = screen.getAllByTestId('ca-scope-picker-item');
            // All 3 clusters across all repos (no filter) — single-repo
            // behaviour preserved.
            expect(items.length).toBe(3);
        });
    });

    // ── Scope picker consistency (2026-06-09) ──
    // User-reported (serverless-examples, 132 sub-repos): "the repo
    // selector is not showing correctly across the diagrams resources,
    // consistently. it is showing up some time and not showing up
    // other times". Root cause was the UX-50h `localStorage` memo
    // shortcut — first click of a mode showed the picker, subsequent
    // clicks dispatched the memoized pick directly. The card UI
    // wasn't surfacing the memo, so users couldn't tell why behaviour
    // diverged across modes. The memo was Shift-clickable to bypass
    // but the escape hatch is invisible to users who don't read the
    // small-print description.
    //
    // The user wanted CONSISTENT behaviour: a card that says "Pick a
    // repo to see..." should reliably show the picker every time.
    // We removed the auto-dispatch shortcut. The picker now opens on
    // every click in multi-item slices. Fast access remains available
    // via URL hash deep-links (`#/system-design/<repo>` etc).
    describe('Scope picker consistency — picker always shows in multi-item slices', () => {
        beforeEach(() => {
            try { localStorage.clear(); } catch { /* ignore */ }
            try { sessionStorage.clear(); } catch { /* ignore */ }
        });

        function sendExplorerData(services: any[] = []) {
            act(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'explorerData', services, features: [], apis: [], files: [], functions: [] },
                }));
            });
        }

        it('picker shows on every click for a multi-item slice (no auto-dispatch shortcut)', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
            sendExplorerData([
                { id: 'svc:a', label: 'a', subtitle: 'express', action: { type: 'openFeatureForService', serviceId: 'svc:a' } },
                { id: 'svc:b', label: 'b', subtitle: 'nextjs', action: { type: 'openFeatureForService', serviceId: 'svc:b' } },
            ]);
            // First click — picker opens, pick the second item.
            // (2026-07-21) The Feature Areas card was removed; System Design
            // drives the same multi-repo services-slice picker.
            fireEvent.click(screen.getByText('System Design'));
            expect(screen.getByTestId('ca-scope-picker'), 'picker shows on first click').toBeTruthy();
            const items = screen.getAllByTestId('ca-scope-picker-item');
            fireEvent.click(items[1]);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'requestRoute', route: 'system-design', param: 'svc:b' });

            // Second click — picker MUST still open. Pre-fix the
            // memoized shortcut dispatched directly without showing
            // the picker, which felt inconsistent to users.
            (window as any).vscodeApi.postMessage.mockClear();
            fireEvent.click(screen.getByText('System Design'));
            expect(screen.getByTestId('ca-scope-picker'), 'picker shows on SECOND click too — consistency fix').toBeTruthy();
            // No message dispatched yet — user still has to pick.
            expect((window as any).vscodeApi.postMessage).not.toHaveBeenCalled();
        });

        it('does NOT write any localStorage memo on pick (the memo would cause the inconsistency)', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
            sendExplorerData([
                { id: 'svc:a', label: 'a', subtitle: 'express', action: { type: 'openFeatureForService', serviceId: 'svc:a' } },
                { id: 'svc:b', label: 'b', subtitle: 'nextjs', action: { type: 'openFeatureForService', serviceId: 'svc:b' } },
            ]);
            fireEvent.click(screen.getByText('System Design'));
            fireEvent.click(screen.getAllByTestId('ca-scope-picker-item')[0]);
            expect(localStorage.getItem('codeatlas:scopePicker:lastPick:system-design')).toBeNull();
        });

        it('single-item slice still auto-dispatches without a picker (no point asking)', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true })} />);
            sendExplorerData([
                { id: 'svc:only', label: 'only', subtitle: 'express', action: { type: 'openFeatureForService', serviceId: 'svc:only' } },
            ]);
            fireEvent.click(screen.getByText('System Design'));
            expect(screen.queryByTestId('ca-scope-picker')).toBeNull();
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'requestRoute', route: 'system-design', param: 'svc:only' });
        });
    });

    // UX-72 (2026-06-10) — multi-repo init banner. The failure path had
    // never been exercised: every live fixture initializes N/N clean, so
    // the "2 failed (hover for details)" rendering could silently rot.
    // Pin the SPA consumer at the unit layer.
    describe('multi-repo init banner (UX-72)', () => {
        const statsBase = { total: 132, ready: 132, parsing: 0, failed: 0, stale: 0, failures: [] as any[] };

        it('hidden when every sub-repo is ready', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} multiRepoInitStats={statsBase} />);
            expect(screen.queryByTestId('ca-multirepo-init-banner')).toBeNull();
        });

        it('renders "N failed" when failures exist (the never-live-verified path)', () => {
            const stats = {
                ...statsBase,
                ready: 130,
                failed: 2,
                failures: [
                    { repoId: 'a1', name: 'svc-broken', rootPath: 'svc-broken', errorMessage: 'parse error' },
                    { repoId: 'b2', name: 'svc-dead', rootPath: 'svc-dead', errorMessage: 'init timeout' },
                ],
            };
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} multiRepoInitStats={stats} />);
            const banner = screen.getByTestId('ca-multirepo-init-banner');
            expect(banner.textContent).toContain('130/132 ready');
            expect(banner.textContent).toContain('2 failed');
        });

        it('renders parsing progress while sub-repos are still indexing', () => {
            const stats = { ...statsBase, ready: 100, parsing: 32 };
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} multiRepoInitStats={stats} />);
            const banner = screen.getByTestId('ca-multirepo-init-banner');
            expect(banner.textContent).toContain('100/132 ready');
            expect(banner.textContent).toContain('32 parsing');
        });

        it('hidden for single-repo workspaces (total <= 1)', () => {
            const stats = { ...statsBase, total: 1, ready: 0, failed: 1, failures: [{ repoId: 'x', errorMessage: 'boom' }] };
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} multiRepoInitStats={stats} />);
            expect(screen.queryByTestId('ca-multirepo-init-banner')).toBeNull();
        });
    });

    // ── #827 — regression-scope banner + panel ──
    describe('regression-scope banner (#827)', () => {
        const emptyScope = {
            changedEntities: [], blastRadius: { direct: [], transitive: [], reviewRequired: [] },
            testsToRun: [], untestedBlastRadius: [], affectedApis: [], crossRepoConsumers: [],
            testCommand: null, coverageAvailable: false,
        };
        const changedScope = {
            ...emptyScope,
            changedEntities: [{ filePath: 'src/auth/auth.service.ts', changeKind: 'modified' }],
            blastRadius: {
                direct: [{ filePath: 'src/auth/auth.controller.ts', functionName: 'loginRoute' }],
                transitive: [], reviewRequired: [],
            },
            testsToRun: [{ testFile: 'src/auth/__tests__/auth.controller.test.ts', reason: 'covers-changed' }],
            untestedBlastRadius: [{ filePath: 'src/auth/auth.controller.ts', functionName: 'loginRoute' }],
            testCommand: 'npx vitest run src/auth/__tests__/auth.controller.test.ts',
        };

        function sendScope(scope: any) {
            act(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'regressionScopeData', scope, repo: null },
                }));
            });
        }

        it('requests the scope on mount', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            const calls = ((window as any).vscodeApi.postMessage as any).mock.calls.map((c: any[]) => c[0]?.type);
            expect(calls).toContain('requestRegressionScope');
        });

        it('re-requests the scope when a resync completes, so a stale banner clears', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            sendScope(changedScope);
            expect(screen.getByTestId('ca-regression-scope-banner')).toBeTruthy();
            // Resync finished (orchestrator emits initProgress phase:complete).
            const before = ((window as any).vscodeApi.postMessage as any).mock.calls.length;
            act(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'initProgress', phase: 'complete', progress: 1 },
                }));
            });
            const posted = ((window as any).vscodeApi.postMessage as any).mock.calls
                .slice(before).map((c: any[]) => c[0]?.type);
            expect(posted).toContain('requestRegressionScope');
            // Host replies with the now-empty scope (working === baseline) → banner clears.
            sendScope(emptyScope);
            expect(screen.queryByTestId('ca-regression-scope-banner')).toBeNull();
        });

        it('hidden when the scope is empty (working === baseline)', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            sendScope(emptyScope);
            expect(screen.queryByTestId('ca-regression-scope-banner')).toBeNull();
        });

        it('renders counts when changes exist and opens the panel on click', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            sendScope(changedScope);
            const banner = screen.getByTestId('ca-regression-scope-banner');
            expect(banner.textContent).toContain('1 changed');
            expect(banner.textContent).toContain('1 test file to run');
            expect(banner.textContent).toContain('1 untested in blast radius');

            fireEvent.click(banner);
            const panel = screen.getByTestId('ca-regression-scope-panel');
            expect(panel.textContent).toContain('auth.controller.test.ts');
            expect(panel.textContent).toContain('loginRoute');
            // Copy-command affordance present with the runner command.
            expect(screen.getByTestId('ca-regression-scope-command').textContent).toContain('npx vitest run');
            expect(screen.getByTestId('ca-regression-scope-copy')).toBeTruthy();
        });

        it('clicking a test row posts openSource for that file', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            sendScope(changedScope);
            fireEvent.click(screen.getByTestId('ca-regression-scope-banner'));
            fireEvent.click(screen.getByText('src/auth/__tests__/auth.controller.test.ts'));
            const calls = ((window as any).vscodeApi.postMessage as any).mock.calls.map((c: any[]) => c[0]);
            expect(calls.some((m: any) => m?.type === 'openSource' && m?.filePath === 'src/auth/__tests__/auth.controller.test.ts')).toBe(true);
        });

        it('panel close button hides the panel', () => {
            render(<HomePage isBrowserMode wsInfo={makeWsInfo({ initialized: true })} />);
            sendScope(changedScope);
            fireEvent.click(screen.getByTestId('ca-regression-scope-banner'));
            fireEvent.click(screen.getByTestId('ca-regression-scope-close'));
            expect(screen.queryByTestId('ca-regression-scope-panel')).toBeNull();
        });
    });

    // ── Auth chip (browser view) — sign in / user chip + sign out ──
    // Re-surfaced sign-in for the browser view (VSIX + MCP standalone). The chip
    // is browser-mode only; the editor panel shows no auth affordance.
    describe('auth chip (browser mode)', () => {
        it('shows the Sign in button when unauthenticated; click posts codeatlas.login', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: false })} />);
            const btn = screen.getByTestId('ca-home-signin-btn');
            expect(btn).toBeTruthy();
            expect(screen.queryByTestId('ca-home-user-chip')).toBeNull();
            expect(screen.queryByTestId('ca-home-signout-btn')).toBeNull();
            fireEvent.click(btn);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.login' });
        });

        it('shows the user chip + Sign out when authenticated; click posts codeatlas.logout', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: true, userFirstName: 'Ada', userEmail: 'ada@x.dev' })} />);
            const chip = screen.getByTestId('ca-home-user-chip');
            expect(chip.textContent).toContain('Ada');
            expect(screen.queryByTestId('ca-home-signin-btn')).toBeNull();
            const out = screen.getByTestId('ca-home-signout-btn');
            fireEvent.click(out);
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.logout' });
        });

        it('renders neither chip nor sign-in/out in non-browser (editor) mode', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: true, userFirstName: 'Ada' })} />);
            expect(screen.queryByTestId('ca-home-user-chip')).toBeNull();
            expect(screen.queryByTestId('ca-home-signin-btn')).toBeNull();
            expect(screen.queryByTestId('ca-home-signout-btn')).toBeNull();
        });

        // Sign-in and sign-out must be MUTUALLY EXCLUSIVE — never both at once
        // (a Sign out implies an active logged-in user).
        it('never shows Sign in AND Sign out together (signed out)', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: false })} />);
            expect(screen.queryByTestId('ca-home-signin-btn')).not.toBeNull();
            expect(screen.queryByTestId('ca-home-signout-btn')).toBeNull();
            expect(screen.queryByTestId('ca-home-user-chip')).toBeNull();
        });
        it('never shows Sign in AND Sign out together (signed in)', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: true, userFirstName: 'Ada' })} />);
            expect(screen.queryByTestId('ca-home-signout-btn')).not.toBeNull();
            expect(screen.queryByTestId('ca-home-user-chip')).not.toBeNull();
            expect(screen.queryByTestId('ca-home-signin-btn')).toBeNull();
        });

        // FIRST-PAINT FLICKER GUARD: before workspaceInfo arrives, auth is
        // UNKNOWN (wsInfo == null). We must show neither a chip nor a gate — the
        // old code treated unknown as signed-out and flashed "Sign in" + the
        // gate at a signed-in user for the duration of the WS handshake.
        it('auth UNKNOWN (no workspaceInfo yet): shows NO auth chip at all', () => {
            render(<HomePage isBrowserMode={true} wsInfo={undefined} />);
            expect(screen.queryByTestId('ca-home-signin-btn'), 'no Sign in flash').toBeNull();
            expect(screen.queryByTestId('ca-home-signout-btn')).toBeNull();
            expect(screen.queryByTestId('ca-home-user-chip')).toBeNull();
        });

        it('transitions unknown → signed-in on first workspaceInfo without a Sign in flash', () => {
            // Real data flow: App owns wsInfo and passes a new prop when
            // workspaceInfo lands. Unknown → signed-in must never pass through
            // a "Sign in" render.
            const { rerender } = render(<HomePage isBrowserMode={true} wsInfo={undefined} />);
            expect(screen.queryByTestId('ca-home-signin-btn')).toBeNull();
            rerender(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: true, userEmail: 'ada@x.dev' })} />);
            expect(screen.queryByTestId('ca-home-user-chip')).not.toBeNull();
            expect(screen.queryByTestId('ca-home-signin-btn')).toBeNull();
        });
    });

    // Auth GATE — signed-out browser users may only init / re-sync; diagram / git /
    // tool cards are disabled and a gate banner offers sign-in.
    describe('auth gate (browser mode)', () => {
        it('signed out: shows the gate banner (sign-in) + disables diagram cards', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: false })} />);
            expect(screen.getByTestId('ca-home-auth-gate')).toBeDefined();
            // The gate's Sign in button posts the login command.
            fireEvent.click(screen.getByTestId('ca-home-gate-signin'));
            expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'runCommand', command: 'codeatlas.login' });
            // A diagram card is disabled while signed out.
            expect((screen.getByText('System Design').closest('button') as HTMLButtonElement)?.disabled, 'diagram gated').toBe(true);
        });

        it('signed out: init / re-sync stay enabled (not gated)', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: false })} />);
            // Re-sync + Re-initialize live in the Tools section (Power persona shows all).
            const resync = screen.queryByText('Re-sync')?.closest('button') as HTMLButtonElement | undefined;
            if (resync) expect(resync.disabled, 'Re-sync allowed signed-out').toBeFalsy();
            const reinit = screen.queryByText('Re-initialize')?.closest('button') as HTMLButtonElement | undefined;
            if (reinit) expect(reinit.disabled, 'Re-initialize allowed signed-out').toBeFalsy();
        });

        it('signed in: no gate banner + diagram cards enabled', () => {
            render(<HomePage isBrowserMode={true} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: true })} />);
            expect(screen.queryByTestId('ca-home-auth-gate')).toBeNull();
            expect((screen.getByText('System Design').closest('button') as HTMLButtonElement)?.disabled).toBeFalsy();
        });

        it('non-browser (editor) mode: never gated even when signed out', () => {
            render(<HomePage isBrowserMode={false} wsInfo={makeWsInfo({ initialized: true, isAuthenticated: false })} />);
            expect(screen.queryByTestId('ca-home-auth-gate')).toBeNull();
        });

        // FIRST-PAINT FLICKER GUARD (gate side): before workspaceInfo arrives,
        // auth is unknown — the gate banner must NOT flash. It appears only once
        // we positively know the user is signed out.
        it('auth UNKNOWN (no workspaceInfo yet): NO gate banner flash', () => {
            render(<HomePage isBrowserMode={true} wsInfo={undefined} />);
            expect(screen.queryByTestId('ca-home-auth-gate')).toBeNull();
        });
    });
});
