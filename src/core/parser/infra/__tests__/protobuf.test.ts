/**
 * protobuf.test.ts — Issue #705 Phase 2 Protocol Buffers parser.
 */

import { describe, it, expect } from 'vitest';
import { canParseProto, parseProto } from '../protobuf';

describe('canParseProto', () => {
    it('matches .proto files', () => {
        expect(canParseProto('protos/service.proto')).toBe(true);
        expect(canParseProto('chat.PROTO')).toBe(true);
    });
    it('rejects other files', () => {
        expect(canParseProto('package.json')).toBe(false);
        expect(canParseProto('README.md')).toBe(false);
    });
});

describe('parseProto', () => {
    it('returns no records when there is no service block', () => {
        const src = 'syntax = "proto3";\nmessage User { string id = 1; }\n';
        expect(parseProto('user.proto', src)).toEqual([]);
    });

    it('emits one service + one rpc per declaration', () => {
        const src = [
            'syntax = "proto3";',
            'package chat;',
            '',
            'service ChatService {',
            '  rpc SendMessage(SendRequest) returns (SendResponse);',
            '  rpc StreamMessages(StreamRequest) returns (stream MessageEvent);',
            '}',
        ].join('\n');
        const recs = parseProto('chat.proto', src);
        expect(recs).toHaveLength(3); // 1 service + 2 rpcs
        const svc = recs.find(r => r.kind === 'protobuf-service')!;
        expect(svc.name).toBe('ChatService');
        expect(svc.meta?.rpcCount).toBe(2);

        const send = recs.find(r => r.name === 'ChatService.SendMessage')!;
        expect(send.kind).toBe('protobuf-rpc');
        expect(send.meta?.request).toBe('SendRequest');
        expect(send.meta?.response).toBe('SendResponse');
        expect(send.meta?.streamRequest).toBe(false);
        expect(send.meta?.streamResponse).toBe(false);
        expect(send.dependencies).toContain(svc.id);

        const stream = recs.find(r => r.name === 'ChatService.StreamMessages')!;
        expect(stream.meta?.streamResponse).toBe(true);
    });

    it('honours client-stream rpcs', () => {
        const src = [
            'service Telemetry {',
            '  rpc Upload(stream Event) returns (UploadResponse);',
            '}',
        ].join('\n');
        const recs = parseProto('t.proto', src);
        const rpc = recs.find(r => r.kind === 'protobuf-rpc')!;
        expect(rpc.meta?.streamRequest).toBe(true);
        expect(rpc.meta?.streamResponse).toBe(false);
    });

    it('strips line + block comments before scanning', () => {
        const src = [
            '// service Hidden { rpc ShouldNotAppear(In) returns (Out); }',
            '/* service AlsoHidden {',
            '  rpc Nope(In) returns (Out);',
            '} */',
            'service Real {',
            '  rpc Method(In) returns (Out);',
            '}',
        ].join('\n');
        const recs = parseProto('s.proto', src);
        const svcs = recs.filter(r => r.kind === 'protobuf-service').map(r => r.name);
        expect(svcs).toEqual(['Real']);
    });

    it('handles multiple services in one file', () => {
        const src = [
            'service Auth { rpc Login(LoginRequest) returns (LoginResponse); }',
            'service Profile { rpc Get(GetRequest) returns (Profile); }',
        ].join('\n');
        const recs = parseProto('multi.proto', src);
        expect(recs.filter(r => r.kind === 'protobuf-service').map(r => r.name).sort()).toEqual(['Auth', 'Profile']);
    });
});
