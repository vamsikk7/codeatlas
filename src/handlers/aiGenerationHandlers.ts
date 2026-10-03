/**
 * aiGenerationHandlers.ts — Issue #358 Row 3 (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * three LLM-driven generator router-handler blocks shipped under #744
 * (2026-06-05/06):
 *
 *   - generateRequestBody  → evidence-gated body shape generator
 *   - generateChain        → request-chain composer
 *   - generateTestCases    → assertion-set generator per endpoint
 *
 * Mechanical extraction — NO behavior change. Same router registration
 * shape, same reply-routing convention (`ws:`-prefixed panel ids go
 * through `wsBridge.sendTo`, others through `panelManager.sendToPanel`),
 * same error-handling pattern, same secrets / config plumbing.
 *
 * Wire by calling `registerAiGenerationHandlers(router, deps)` from
 * `extension.ts::activate`. The dependency bag exposes only what these
 * handlers actually need: a way to read snapshots, a way to read the
 * stored API key, the VS Code workspace configuration accessor, plus the
 * routing surfaces (panelManager + wsBridge + outputChannel).
 */

import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { MessageRouter } from './oauth2Handlers';

export interface AiGenerationHandlerDeps {
    panelManager: PanelManager;
    wsBridge: WsBridge | undefined;
    outputChannel: OutputChannel;
    snapshotStore: SnapshotStore;
    /** Reads the stored OpenRouter API key from `context.secrets`. */
    getApiKey: () => Promise<string>;
}

const MODULE = 'ApiTestingHandlers';

interface ResolvedLlmConfig {
    apiKey: string;
    model: string;
    timeoutMs: number;
    provider: string;
    endpoint: string;
}

async function resolveLlmConfig(getApiKey: () => Promise<string>): Promise<{
    config: ResolvedLlmConfig | null;
    error?: string;
}> {
    const freshCfg = vscode.workspace.getConfiguration('codeatlas');
    const provider = freshCfg.get<string>('llmProvider') ?? 'openrouter';
    const keyOptional = provider === 'ollama' || provider === 'custom';
    const storedKey = (await getApiKey()) ?? '';
    if (!storedKey && !keyOptional) {
        return { config: null, error: 'No API key configured. Run "CodeAtlas: Set LLM API Key" or switch to Ollama.' };
    }
    const isLocal = provider === 'ollama' || provider === 'custom';
    return {
        config: {
            apiKey: storedKey,
            model: freshCfg.get<string>('llmModel') ?? 'openrouter/free',
            timeoutMs: isLocal ? 120_000 : 30_000,
            provider,
            endpoint: freshCfg.get<string>('llmEndpoint') ?? '',
        },
    };
}

export function registerAiGenerationHandlers(router: MessageRouter, deps: AiGenerationHandlerDeps): void {
    const { panelManager, wsBridge, outputChannel, snapshotStore, getApiKey } = deps;

    const replyFor = (sourcePanelId: string) => (payload: any): void => {
        if (sourcePanelId.startsWith('ws:') && wsBridge) {
            wsBridge.sendTo(sourcePanelId.slice(3), payload);
        } else {
            panelManager.sendToPanel(sourcePanelId, payload);
        }
    };

    // #744 (2026-06-05) — LLM-driven request-body generator. Webview
    // posts `generateRequestBody` with an apiId; we resolve the
    // endpoint + handler source via the snapshot store, call the
    // already-shipped evidence-gated generator, and reply on the same
    // socket with `generateRequestBodyResult`.
    router.register('generateRequestBody', async (message, sourcePanelId) => {
        const apiId = (message as any).apiId as string;
        const requestId = ((message as any).requestId as string | undefined) ?? `gen-body-${Date.now()}`;
        const reply = replyFor(sourcePanelId);
        try {
            const snap = snapshotStore.getWorking();
            const api = snap?.apiIndex?.[apiId];
            if (!api) {
                reply({ type: 'generateRequestBodyResult', requestId, apiId, error: `Endpoint ${apiId} not found.` });
                return;
            }
            const handlerSource = snapshotStore.getFileContent('working', api.filePath) ?? '';
            if (!handlerSource) {
                reply({ type: 'generateRequestBodyResult', requestId, apiId, error: `Handler source not available for ${api.filePath}.` });
                return;
            }
            const { config: llmConfig, error: cfgError } = await resolveLlmConfig(getApiKey);
            if (!llmConfig) {
                reply({ type: 'generateRequestBodyResult', requestId, apiId, error: cfgError ?? 'No LLM config available.' });
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { generateRequestBody } = require('../core/apiTesting/aiTestGen/generateRequestBody');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { toEndpoint } = require('../core/apiTesting/buildFromApiRecord');
            const result = await generateRequestBody({ endpoint: toEndpoint(api), handlerSource }, llmConfig);
            reply({ type: 'generateRequestBodyResult', requestId, apiId, result });
        } catch (err: any) {
            outputChannel.appendLine(`[generateRequestBody] failed: ${err?.message ?? err}`);
            reply({ type: 'generateRequestBodyResult', requestId, apiId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #744 (2026-06-06) — LLM-driven chain composer. Mirrors the
    // generateRequestBody handler: webview posts the collection's
    // endpoints (or asks us to resolve them from the snapshot) + an
    // optional intent string; we dispatch the evidence-gated generator
    // and reply with `generateChainResult`.
    router.register('generateChain', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `gen-chain-${Date.now()}`;
        const intent = (message as any).intent as string | undefined;
        const maxSteps = (message as any).maxSteps as number | undefined;
        const reply = replyFor(sourcePanelId);
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildApiTestingPayload } = require('../core/apiTesting/buildFromApiRecord');
            const payload = buildApiTestingPayload(snapshotStore.getWorking());
            const endpoints = (payload?.collections ?? []).flatMap((c: any) => c.endpoints ?? []);
            if (endpoints.length === 0) {
                reply({ type: 'generateChainResult', requestId, error: 'No endpoints available to compose a chain from.' });
                return;
            }
            const { config: llmConfig, error: cfgError } = await resolveLlmConfig(getApiKey);
            if (!llmConfig) {
                reply({ type: 'generateChainResult', requestId, error: cfgError ?? 'No LLM config available.' });
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { generateChain } = require('../core/apiTesting/aiTestGen/generateChain');
            const result = await generateChain({ endpoints, intent, maxSteps }, llmConfig);
            reply({ type: 'generateChainResult', requestId, result });
        } catch (err: any) {
            outputChannel.appendLine(`[generateChain] failed: ${err?.message ?? err}`);
            reply({ type: 'generateChainResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #744 (2026-06-06) — LLM-driven test-case generator. Webview posts
    // an apiId; we resolve the endpoint + handler source from the
    // snapshot, run the evidence-gated generator, and reply with
    // `generateTestCasesResult`.
    router.register('generateTestCases', async (message, sourcePanelId) => {
        const apiId = (message as any).apiId as string;
        const requestId = ((message as any).requestId as string | undefined) ?? `gen-tests-${Date.now()}`;
        const maxCases = (message as any).maxCases as number | undefined;
        const reply = replyFor(sourcePanelId);
        try {
            const snap = snapshotStore.getWorking();
            const api = snap?.apiIndex?.[apiId];
            if (!api) {
                reply({ type: 'generateTestCasesResult', requestId, apiId, error: `Endpoint ${apiId} not found.` });
                return;
            }
            const handlerSource = snapshotStore.getFileContent('working', api.filePath) ?? '';
            if (!handlerSource) {
                reply({ type: 'generateTestCasesResult', requestId, apiId, error: `Handler source not available for ${api.filePath}.` });
                return;
            }
            const { config: llmConfig, error: cfgError } = await resolveLlmConfig(getApiKey);
            if (!llmConfig) {
                reply({ type: 'generateTestCasesResult', requestId, apiId, error: cfgError ?? 'No LLM config available.' });
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { generateTestCases } = require('../core/apiTesting/aiTestGen/generateTestCases');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { toEndpoint } = require('../core/apiTesting/buildFromApiRecord');
            const result = await generateTestCases({ endpoint: toEndpoint(api), handlerSource, maxCases }, llmConfig);
            reply({ type: 'generateTestCasesResult', requestId, apiId, result });
        } catch (err: any) {
            outputChannel.appendLine(`[generateTestCases] failed: ${err?.message ?? err}`);
            reply({ type: 'generateTestCasesResult', requestId, apiId, error: err?.message ?? String(err) });
        }
    }, MODULE);
}
