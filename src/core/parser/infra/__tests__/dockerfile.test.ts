/**
 * dockerfile.test.ts — Issue #705 Phase 1.
 */

import { describe, it, expect } from 'vitest';
import { canParseDockerfile, parseDockerfile } from '../dockerfile';

describe('canParseDockerfile', () => {
    it('matches bare Dockerfile + path variants + suffix variants', () => {
        expect(canParseDockerfile('Dockerfile')).toBe(true);
        expect(canParseDockerfile('apps/web/Dockerfile')).toBe(true);
        expect(canParseDockerfile('Dockerfile.prod')).toBe(true);
        expect(canParseDockerfile('apps/web/Dockerfile.dev')).toBe(true);
        expect(canParseDockerfile('apps/web/web.dockerfile')).toBe(true);
    });

    it('rejects unrelated files', () => {
        expect(canParseDockerfile('docker-compose.yml')).toBe(false);
        expect(canParseDockerfile('package.json')).toBe(false);
        expect(canParseDockerfile('README.md')).toBe(false);
    });
});

describe('parseDockerfile', () => {
    it('returns no records for an empty file', () => {
        expect(parseDockerfile('Dockerfile', '')).toEqual([]);
    });

    it('returns no records when there is no FROM line', () => {
        expect(parseDockerfile('Dockerfile', '# just a comment\nLABEL foo=bar\n')).toEqual([]);
    });

    it('extracts a single-stage Dockerfile', () => {
        const src = 'FROM node:20-alpine\nWORKDIR /app\nCMD ["node", "index.js"]\n';
        const records = parseDockerfile('Dockerfile', src);
        expect(records).toHaveLength(1);
        expect(records[0].kind).toBe('docker-stage');
        expect(records[0].name).toBe('node');
        expect(records[0].meta?.image).toBe('node:20-alpine');
        expect(records[0].meta?.isFinalStage).toBe(true);
    });

    it('extracts a multi-stage Dockerfile with AS labels', () => {
        const src = [
            'FROM node:20 AS builder',
            'WORKDIR /app',
            'COPY . .',
            'RUN npm run build',
            '',
            'FROM nginx:alpine AS runtime',
            'COPY --from=builder /app/dist /usr/share/nginx/html',
            'EXPOSE 80',
        ].join('\n');
        const records = parseDockerfile('Dockerfile', src);
        expect(records).toHaveLength(2);
        expect(records.map(r => r.name)).toEqual(['builder', 'runtime']);
        expect(records[0].meta?.isFinalStage).toBe(false);
        expect(records[1].meta?.isFinalStage).toBe(true);
        // The runtime stage depends on the builder stage via COPY --from.
        expect(records[1].dependencies).toEqual([`infra:docker-stage:Dockerfile::builder`]);
    });

    it('resolves numeric COPY --from references back to stage names', () => {
        const src = [
            'FROM golang:1.22 AS s0',
            'RUN go build -o /out/app',
            'FROM alpine:3.20 AS s1',
            'COPY --from=0 /out/app /usr/local/bin/app',
        ].join('\n');
        const records = parseDockerfile('Dockerfile', src);
        expect(records).toHaveLength(2);
        expect(records[1].dependencies).toEqual([`infra:docker-stage:Dockerfile::s0`]);
    });

    it('captures the --platform qualifier', () => {
        const records = parseDockerfile(
            'Dockerfile',
            'FROM --platform=linux/amd64 nginx:alpine AS web\n',
        );
        expect(records[0].meta?.platform).toBe('linux/amd64');
        expect(records[0].meta?.image).toBe('nginx:alpine');
    });

    it('falls back to a synthetic stage name when no AS clause exists', () => {
        const records = parseDockerfile(
            'Dockerfile',
            'FROM redis:7.2\nFROM postgres:16\n',
        );
        expect(records.map(r => r.name)).toEqual(['redis', 'postgres']);
    });
});
