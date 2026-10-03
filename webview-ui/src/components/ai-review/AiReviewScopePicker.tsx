/**
 * AiReviewScopePicker.tsx — ADR-034 Phase G Pass 3 (#792).
 *
 * Self-contained picker for narrowing an AI-review run. Exposes the three
 * flat scope variants the host already understands (`all` / `changed` /
 * `entry`) plus an optional `repos` slot. When the parent passes a non-
 * empty `repos` list, the picker also surfaces per-repo and workspace-meta
 * options — enabling multi-repo workspaces to scope reviews to a single
 * repo without ripping out the existing flat-scope handler surface.
 *
 * Today (single-repo): no caller populates `repos`, so only flat scopes
 * render. The workspace-mode broadcast that would populate this list is
 * tracked separately in ISSUES.md.
 */

import React, { useState, useCallback, memo } from 'react';
import type { CSSProperties } from 'react';

export type FlatScopeKind = 'all' | 'changed' | 'entry';

export interface ReviewRepoOption {
    repoId: string;
    name: string;
    /** `true` when the repo currently has changes vs baseline. */
    hasChanges?: boolean;
}

/**
 * The picker emits one of three shapes to the parent:
 *  - flat:   `{ kind: 'all' | 'changed' | 'entry' }`
 *  - repo:   `{ kind: 'repo', repoId }` — caller maps to per-repo review
 *  - workspace: `{ kind: 'workspace' }` — caller fans out via planWorkspaceReview
 */
export type PickedScope =
    | { kind: 'all' }
    | { kind: 'changed' }
    | { kind: 'entry' }
    | { kind: 'repo'; repoId: string }
    | { kind: 'workspace' };

export interface AiReviewScopePickerProps {
    /** Called when the user clicks "Start review". */
    onPick: (scope: PickedScope) => void;
    /** Cancel / close the picker without emitting. */
    onCancel?: () => void;
    /** Multi-repo workspace surface — leave empty for single-repo (default). */
    repos?: ReadonlyArray<ReviewRepoOption>;
    /** Pre-select a scope when opening; defaults to 'all'. */
    initialScope?: PickedScope;
}

function AiReviewScopePicker({ onPick, onCancel, repos, initialScope }: AiReviewScopePickerProps) {
    const isMulti = (repos?.length ?? 0) > 0;
    const [scope, setScope] = useState<PickedScope>(initialScope ?? { kind: 'all' });

    const handleStart = useCallback(() => onPick(scope), [onPick, scope]);

    return (
        <div role="dialog" aria-label="Review scope picker" style={containerStyle}>
            <div style={headerStyle}>
                <span style={titleStyle}>Choose review scope</span>
                {onCancel && (
                    <button type="button" onClick={onCancel} style={closeBtnStyle} aria-label="Cancel">
                        ×
                    </button>
                )}
            </div>

            <div style={bodyStyle}>
                <Option
                    checked={scope.kind === 'all'}
                    onClick={() => setScope({ kind: 'all' })}
                    label="All entry points"
                    hint="Review every detected handler in this workspace."
                />
                <Option
                    checked={scope.kind === 'changed'}
                    onClick={() => setScope({ kind: 'changed' })}
                    label="Changed only"
                    hint="Review just the handlers whose source diff vs baseline."
                />
                <Option
                    checked={scope.kind === 'entry'}
                    onClick={() => setScope({ kind: 'entry' })}
                    label="Selected entry point"
                    hint="Re-run review for the entry point currently in scope (set via L3 chip)."
                />

                {/* Multi-repo affordances — only render when the parent supplies a
                    workspace repo list. Hidden in single-repo mode. */}
                {isMulti && (
                    <>
                        <div style={dividerStyle}>Workspace</div>
                        <Option
                            checked={scope.kind === 'workspace'}
                            onClick={() => setScope({ kind: 'workspace' })}
                            label="Workspace fan-out"
                            hint={`Fan out across ${repos!.length} repos. Per-repo findings land in each repo's store.`}
                        />
                        {repos!.map((r) => {
                            const isPicked = scope.kind === 'repo' && (scope as { kind: 'repo'; repoId: string }).repoId === r.repoId;
                            const label = `Repo: ${r.name}${r.hasChanges ? ' ~' : ''}`;
                            return (
                                <Option
                                    key={r.repoId}
                                    checked={isPicked}
                                    onClick={() => setScope({ kind: 'repo', repoId: r.repoId })}
                                    label={label}
                                    hint={`Scope review to just ${r.name}.`}
                                />
                            );
                        })}
                    </>
                )}
            </div>

            <div style={footerStyle}>
                <button type="button" onClick={handleStart} style={primaryBtnStyle} aria-label="Start review">
                    ▶ Start review
                </button>
                {onCancel && (
                    <button type="button" onClick={onCancel} style={secondaryBtnStyle} aria-label="Cancel review">
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
}

function Option({ checked, onClick, label, hint }: {
    checked: boolean;
    onClick: () => void;
    label: string;
    hint: string;
}) {
    return (
        <label style={{ ...optionStyle, ...(checked ? optionCheckedStyle : null) }}>
            <input
                type="radio"
                checked={checked}
                onChange={onClick}
                style={{ marginRight: 8, marginTop: 3 }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 12 }}>{label}</span>
                <span style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{hint}</span>
            </div>
        </label>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: 340,
    maxHeight: 420,
    background: 'var(--ca-surface, #1c1c1f)',
    color: 'var(--ca-text)',
    border: '1px solid var(--ca-border)',
    borderRadius: 8,
    boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
    fontFamily: "'Inter', system-ui, sans-serif",
};

const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: '1px solid var(--ca-border)',
};

const titleStyle: CSSProperties = {
    fontWeight: 700,
    fontSize: 12,
};

const closeBtnStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--ca-text)',
    fontSize: 16,
    cursor: 'pointer',
    opacity: 0.6,
};

const bodyStyle: CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
};

const optionStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    padding: '8px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
};

const optionCheckedStyle: CSSProperties = {
    background: 'rgba(108,114,203,0.16)',
    borderColor: 'var(--ca-accent, #6c72cb)',
};

const dividerStyle: CSSProperties = {
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.6,
    opacity: 0.5,
    padding: '8px 10px 2px',
};

const footerStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    padding: '10px 12px',
    borderTop: '1px solid var(--ca-border)',
};

const primaryBtnStyle: CSSProperties = {
    flex: 1,
    padding: '8px 12px',
    background: 'var(--ca-accent, #6c72cb)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontWeight: 600,
    cursor: 'pointer',
};

const secondaryBtnStyle: CSSProperties = {
    padding: '8px 12px',
    background: 'transparent',
    color: 'var(--ca-text)',
    border: '1px solid var(--ca-border)',
    borderRadius: 6,
    cursor: 'pointer',
};

export default memo(AiReviewScopePicker);
