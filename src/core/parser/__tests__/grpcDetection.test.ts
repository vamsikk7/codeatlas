/**
 * grpcDetection.test.ts
 *
 * Issue 323: synthetic coverage for gRPC patterns (`rpc Foo(...) returns (...)`)
 * across .proto-style content embedded in JS/TS/Go. We don't ship a real
 * gRPC repo because the cost (protoc + service stubs + a minimal server) is
 * larger than the test value, but a synthetic input verifies the pattern fires.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

describe('gRPC detection (Issue 323)', () => {
    it('detects rpc methods in .proto-style JS/TS comments', () => {
        // gRPC services are usually defined in .proto files but the relevant
        // patterns also appear inline in TS service stubs.
        const code = `
/**
 * service UserService {
 *   rpc GetUser(GetUserRequest) returns (User) {}
 *   rpc ListUsers(ListUsersRequest) returns (stream User) {}
 *   rpc CreateUser(User) returns (User) {}
 * }
 */
export class UserServiceImpl {}
`;
        const apis = detectFrameworkApis(code, 'user-service.ts', 'typescript');
        const rpcMethods = apis.filter(a => /rpc/i.test(a.method) || a.method === 'RPC');
        expect(rpcMethods.length).toBeGreaterThanOrEqual(3);
    });

    it('detects rpc methods in Go .pb.go-style stubs', () => {
        const code = `
package user
// rpc GetUser(GetUserRequest) returns (User)
// rpc ListUsers(ListUsersRequest) returns (stream User)
type UserServiceServer interface {
    GetUser(ctx context.Context, req *GetUserRequest) (*User, error)
    ListUsers(req *ListUsersRequest, stream UserService_ListUsersServer) error
}
`;
        const apis = detectFrameworkApis(code, 'user_service.pb.go', 'go');
        // At least the rpc comments should fire the pattern
        expect(apis.length).toBeGreaterThan(0);
    });
});
