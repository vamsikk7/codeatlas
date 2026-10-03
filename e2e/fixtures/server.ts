/**
 * server.ts
 *
 * Playwright custom fixture that starts a real WsBridge server with mock handlers.
 * Each test worker gets its own server on a random port.
 */

import { test as base } from '@playwright/test';
import * as path from 'path';
import { WsBridge } from '../../src/server/wsBridge';
import { createMessageHandler } from './messageHandler';

type TestFixtures = {
    serverUrl: string;
};

export const test = base.extend<TestFixtures>({
    serverUrl: async ({}, use) => {
        const extensionPath = path.resolve(__dirname, '..', '..');

        // Resolve circular dependency: bridge needs handler, handler needs bridge.
        // The forwarding closure is assigned before any client connects.
        let messageHandler: (msg: any, clientId: string) => void = () => {};

        const bridge = new WsBridge({
            port: 49200 + Math.floor(Math.random() * 800),
            extensionPath,
            messageHandler: (msg: any, clientId: string) => messageHandler(msg, clientId),
            getInitialData: () => null,
            log: () => {},
        });

        messageHandler = createMessageHandler(bridge);

        const port = await bridge.start();
        const url = `http://localhost:${port}`;

        await use(url);

        bridge.stop();
    },
});

export { expect } from '@playwright/test';
