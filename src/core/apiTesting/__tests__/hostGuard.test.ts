/**
 * hostGuard.test.ts — #887 SSRF guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertRequestAllowed } from '../hostGuard';

describe('#887 — assertRequestAllowed (SSRF guard)', () => {
    const prevAllow = process.env.CODEATLAS_APITEST_ALLOWED_HOSTS;
    afterEach(() => {
        if (prevAllow === undefined) delete process.env.CODEATLAS_APITEST_ALLOWED_HOSTS;
        else process.env.CODEATLAS_APITEST_ALLOWED_HOSTS = prevAllow;
    });

    it('ALWAYS rejects the cloud-metadata IP — even with allowPrivate', async () => {
        const r1 = await assertRequestAllowed('http://169.254.169.254/latest/meta-data/');
        expect(r1.ok).toBe(false);
        expect(r1.reason).toMatch(/metadata/i);
        // allowPrivate must NOT lift the metadata block
        const r2 = await assertRequestAllowed('http://169.254.169.254/', { allowPrivate: true });
        expect(r2.ok).toBe(false);
    });

    it('ALWAYS rejects the link-local range', async () => {
        const r = await assertRequestAllowed('http://169.254.10.5:8080/x', { allowPrivate: true });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/link-local/i);
    });

    it('rejects the Alibaba metadata IP', async () => {
        const r = await assertRequestAllowed('http://100.100.100.200/');
        expect(r.ok).toBe(false);
    });

    it('rejects loopback + RFC-1918 private by default (MCP path)', async () => {
        for (const u of ['http://127.0.0.1:3000/', 'http://10.0.0.5/', 'http://192.168.1.10/', 'http://172.16.4.2/']) {
            const r = await assertRequestAllowed(u);
            expect(r.ok, u).toBe(false);
        }
    });

    it('allows loopback + private when allowPrivate (workbench path)', async () => {
        for (const u of ['http://127.0.0.1:3000/', 'http://192.168.1.10/', 'http://10.0.0.5/api']) {
            const r = await assertRequestAllowed(u, { allowPrivate: true });
            expect(r.ok, u).toBe(true);
        }
    });

    it('allows a public IP regardless of allowPrivate', async () => {
        const r = await assertRequestAllowed('http://93.184.216.34/');
        expect(r.ok).toBe(true);
    });

    it('allowlist lifts a private host (host:port) but NOT metadata', async () => {
        process.env.CODEATLAS_APITEST_ALLOWED_HOSTS = '127.0.0.1:3000, 10.0.0.5';
        expect((await assertRequestAllowed('http://127.0.0.1:3000/x')).ok).toBe(true);
        expect((await assertRequestAllowed('http://10.0.0.5/y')).ok).toBe(true);
        // a non-allowlisted private host is still blocked
        expect((await assertRequestAllowed('http://192.168.0.9/')).ok).toBe(false);
        // metadata is never lifted by the allowlist
        process.env.CODEATLAS_APITEST_ALLOWED_HOSTS = '169.254.169.254';
        expect((await assertRequestAllowed('http://169.254.169.254/')).ok).toBe(false);
    });

    it('handles ws:// and wss:// URLs (WebSocket guard)', async () => {
        expect((await assertRequestAllowed('ws://169.254.169.254/socket')).ok).toBe(false);
        expect((await assertRequestAllowed('ws://93.184.216.34/socket')).ok).toBe(true);
    });

    it('classifies IPv4-mapped IPv6 metadata (::ffff:169.254.169.254)', async () => {
        const r = await assertRequestAllowed('http://[::ffff:169.254.169.254]/', { allowPrivate: true });
        expect(r.ok).toBe(false);
    });

    it('rejects IPv6 loopback ::1 by default, allows with allowPrivate', async () => {
        expect((await assertRequestAllowed('http://[::1]:3000/')).ok).toBe(false);
        expect((await assertRequestAllowed('http://[::1]:3000/', { allowPrivate: true })).ok).toBe(true);
    });

    it('leaves an unparseable URL to the transport (ok:true)', async () => {
        expect((await assertRequestAllowed('not a url')).ok).toBe(true);
    });
});
