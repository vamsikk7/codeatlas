/**
 * messageRouter.ts
 *
 * Issue #174: Central message dispatcher that routes webview/WS messages
 * to focused handler modules instead of a 253-line switch statement.
 *
 * Each handler module registers its message types. The router dispatches
 * incoming messages to the correct handler with error wrapping (#194).
 */

import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';

type HandlerMap = Map<string, { handler: MessageHandler; module: string }>;

export interface MessageRouter {
    register: (messageType: string, handler: MessageHandler, module: string) => void;
    dispatch: (message: any, sourcePanelId: string) => void;
}

/**
 * Create a message router with a register function and dispatch function.
 * Call register() for each handler module, then use dispatch() as the message callback.
 */
export function createMessageRouter(ctx: HandlerContext): MessageRouter {
    const handlers: HandlerMap = new Map();

    function register(messageType: string, handler: MessageHandler, module: string): void {
        handlers.set(messageType, { handler, module });
    }

    function dispatch(message: any, sourcePanelId: string): void {
        const entry = handlers.get(message.type);
        if (!entry) {
            ctx.log(`[MessageRouter] Unknown message type: ${message.type}`);
            return;
        }

        // Issue #194: Wrap every handler in consistent error handling
        const result = entry.handler(message, sourcePanelId, ctx);
        if (result && typeof result.catch === 'function') {
            result.catch((err: any) => {
                const msg = err?.message ?? String(err);
                ctx.log(`[${entry.module}] Error handling '${message.type}': ${msg}`);
                ctx.notifyBrowser('error', `${entry.module}: ${msg.slice(0, 150)}`);
            });
        }
    }

    return { register, dispatch };
}
