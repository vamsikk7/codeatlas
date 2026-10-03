/**
 * oauth2Handlers.ts — Issue #358 Row 1 (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * three OAuth2 router-handler blocks shipped under #745 (2026-06-06):
 *
 *   - oauth2ClientCredentials       → clientCredentialsGrant
 *   - oauth2BuildAuthorizationUrl   → buildAuthorizationUrl (+ optional PKCE)
 *   - oauth2ExchangeAuthorizationCode → authorizationCodeGrant
 *
 * Mechanical extraction — NO behavior change. Same router registration
 * shape, same reply-routing (`ws:`-prefixed panel ids go through
 * `wsBridge.sendTo`, otherwise through `panelManager.sendToPanel`),
 * same error-handling pattern.
 *
 * Wire by calling `registerOauth2Handlers(router, deps)` from
 * `extension.ts::activate`. The dependency bag avoids importing the
 * full HandlerContext shape — these handlers don't need the snapshot
 * store / aggregator / etc.; they only need the message-routing and
 * logging surfaces.
 */

import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';

/** Subset of the registry shape used by the router. */
export type MessageRouter = {
    register: (
        messageType: string,
        handler: (message: unknown, sourcePanelId: string) => void | Promise<void>,
        moduleTag: string,
    ) => void;
};

export interface Oauth2HandlerDeps {
    panelManager: PanelManager;
    wsBridge: WsBridge | undefined;
    outputChannel: OutputChannel;
}

const MODULE = 'ApiTestingHandlers';

export function registerOauth2Handlers(router: MessageRouter, deps: Oauth2HandlerDeps): void {
    const { panelManager, wsBridge, outputChannel } = deps;

    // #745 (2026-06-06) — OAuth2 client-credentials grant. Server-side
    // dispatch to the already-shipped `clientCredentialsGrant`. The
    // webview posts the tokenEndpoint + clientId + clientSecret (plus
    // optional scope / audience); we forward the OAuth result to the
    // matching `oauth2ClientCredentialsResult` message.
    router.register('oauth2ClientCredentials', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `cc-${Date.now()}`;
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { clientCredentialsGrant } = require('../core/apiTesting/oauth2');
            const result = await clientCredentialsGrant({
                tokenEndpoint: (message as any).tokenEndpoint,
                clientId: (message as any).clientId,
                clientSecret: (message as any).clientSecret,
                scope: (message as any).scope,
                audience: (message as any).audience,
            });
            if (result.ok) reply({ type: 'oauth2ClientCredentialsResult', requestId, token: result.token });
            else reply({ type: 'oauth2ClientCredentialsResult', requestId, error: `${result.error.error}${result.error.description ? ': ' + result.error.description : ''}` });
        } catch (err: any) {
            outputChannel.appendLine(`[oauth2ClientCredentials] failed: ${err?.message ?? err}`);
            reply({ type: 'oauth2ClientCredentialsResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #745 (2026-06-06) — OAuth2 authorization URL builder. Server-side
    // call so the PKCE pair (when requested) is generated with the
    // already-shipped `generatePkcePair` (SubtleCrypto / Node crypto).
    // Reply ships the URL + state + optional codeVerifier so the
    // webview can later supply it to the exchange call.
    router.register('oauth2BuildAuthorizationUrl', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `au-${Date.now()}`;
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildAuthorizationUrl, generatePkcePair } = require('../core/apiTesting/oauth2');
            let pkce: any;
            let codeVerifier: string | undefined;
            if ((message as any).usePkce) {
                const pair = await generatePkcePair();
                pkce = { codeChallenge: pair.codeChallenge, codeChallengeMethod: 'S256' };
                codeVerifier = pair.codeVerifier;
            }
            const built = buildAuthorizationUrl({
                authorizationEndpoint: (message as any).authorizationEndpoint,
                clientId: (message as any).clientId,
                redirectUri: (message as any).redirectUri,
                scope: (message as any).scope,
                pkce,
            });
            reply({ type: 'oauth2AuthorizeUrlResult', requestId, url: built.url, state: built.state, codeVerifier });
        } catch (err: any) {
            outputChannel.appendLine(`[oauth2BuildAuthorizationUrl] failed: ${err?.message ?? err}`);
            reply({ type: 'oauth2AuthorizeUrlResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #745 (2026-06-06) — OAuth2 authorization code exchange.
    router.register('oauth2ExchangeAuthorizationCode', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `ex-${Date.now()}`;
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { authorizationCodeGrant } = require('../core/apiTesting/oauth2');
            const result = await authorizationCodeGrant({
                tokenEndpoint: (message as any).tokenEndpoint,
                clientId: (message as any).clientId,
                clientSecret: (message as any).clientSecret,
                code: (message as any).code,
                redirectUri: (message as any).redirectUri,
                codeVerifier: (message as any).codeVerifier,
            });
            if (result.ok) reply({ type: 'oauth2ExchangeCodeResult', requestId, token: result.token });
            else reply({ type: 'oauth2ExchangeCodeResult', requestId, error: `${result.error.error}${result.error.description ? ': ' + result.error.description : ''}` });
        } catch (err: any) {
            outputChannel.appendLine(`[oauth2ExchangeAuthorizationCode] failed: ${err?.message ?? err}`);
            reply({ type: 'oauth2ExchangeCodeResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);
}
