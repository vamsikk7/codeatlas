/**
 * BUG-POLAR-28 (part b): a bare `replayWorkingDiff` (no repoId) on a MULTI-REPO
 * workspace sources the diff from the workspace snapshot store, which is empty
 * by design — so it ALWAYS reports "no working changes" even when a sub-repo has
 * edits. The old message ("Edit some files first.") is misleading there; direct
 * the user to pick a repository instead.
 */

export function replayNoWorkingChangesMessage(opts: {
    isMultiRepo: boolean;
    hasRepoScope: boolean;
}): string {
    if (opts.isMultiRepo && !opts.hasRepoScope) {
        return 'No workspace-level changes to replay. Pick a repository to replay its working changes.';
    }
    return 'No working changes to replay. Edit some files first.';
}
