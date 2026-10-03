/**
 * CommitPicker.tsx
 *
 * Browser-mode modal for selecting two git commits to compare.
 * Replaces VS Code's quickPick dialog when running in the browser.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';

interface CommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    relativeDate: string;
}

interface CommitPickerProps {
    commits: CommitInfo[];
    onSelect: (baseHash: string, headHash: string) => void;
    onCancel: () => void;
}

export default function CommitPicker({ commits, onSelect, onCancel }: CommitPickerProps) {
    const [step, setStep] = useState<'base' | 'head'>('base');
    const [baseHash, setBaseHash] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => { searchRef.current?.focus(); }, [step]);

    const filtered = useMemo(() => {
        if (!search) return commits;
        const q = search.toLowerCase();
        return commits.filter(c =>
            c.shortHash.toLowerCase().includes(q) ||
            c.subject.toLowerCase().includes(q) ||
            c.author.toLowerCase().includes(q)
        );
    }, [commits, search]);

    const handlePick = (hash: string) => {
        if (step === 'base') {
            setBaseHash(hash);
            setStep('head');
            setSearch('');
        } else {
            onSelect(baseHash!, hash);
        }
    };

    const handleBack = () => {
        if (step === 'head') {
            setStep('base');
            setBaseHash(null);
            setSearch('');
        } else {
            onCancel();
        }
    };

    return (
        <div className="ca-modal-overlay" onClick={onCancel}>
            <div className="ca-modal" onClick={e => e.stopPropagation()}>
                <div className="ca-modal-header">
                    <h3>{step === 'base' ? 'Select base commit (older)' : 'Select head commit (newer)'}</h3>
                    <button className="ca-modal-close" onClick={onCancel} aria-label="Close">x</button>
                </div>
                {step === 'head' && baseHash && (
                    <div className="ca-modal-info">
                        Base: <strong>{commits.find(c => c.hash === baseHash)?.shortHash}</strong>{' '}
                        {commits.find(c => c.hash === baseHash)?.subject}
                    </div>
                )}
                <input
                    ref={searchRef}
                    className="ca-modal-search"
                    type="text"
                    placeholder="Search by hash, message, or author..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <div className="ca-modal-list">
                    {filtered.map(c => (
                        <button
                            key={c.hash}
                            className={`ca-modal-list-item${c.hash === baseHash ? ' selected' : ''}`}
                            onClick={() => handlePick(c.hash)}
                            disabled={step === 'head' && c.hash === baseHash}
                        >
                            <span className="ca-commit-hash">{c.shortHash}</span>
                            <span className="ca-commit-subject">{c.subject}</span>
                            <span className="ca-commit-meta">{c.author} · {c.relativeDate}</span>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <div className="ca-modal-empty">No commits match "{search}"</div>
                    )}
                </div>
                <div className="ca-modal-footer">
                    <button className="ca-modal-btn" onClick={handleBack}>
                        {step === 'head' ? 'Back' : 'Cancel'}
                    </button>
                </div>
            </div>
        </div>
    );
}
