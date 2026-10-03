/**
 * hostGuard.ts — #887 SSRF guard for the API-testing request paths.
 *
 * `run_api_chain` / `stream_sse` / `connect_websocket` are MCP tools — an
 * autonomous (or prompt-injected) agent can invoke them with an arbitrary
 * absolute URL. Without a host filter, the agent can drive the server at the
 * cloud metadata endpoint (`http://169.254.169.254/…`) or an internal RFC-1918
 * service and return the body — classic server-side request forgery.
 *
 * Policy (two tiers):
 *   • ALWAYS blocked, no override — cloud-metadata IPs + the link-local range.
 *     These are never a legitimate API-test target; they are exactly the SSRF
 *     exfiltration vectors. Not lifted by `allowPrivate` or the allowlist.
 *   • Blocked unless `allowPrivate` (or an allowlist match) — loopback, RFC-1918
 *     private, unique-local IPv6, CGNAT, and other reserved ranges. The
 *     interactive workbench Send/chain paths (user typed the URL + clicked) pass
 *     `allowPrivate: true` so localhost dev keeps working; the MCP tool paths
 *     leave it false (secure default). `CODEATLAS_APITEST_ALLOWED_HOSTS` (comma
 *     list of `host` or `host:port`) is a per-host opt-in for MCP-driven local
 *     testing.
 *
 * Hostnames (not IP literals) are resolved via DNS and every resolved address
 * is re-checked, so a name that resolves to the metadata IP (DNS-rebinding)
 * is still rejected.
 */
import { lookup } from 'dns';
import { isIP } from 'net';

export interface HostGuardOptions {
    /**
     * Allow loopback + private/reserved hosts (NOT metadata/link-local, which
     * are always blocked). True for the user-initiated workbench paths; false
     * (default) for the agent-invokable MCP tools.
     */
    allowPrivate?: boolean;
}

export interface HostGuardResult {
    ok: boolean;
    /** Human-readable rejection reason (only when `ok === false`). */
    reason?: string;
}

/** Canonical cloud-metadata endpoints — never a legitimate API-test target. */
const METADATA_IPS = new Set<string>([
    '169.254.169.254', // AWS / GCP / Azure / DigitalOcean / Oracle IMDS
    '100.100.100.200', // Alibaba Cloud metadata
    'fd00:ec2::254',   // AWS IPv6 IMDS
]);

type IpClass = 'metadata' | 'linklocal' | 'loopback' | 'private' | 'public';

/** Parse a dotted-quad into four octets, or null if malformed. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return nums as [number, number, number, number];
}

function classifyIpv4(ip: string): IpClass {
    if (METADATA_IPS.has(ip)) return 'metadata';
    const o = ipv4Octets(ip);
    if (!o) return 'public';
    const [a, b] = o;
    if (a === 169 && b === 254) return 'linklocal';     // 169.254.0.0/16
    if (a === 127) return 'loopback';                   // 127.0.0.0/8
    if (a === 10) return 'private';                     // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    if (a === 192 && b === 168) return 'private';       // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 CGNAT
    if (a === 0) return 'private';                      // 0.0.0.0/8 "this host"
    if (a === 192 && b === 0) return 'private';         // 192.0.0.0/24 IETF protocol
    return 'public';
}

function classifyIpv6(raw: string): IpClass {
    const ip = raw.toLowerCase().replace(/^\[|\]$/g, '');
    // IPv4-mapped / -embedded (::ffff:a.b.c.d, ::a.b.c.d) → classify the v4 part.
    const v4 = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4 && (ip.startsWith('::ffff:') || ip === `::${v4[1]}`)) return classifyIpv4(v4[1]);
    // IPv4-mapped in HEX form (the URL parser normalizes ::ffff:169.254.169.254
    // → ::ffff:a9fe:a9fe) → decode the trailing two hextets into a dotted quad.
    const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16);
        const lo = parseInt(hexMapped[2], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return classifyIpv4(dotted);
    }
    if (METADATA_IPS.has(ip)) return 'metadata';
    if (ip === '::1') return 'loopback';
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return 'linklocal'; // fe80::/10
    if (ip.startsWith('fc') || ip.startsWith('fd')) return 'private'; // fc00::/7 unique-local
    if (ip === '::') return 'private';
    return 'public';
}

function classifyIp(ip: string): IpClass {
    const v = isIP(ip);
    if (v === 4) return classifyIpv4(ip);
    if (v === 6) return classifyIpv6(ip);
    return 'public';
}

/** Hosts (host or host:port) the operator has explicitly allowlisted for MCP. */
function allowlistedHosts(): Set<string> {
    const raw = (process.env.CODEATLAS_APITEST_ALLOWED_HOSTS ?? '').trim();
    if (!raw) return new Set();
    return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Decide a single classified address against the policy. */
function verdictFor(cls: IpClass, allowPrivate: boolean): HostGuardResult {
    if (cls === 'metadata') return { ok: false, reason: 'blocked: cloud metadata endpoint' };
    if (cls === 'linklocal') return { ok: false, reason: 'blocked: link-local address' };
    if (cls === 'loopback' || cls === 'private') {
        if (allowPrivate) return { ok: true };
        return { ok: false, reason: `blocked: ${cls} address (SSRF guard) — set CODEATLAS_APITEST_ALLOWED_HOSTS to allow` };
    }
    return { ok: true };
}

const DNS_TIMEOUT_MS = 2_000;

function lookupAll(hostname: string): Promise<{ address: string }[]> {
    // Bounded — a slow/hanging resolver must never pin the request. On timeout
    // we resolve to [] (caller treats an empty/failed resolution as "can't
    // classify → allow"; the transport's own timeout then governs the fetch).
    return new Promise((resolve) => {
        let settled = false;
        const done = (v: { address: string }[]) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => done([]), DNS_TIMEOUT_MS);
        if (typeof (timer as any).unref === 'function') (timer as any).unref();
        lookup(hostname, { all: true }, (err, addresses) => {
            clearTimeout(timer);
            done(err ? [] : (addresses as { address: string }[]));
        });
    });
}

/**
 * Validate a request URL against the SSRF policy. Resolves to `{ ok: true }`
 * when the request may proceed, or `{ ok: false, reason }` when it must be
 * refused. Never throws — DNS / parse failures fall through to `ok` (the
 * underlying fetch/connect will fail naturally) EXCEPT when a resolved
 * address lands in a blocked range.
 */
export async function assertRequestAllowed(url: string, opts: HostGuardOptions = {}): Promise<HostGuardResult> {
    const allowPrivate = opts.allowPrivate === true;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: true }; // unparseable — leave it to the transport to reject
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const hostKey = parsed.host.toLowerCase();          // host:port
    const allow = allowlistedHosts();
    const allowlisted = allow.has(hostKey) || allow.has(hostname.toLowerCase());

    // Literal IP — classify directly.
    if (isIP(hostname)) {
        const cls = classifyIp(hostname);
        // Allowlist can lift loopback/private, never metadata/link-local.
        if (allowlisted && (cls === 'loopback' || cls === 'private')) return { ok: true };
        return verdictFor(cls, allowPrivate);
    }

    // `localhost` / `*.localhost` are defined to be loopback (RFC 6761) — treat
    // as loopback without a DNS round-trip (perf + can't be rebound).
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
        if (allowlisted) return { ok: true };
        return verdictFor('loopback', allowPrivate);
    }

    // Hostname — resolve and check every address (closes DNS-rebinding). An
    // empty result (resolution failed or timed out) falls through to ok:true —
    // the transport's own timeout governs the fetch.
    const addresses = await lookupAll(hostname);
    for (const { address } of addresses) {
        const cls = classifyIp(address);
        if (cls === 'metadata' || cls === 'linklocal') return verdictFor(cls, allowPrivate);
        if ((cls === 'loopback' || cls === 'private') && !allowlisted) {
            const v = verdictFor(cls, allowPrivate);
            if (!v.ok) return v;
        }
    }
    return { ok: true };
}
