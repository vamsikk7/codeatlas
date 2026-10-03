/**
 * daemonResilience.test.ts — BUG-EXP-20.
 *
 * The browser daemon must SURVIVE transient/environmental errors (fd
 * exhaustion, the Node autoSelectFamily net assertion) instead of crashing,
 * but must NOT mask genuine bugs. `isSurvivableDaemonError` is the classifier
 * the process-level handlers consult.
 */
import { describe, it, expect } from 'vitest';
import { isSurvivableDaemonError } from '../daemonResilience';

function assertionErr(stack: string) {
    const e: any = new Error('This is caused by either a bug in Node.js or incorrect usage of Node.js internals.');
    e.code = 'ERR_INTERNAL_ASSERTION';
    e.stack = stack;
    return e;
}

describe('BUG-EXP-20 — isSurvivableDaemonError', () => {
    it('survives fd/watch-limit errors (BUG-EXP-14)', () => {
        expect(isSurvivableDaemonError({ code: 'EMFILE', message: 'too many open files, watch' })).toBe(true);
        expect(isSurvivableDaemonError(new Error('ENFILE: file table overflow'))).toBe(true);
        expect(isSurvivableDaemonError({ code: 'ENOSPC' })).toBe(true);
    });

    it('survives the Node autoSelectFamily net internal assertion', () => {
        const e = assertionErr(
            'Error [ERR_INTERNAL_ASSERTION]: ...\n    at assert (node:internal/assert:14:11)\n' +
            '    at internalConnectMultiple (node:net:1106:3)\n' +
            '    at Timeout.internalConnectMultipleTimeout (node:net:1637:3)');
        expect(isSurvivableDaemonError(e)).toBe(true);
    });

    it('does NOT mask an unrelated internal assertion (real bug)', () => {
        const e = assertionErr(
            'Error [ERR_INTERNAL_ASSERTION]: ...\n    at assert (node:internal/assert:14:11)\n' +
            '    at SomeModule.doThing (node:internal/vm:99:1)');
        expect(isSurvivableDaemonError(e)).toBe(false);
    });

    it('does NOT swallow ordinary application errors', () => {
        expect(isSurvivableDaemonError(new TypeError('cannot read property x of undefined'))).toBe(false);
        expect(isSurvivableDaemonError(new Error('boom'))).toBe(false);
        expect(isSurvivableDaemonError(null)).toBe(false);
        expect(isSurvivableDaemonError(undefined)).toBe(false);
    });
});
