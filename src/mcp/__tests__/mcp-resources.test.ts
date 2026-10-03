import { describe, it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { registerMcpResources } from '../mcp-resources';
import { Snapshot } from '../../core/graph/graphTypes';

describe('MCP Resources', () => {
    it('should register resources and list them correctly', async () => {
        const mockServer = {
            setRequestHandler: vi.fn(),
        } as unknown as Server;

        const mockStore = {
            getWorking: vi.fn(),
        } as unknown as SnapshotStore;

        registerMcpResources(mockServer, mockStore);

        // Check if both list and read handlers were registered
        // The first argument to setRequestHandler is the schema object
        expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);

        // Extract the list handler (first call, second arg)
        const listHandler = (mockServer.setRequestHandler as any).mock.calls[0][1];

        const response = await listHandler({});
        const uris = response.resources.map((r: any) => r.uri);
        // Originals + #508 AI-review resources.
        expect(uris).toEqual(expect.arrayContaining([
            'codeatlas://workspace/microservices',
            'codeatlas://workspace/apis',
            'codeatlas://workspace/features',
            'codeatlas://workspace/entrypoints',
            'codeatlas://workspace/diff-summary',
            'codeatlas://workspace/ai-findings',
            'codeatlas://workspace/review-guidelines',
            'codeatlas://workspace/review-summary',
        ]));
    });

    it('should read the microservices resource correctly', async () => {
        const mockServer = {
            setRequestHandler: vi.fn(),
        } as unknown as Server;

        const mockSnapshot: Partial<Snapshot> = {
            services: {
                'service:auth': {
                    id: 'service:auth',
                    name: 'auth',
                    rootPath: '/apps/auth',
                    technology: 'nestjs',
                    exposedApiCount: 5,
                    consumedUrls: [],
                    consumedServices: ['service:db'],
                }
            }
        };

        const mockStore = {
            getWorking: vi.fn().mockReturnValue(mockSnapshot),
        } as unknown as SnapshotStore;

        registerMcpResources(mockServer, mockStore);

        // Extract the read handler (second call, second arg)
        const readHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];

        const response = await readHandler({ params: { uri: 'codeatlas://workspace/microservices' } });

        expect(response.contents).toHaveLength(1);
        expect(response.contents[0].uri).toBe('codeatlas://workspace/microservices');
        expect(response.contents[0].mimeType).toBe('application/json');

        const data = JSON.parse(response.contents[0].text);
        expect(data).toHaveLength(1);
        expect(data[0].id).toBe('service:auth');
        expect(data[0].technology).toBe('nestjs');
    });

    it('should read the feature clusters resource correctly', async () => {
        const mockServer = {
            setRequestHandler: vi.fn(),
        } as unknown as Server;

        const mockSnapshot: Partial<Snapshot> = {
            clusters: {
                'cluster:payments': {
                    id: 'cluster:payments',
                    label: 'payments',
                    files: ['/src/pay.ts', '/src/stripe.ts'],
                    entryPoints: [],
                    internalCallCount: 10,
                    externalCallCount: 2,
                }
            }
        };

        const mockStore = {
            getWorking: vi.fn().mockReturnValue(mockSnapshot),
        } as unknown as SnapshotStore;

        registerMcpResources(mockServer, mockStore);

        const readHandler = (mockServer.setRequestHandler as any).mock.calls[1][1];
        const response = await readHandler({ params: { uri: 'codeatlas://workspace/features' } });

        const data = JSON.parse(response.contents[0].text);
        expect(data).toHaveLength(1);
        expect(data[0].concept).toBe('payments');
        expect(data[0].files).toEqual(['/src/pay.ts', '/src/stripe.ts']);
    });
});
