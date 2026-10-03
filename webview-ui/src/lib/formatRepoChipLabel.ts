/**
 * formatRepoChipLabel.ts — UX-19 (2026-06-03 v2)
 *
 * Multi-repo L1 service nodes carry `meta.repoId` (a 16-char content
 * hash) plus `meta.rootPath` (the on-disk relative path). The repo chip
 * on a service card used to render the raw repoId text -
 * `dc2ef130f90896f2` - which is meaningless to the user.
 *
 * This helper picks the friendliest text we have:
 *   1. `repoName` if the L1 builder passed one (skeletal L1 does)
 *   2. `rootPath` (the slug a human reads in the file tree)
 *   3. Short repoId prefix (first 6 chars + `…`) as a last resort
 *
 * Full repoId is always surfaced in the chip's tooltip so power users
 * can still copy it for log greps / debugging.
 */

export interface RepoChipMeta {
    repoId?: string | null;
    repoName?: string | null;
    rootPath?: string | null;
}

export function formatRepoChipLabel(meta: RepoChipMeta | null | undefined): string {
    if (!meta) return '';
    const name = (meta.repoName ?? '').trim();
    if (name) return name;
    const root = (meta.rootPath ?? '').trim();
    if (root) return root;
    const id = (meta.repoId ?? '').trim();
    if (!id) return '';
    // Only abbreviate when the id is a hex-ish hash longer than ~8 chars.
    // For shorter human-typed ids (`api`, `web`) leave them alone.
    if (id.length > 8) return `${id.slice(0, 6)}…`;
    return id;
}

export function formatRepoChipTooltip(meta: RepoChipMeta | null | undefined): string {
    if (!meta) return '';
    const id = meta.repoId ?? '';
    const root = meta.rootPath ?? '';
    if (id && root) return `Owning repo: ${root} (${id})`;
    if (id) return `Owning repo: ${id}`;
    if (root) return `Owning repo: ${root}`;
    return 'Owning repo';
}
