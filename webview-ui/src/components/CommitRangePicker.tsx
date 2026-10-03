import { useState, useMemo } from 'react';

interface CommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    relativeDate: string;
}

interface BranchInfo {
    name: string;
    isCurrent: boolean;
    isRemote: boolean;
}

interface CommitRangePickerProps {
    commits: CommitInfo[];
    branches?: BranchInfo[];
    currentBranch?: string;
    baselineHash?: string;
    onStart: (selectedCommits: CommitInfo[]) => void;
    onCancel: () => void;
    onBranchChange?: (branch: string) => void;
}

export default function CommitRangePicker({ commits, branches, currentBranch, baselineHash, onStart, onCancel, onBranchChange }: CommitRangePickerProps) {
    const [startIdx, setStartIdx] = useState<number | null>(() => {
        // Auto-select range from baseline to latest
        if (baselineHash) {
            const idx = commits.findIndex(c => c.hash === baselineHash || c.hash.startsWith(baselineHash));
            return idx >= 0 ? idx : null;
        }
        return null;
    });
    const [endIdx, setEndIdx] = useState<number | null>(() => {
        // If baseline found, auto-select HEAD (index 0) as end
        if (baselineHash && commits.length > 0) {
            const baseIdx = commits.findIndex(c => c.hash === baselineHash || c.hash.startsWith(baselineHash));
            return baseIdx >= 0 ? 0 : null;
        }
        return null;
    });
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        if (!search) return commits;
        const q = search.toLowerCase();
        return commits.filter(c =>
            c.subject.toLowerCase().includes(q) || c.shortHash.includes(q) || c.author.toLowerCase().includes(q)
        );
    }, [commits, search]);

    const selectedCount = startIdx !== null && endIdx !== null
        ? Math.abs(endIdx - startIdx) + 1
        : startIdx !== null ? 1 : 0;

    // Single commit can start if a parent commit exists in the list
    const singleCommitHasParent = selectedCount === 1 && startIdx !== null && (endIdx ?? startIdx) + 1 < commits.length;
    const canStart = selectedCount >= 2 || singleCommitHasParent;
    const diffPairs = selectedCount === 1 ? 1 : Math.max(0, selectedCount - 1);
    const estimatedTime = diffPairs > 0 ? `~${diffPairs * 15}s` : '';

    const handleClick = (idx: number) => {
        if (startIdx === null) {
            setStartIdx(idx);
            setEndIdx(null);
        } else if (endIdx === null) {
            setEndIdx(idx);
        } else {
            setStartIdx(idx);
            setEndIdx(null);
        }
    };

    const handleStart = () => {
        if (startIdx === null) return;
        const end = endIdx ?? startIdx;
        const lo = Math.min(startIdx, end);
        const hi = Math.max(startIdx, end);
        let selected = commits.slice(lo, hi + 1);

        // Include the parent of the oldest commit to use as the base for the first diff
        if (hi + 1 < commits.length) {
            selected.push(commits[hi + 1]);
        }

        // Reverse to chronological order: [OldestParent, OldestCommit, ..., NewestCommit]
        selected.reverse();

        if (selected.length >= 2) {
            onStart(selected);
        }
    };

    const isInRange = (idx: number) => {
        if (startIdx === null) return false;
        const end = endIdx ?? startIdx;
        const lo = Math.min(startIdx, end);
        const hi = Math.max(startIdx, end);
        return idx >= lo && idx <= hi;
    };

    // Local branches first, then remotes
    const sortedBranches = useMemo(() => {
        if (!branches) return [];
        return [...branches].sort((a, b) => {
            if (a.isCurrent) return -1;
            if (b.isCurrent) return 1;
            if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
    }, [branches]);

    return (
        <div className="ca-modal-overlay" onClick={onCancel}>
            <div className="ca-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, maxHeight: '80vh' }}>
                <div className="ca-modal-header">
                    <h3 style={{ margin: 0, fontSize: 14 }}>Timeline Replay — Select Commit Range</h3>
                    <button className="ca-modal-close" onClick={onCancel}>x</button>
                </div>

                <div style={{ padding: '8px 16px' }}>
                    {/* Branch selector */}
                    {sortedBranches.length > 0 && (
                        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 11, color: 'var(--ca-text-muted)', flexShrink: 0 }}>Branch:</span>
                            <select
                                value={currentBranch ?? ''}
                                onChange={e => {
                                    setStartIdx(null);
                                    setEndIdx(null);
                                    onBranchChange?.(e.target.value);
                                }}
                                style={{
                                    flex: 1, background: 'var(--ca-surface)', color: 'var(--ca-text)',
                                    border: '1px solid var(--ca-border)', borderRadius: 'var(--ca-radius-sm)',
                                    padding: '4px 8px', fontSize: 12, fontFamily: 'var(--ca-font-mono)',
                                }}
                            >
                                {sortedBranches.map(b => (
                                    <option key={b.name} value={b.name}>
                                        {b.isCurrent ? '* ' : ''}{b.name}{b.isRemote ? ' (remote)' : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <input
                        type="text"
                        placeholder="Search commits..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="ca-modal-search"
                        autoFocus
                    />
                    <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                        {startIdx === null ? 'Click a commit to replay, or select a range' :
                         endIdx === null && singleCommitHasParent ? `1 commit selected — will diff against parent ${estimatedTime}` :
                         endIdx === null ? 'Click another commit to set the end' :
                         `${selectedCount} commits selected ${estimatedTime}`}
                    </div>
                </div>

                <div style={{ overflowY: 'auto', maxHeight: '50vh', padding: '0 16px' }}>
                    {filtered.map((c) => {
                        const realIdx = commits.indexOf(c);
                        const inRange = isInRange(realIdx);
                        const isEndpoint = realIdx === startIdx || realIdx === endIdx;
                        const isBaseline = baselineHash && (c.hash === baselineHash || c.hash.startsWith(baselineHash));
                        return (
                            <div
                                key={c.hash}
                                onClick={() => handleClick(realIdx)}
                                style={{
                                    padding: '8px 10px',
                                    borderRadius: 6,
                                    cursor: 'pointer',
                                    background: isEndpoint ? 'var(--ca-accent)' : inRange ? 'var(--ca-nl-query-bg)' : 'transparent',
                                    color: isEndpoint ? '#fff' : 'var(--ca-text)',
                                    borderLeft: isBaseline ? '3px solid var(--ca-warning)' : inRange ? '3px solid var(--ca-nl-query)' : '3px solid transparent',
                                    marginBottom: 2,
                                    transition: 'background 0.15s',
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontFamily: 'var(--ca-font-mono)', fontSize: 11, opacity: 0.7 }}>{c.shortHash}</span>
                                        {isBaseline && (
                                            <span style={{
                                                fontSize: 9, padding: '1px 5px', borderRadius: 4,
                                                background: 'var(--ca-warning)', color: '#000', fontWeight: 600,
                                            }}>
                                                merge-base
                                            </span>
                                        )}
                                    </span>
                                    <span style={{ fontSize: 10, color: isEndpoint ? 'rgba(255,255,255,0.7)' : 'var(--ca-text-muted)' }}>{c.relativeDate}</span>
                                </div>
                                <div style={{ fontSize: 12, marginTop: 2 }}>{c.subject}</div>
                                <div style={{ fontSize: 10, color: isEndpoint ? 'rgba(255,255,255,0.6)' : 'var(--ca-text-muted)' }}>{c.author}</div>
                            </div>
                        );
                    })}
                </div>

                <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--ca-border)' }}>
                    <button className="ca-modal-btn" onClick={onCancel}>Cancel</button>
                    <button
                        className="ca-modal-btn ca-modal-btn-primary"
                        onClick={handleStart}
                        disabled={!canStart}
                        style={{ opacity: !canStart ? 0.5 : 1 }}
                    >
                        Start Replay ({selectedCount === 1 ? '1 commit' : `${selectedCount} commits`})
                    </button>
                </div>
            </div>
        </div>
    );
}
