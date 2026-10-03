/**
 * frameworks/grpc.ts — Cross-language gRPC plugin
 * (Issue #703, Phase 2 PR-17, gRPC half.)
 *
 * Three patterns produce `RPC` / `GRPC` records:
 *
 *   1. **Proto IDL** — `rpc MethodName(Request) returns (Response)`
 *      inside `.proto` files. Method = `RPC`, route = method name.
 *   2. **Node.js gRPC server registration** — `server.addService(
 *      proto.ServiceName.service, …)`. Method = `GRPC`, route = service.
 *   3. **Python gRPC server registration** — `add_XxxServicer_to_server`.
 *      Method = `GRPC`, route = servicer name.
 *
 * Suppression: ALL gRPC patterns carry `skipInComment: false`. Pre-#703
 * the dispatcher used `!grpcPatterns.has(pattern)` to OPT OUT of the
 * default "skip matches inside comments" behaviour — gRPC `.proto`
 * files contain `// ...` doc comments that frequently REFERENCE the
 * `rpc` declarations they document, and the parser needs to keep
 * matching those declarations even when they sit alongside comments.
 * Once `GRPC_PATTERNS` is empty, the Set check is no-op; the explicit
 * `skipInComment: false` flag is what preserves the behaviour.
 *
 * Languages: js, ts, go (the pre-#703 `FRAMEWORK_PATTERNS` table spread
 * `GRPC_PATTERNS` into js, ts, and go specifically — Python's gRPC
 * registration runs through the more general server-routing pass).
 */

import type { FrameworkPlugin } from './types';

export const grpcPlugin: FrameworkPlugin = {
    id: 'grpc',
    name: 'gRPC (proto + Node + Python registration)',
    languages: ['javascript', 'typescript', 'go', 'python'],
    patterns: [
        // Proto: rpc MethodName(Request) returns (Response)
        {
            callPattern: /\brpc\s+(\w+)\s*\(/gi,
            extract: (m) => ({ method: 'RPC', route: m[1] }),
            skipInComment: false,
        },
        // Node.js: server.addService(proto.ServiceName.service, { method: handler })
        {
            callPattern: /addService\s*\(\s*\w+\.(\w+)\.service/gi,
            extract: (m) => ({ method: 'GRPC', route: m[1], handlerName: m[1] }),
            skipInComment: false,
        },
        // Python: add_XxxServicer_to_server
        {
            callPattern: /add_(\w+)Servicer_to_server/gi,
            extract: (m) => ({ method: 'GRPC', route: m[1], handlerName: m[1] }),
            skipInComment: false,
        },
    ],
};
