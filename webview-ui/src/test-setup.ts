/**
 * Vitest setup — silences React's "not wrapped in act(...)" warning so that
 * known-benign async toast/popover updates (e.g. `setTimeout(setToast, 2500)`
 * in `AiReviewFindingsPopover`) don't drown out genuine errors in test output.
 * Every other console.error still passes through.
 */
const REACT_ACT_PATTERN = /not wrapped in act\(\.\.\.\)/;

const originalError = console.error;
console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && REACT_ACT_PATTERN.test(first)) return;
    originalError(...(args as Parameters<typeof console.error>));
};
