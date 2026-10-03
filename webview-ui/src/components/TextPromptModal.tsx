/**
 * TextPromptModal.tsx — an in-webview replacement for native `window.prompt()`.
 *
 * BUG-EXPLORE-11: "Add comment" and Chain Runner "Save chain" used native
 * `window.prompt()`, which FREEZES the whole browser-served webview until
 * dismissed (and is a silent no-op inside a VS Code webview). This lightweight
 * modal collects a single line / block of text without blocking the event loop.
 * Enter (or Cmd/Ctrl+Enter for multiline) submits; Escape cancels.
 */
import React, { useEffect, useRef, useState } from 'react';

interface TextPromptModalProps {
    title: string;
    placeholder?: string;
    initialValue?: string;
    submitLabel?: string;
    multiline?: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}

export default function TextPromptModal({
    title, placeholder, initialValue = '', submitLabel = 'OK', multiline = false, onSubmit, onCancel,
}: TextPromptModalProps) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
    useEffect(() => { inputRef.current?.focus(); }, []);

    const submit = () => { const v = value.trim(); if (v) onSubmit(v); };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
        if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    };

    const overlay: React.CSSProperties = {
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    const box: React.CSSProperties = {
        background: 'var(--ca-surface, #1e1e1e)', color: 'var(--ca-text, #ddd)',
        border: '1px solid var(--ca-border, #333)', borderRadius: 8, padding: 16,
        width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    };

    return (
        <div className="ca-modal-overlay" data-testid="text-prompt-modal" style={overlay}
            onClick={onCancel} onKeyDown={onKeyDown}>
            <div style={box} onClick={(e) => e.stopPropagation()}>
                <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>{title}</div>
                {multiline ? (
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        className="ca-api-search" value={value} placeholder={placeholder}
                        onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
                        rows={3} style={{ width: '100%', resize: 'vertical' }}
                        data-testid="text-prompt-input"
                    />
                ) : (
                    <input
                        ref={inputRef as React.RefObject<HTMLInputElement>}
                        className="ca-api-search" type="text" value={value} placeholder={placeholder}
                        onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
                        style={{ width: '100%' }} data-testid="text-prompt-input"
                    />
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                    <button className="ca-method-tab" onClick={onCancel}>Cancel</button>
                    <button className="ca-method-tab active" onClick={submit} disabled={!value.trim()}
                        style={{ opacity: value.trim() ? 1 : 0.5 }}>{submitLabel}</button>
                </div>
            </div>
        </div>
    );
}
