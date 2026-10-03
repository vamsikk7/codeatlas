import { describe, it, expect } from 'vitest';
import { replayNoWorkingChangesMessage } from '../replayMessages';

describe('replayNoWorkingChangesMessage (BUG-POLAR-28 — multi-repo replay hint)', () => {
    it('directs the user to pick a repo on a bare multi-repo replay (empty workspace store)', () => {
        const msg = replayNoWorkingChangesMessage({ isMultiRepo: true, hasRepoScope: false });
        expect(msg).toMatch(/pick a repository/i);
        expect(msg).not.toMatch(/edit some files/i);
    });

    it('keeps the edit-files hint for a repo-scoped multi-repo replay', () => {
        expect(replayNoWorkingChangesMessage({ isMultiRepo: true, hasRepoScope: true }))
            .toMatch(/edit some files/i);
    });

    it('keeps the edit-files hint for a single-repo workspace', () => {
        expect(replayNoWorkingChangesMessage({ isMultiRepo: false, hasRepoScope: false }))
            .toMatch(/edit some files/i);
    });
});
