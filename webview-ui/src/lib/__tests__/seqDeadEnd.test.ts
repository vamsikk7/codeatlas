import { describe, it, expect } from 'vitest';
import {
    participantHasNoTarget,
    edgeHasNoTarget,
    participantDeadEndMessage,
    MESSAGE_DEAD_END_EDGE,
} from '../seqDeadEnd';

describe('seqDeadEnd — participantHasNoTarget', () => {
    it('no anchor → dead-end', () => {
        expect(participantHasNoTarget(undefined)).toBe(true);
        expect(participantHasNoTarget(null)).toBe(true);
    });
    it('anchor without filePath → dead-end (external/unresolved lane)', () => {
        expect(participantHasNoTarget({ symbol: 'foo' })).toBe(true);
        expect(participantHasNoTarget({ filePath: '' })).toBe(true);
    });
    it('anchor with filePath → drillable (not a dead-end)', () => {
        expect(participantHasNoTarget({ filePath: 'src/x.ts' })).toBe(false);
    });
});

describe('seqDeadEnd — edgeHasNoTarget', () => {
    it('undefined edge → not our concern (false)', () => {
        expect(edgeHasNoTarget(undefined)).toBe(false);
    });
    it('edge anchor with filePath (Priority 1) → has target', () => {
        expect(edgeHasNoTarget({ anchor: { filePath: 'src/x.ts', symbol: 'go' } })).toBe(false);
    });
    it('target participant symbol+filePath (Priority 2) → has target', () => {
        expect(edgeHasNoTarget({ targetParticipant: { anchor: { symbol: 'go', filePath: 'src/x.ts' } } })).toBe(false);
    });
    it('target participant filePath only (Priority 3) → has target', () => {
        expect(edgeHasNoTarget({ targetParticipant: { anchor: { filePath: 'src/x.ts' } } })).toBe(false);
    });
    it('filePath-less edge anchor (Priority 4, host-handled) → not a silent dead-end', () => {
        expect(edgeHasNoTarget({ anchor: { symbol: 'go' } })).toBe(false);
    });
    it('no anchor and no resolvable target participant → genuine dead-end', () => {
        expect(edgeHasNoTarget({ targetParticipant: { anchor: {} } })).toBe(true);
        expect(edgeHasNoTarget({ targetParticipant: {} })).toBe(true);
        expect(edgeHasNoTarget({})).toBe(true);
    });
});

describe('seqDeadEnd — messages', () => {
    it('participant message names the label when present', () => {
        expect(participantDeadEndMessage('PostgreSQL')).toContain('"PostgreSQL"');
        expect(participantDeadEndMessage('PostgreSQL')).toMatch(/no deeper view/i);
    });
    it('participant message falls back gracefully with no/blank label', () => {
        expect(participantDeadEndMessage(undefined)).toContain('this participant');
        expect(participantDeadEndMessage('   ')).toContain('this participant');
    });
    it('edge message is a stable, non-empty string', () => {
        expect(MESSAGE_DEAD_END_EDGE).toMatch(/no source location/i);
    });
});
