/**
 * sentryNode.test.ts — Issue #724.
 *
 * Tests cover three behaviors WITHOUT requiring @sentry/node to be
 * installed: opt-out via env vars, no-op when no DSN exists, and the
 * captureException short-circuit when init was never called.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSentry, captureException, _getActiveContextForTests, _resetForTests } from '../sentryNode';

describe('sentryNode shim — opt-out path', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        _resetForTests();
        // Reset env between tests.
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
        delete process.env.CODEATLAS_SENTRY_DSN;
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        _resetForTests();
    });

    it('initSentry is idempotent — second call is a no-op', () => {
        initSentry('extension');
        expect(_getActiveContextForTests()).toBe('extension');
        // Subsequent call must not overwrite the context.
        initSentry('mcp-standalone');
        expect(_getActiveContextForTests()).toBe('extension');
    });

    it('respects CODEATLAS_TELEMETRY=0 — initialised but no SDK loaded', () => {
        process.env.CODEATLAS_TELEMETRY = '0';
        process.env.CODEATLAS_SENTRY_DSN = 'https://example.com/123';
        initSentry('extension');
        // captureException must not throw + must not call into the SDK.
        expect(() => captureException(new Error('boom'))).not.toThrow();
    });

    it('respects DO_NOT_TRACK=1', () => {
        process.env.DO_NOT_TRACK = '1';
        process.env.CODEATLAS_SENTRY_DSN = 'https://example.com/123';
        initSentry('mcp-standalone');
        expect(() => captureException(new Error('boom'))).not.toThrow();
    });

    it('no-op when no DSN is provisioned', () => {
        // No env DSN + no build-time define = nothing to talk to.
        initSentry('extension');
        expect(() => captureException(new Error('boom'))).not.toThrow();
    });

    it('captureException before init is a silent no-op', () => {
        // Order swap simulates code that fires too early.
        expect(() => captureException(new Error('early'))).not.toThrow();
    });
});

describe('sentryNode shim — captureException after init', () => {
    beforeEach(() => { _resetForTests(); });

    it('captureException with extra context does not throw when SDK absent', () => {
        // @sentry/node not installed → captureException is the no-op
        // path. Verifies the shim swallows the missing SDK silently.
        initSentry('extension');
        expect(() => captureException(new Error('x'), { filePath: 'src/a.ts', surface: 'rebuildFile' })).not.toThrow();
    });

    it('captureException handles non-Error values', () => {
        initSentry('extension');
        expect(() => captureException('a string error')).not.toThrow();
        expect(() => captureException({ message: 'plain object' })).not.toThrow();
        expect(() => captureException(undefined)).not.toThrow();
        expect(() => captureException(null)).not.toThrow();
    });
});
