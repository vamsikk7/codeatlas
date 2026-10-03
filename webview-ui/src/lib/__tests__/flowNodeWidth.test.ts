import { describe, it, expect } from 'vitest';
import { estimateFlowNodeWidth, FLOW_NODE_MIN_WIDTH, FLOW_NODE_MAX_WIDTH } from '../flowNodeWidth';

describe('estimateFlowNodeWidth (BUG-POLAR-21 — L5 branch box overlap)', () => {
    it('never returns below the FlowNode minimum', () => {
        expect(estimateFlowNodeWidth('ok')).toBe(FLOW_NODE_MIN_WIDTH);
        expect(estimateFlowNodeWidth('')).toBe(FLOW_NODE_MIN_WIDTH);
        expect(estimateFlowNodeWidth(undefined)).toBe(FLOW_NODE_MIN_WIDTH);
    });

    it('caps at the FlowNode maximum for very long content', () => {
        expect(estimateFlowNodeWidth('x'.repeat(200))).toBe(FLOW_NODE_MAX_WIDTH);
    });

    it('grows with the longest line so wide boxes reserve more layout space', () => {
        const shortW = estimateFlowNodeWidth('log.info("x")');
        const wideW = estimateFlowNodeWidth('await customer_service.delete_payment_method(session, payment_method)');
        expect(wideW).toBeGreaterThan(shortW);
        expect(wideW).toBeLessThanOrEqual(FLOW_NODE_MAX_WIDTH);
    });

    it('uses the LONGEST line of multi-line text', () => {
        const multi = 'short\nthis is a considerably longer statement line here\nx';
        expect(estimateFlowNodeWidth(multi)).toBe(estimateFlowNodeWidth('this is a considerably longer statement line here'));
    });
});
