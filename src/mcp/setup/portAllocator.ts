/**
 * portAllocator.ts — find a free TCP port for a workspace's daemon.
 *
 * Daemon design constraint: each workspace gets its own browser server
 * (`--browser` mode). Two repos can't share the same port, so we allocate
 * per-workspace starting at 7842 and walking up to 7942 (100 candidates —
 * comfortable headroom).
 *
 * Port base 7842 (NOT 7742): the VS Code extension's WS server uses 7742
 * by default. Running the MCP browser at 7742 would collide whenever the
 * user has both VS Code open AND an AI client (Claude Desktop, Cursor)
 * spawning the MCP — whichever bound the port second would fail or
 * silently steal traffic from the other. Splitting the spaces — VSIX on
 * 7742+, MCP on 7842+ — lets them coexist on the same machine without
 * either party knowing about the other.
 *
 * Allocation is recorded in the setup marker so subsequent reinstalls
 * (updates) reuse the same port — the user's bookmark stays stable.
 */

import * as net from 'net';

const DEFAULT_BASE_PORT = 7842;
const PORT_SCAN_RANGE = 100;

export interface PortAllocation {
    port: number;
    /** True when the requested preferredPort was available. */
    preferredAvailable: boolean;
}

/**
 * Allocate a free localhost TCP port. If `preferredPort` is free, use
 * that — keeps the URL stable on reinstalls. Otherwise scan upward.
 *
 * Synchronous-feel via a `await` chain — actual probes are quick.
 */
export async function allocatePort(
    preferredPort: number = DEFAULT_BASE_PORT,
): Promise<PortAllocation> {
    if (await isPortFree(preferredPort)) {
        return { port: preferredPort, preferredAvailable: true };
    }
    for (let i = 1; i <= PORT_SCAN_RANGE; i++) {
        const candidate = preferredPort + i;
        if (await isPortFree(candidate)) {
            return { port: candidate, preferredAvailable: false };
        }
    }
    throw new Error(
        `No free port found in [${preferredPort}, ${preferredPort + PORT_SCAN_RANGE}]. ` +
        `Either stop the conflicting server(s) or pass --port <N> manually.`,
    );
}

/**
 * True iff the given port can be bound on 127.0.0.1 right now. We bind +
 * close immediately — the brief listen doesn't matter because we're
 * about to launch the daemon on the same port.
 */
export function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, '127.0.0.1');
    });
}
