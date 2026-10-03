/**
 * ExportMenu.tsx — Issue 39
 *
 * Dropdown menu for exporting the current diagram in multiple formats:
 *   • PNG  — rasterised snapshot of the React Flow viewport (downloads as .png)
 *   • SVG  — vector serialisation of the React Flow `<svg>` (downloads as .svg)
 *   • Markdown — postMessage triggers the extension's
 *                `codeatlas.exportArchitectureDocs` command which writes
 *                `.codeatlas/architecture.md` and opens it in the editor
 *
 * Replaces the legacy single-button "copy SVG to clipboard" action which was
 * undiscoverable + lossy. The PNG path runs entirely in the browser (no extra
 * deps — uses native `Image` + `<canvas>`).
 */
import React, { useEffect, useRef, useState } from 'react';

type ToastSetter = (text: string, level: 'info' | 'warning' | 'error') => void;

interface ExportMenuProps {
    onToast: ToastSetter;
    diagramLabel: string;
}

function pickSvgElement(): SVGSVGElement | null {
    const viewport = document.querySelector('.react-flow__viewport');
    if (viewport) {
        const owning = viewport.closest('svg');
        if (owning) return owning as SVGSVGElement;
    }
    const fallback = document.querySelector('.react-flow svg');
    return (fallback as SVGSVGElement | null) ?? null;
}

function serialiseSvg(svg: SVGSVGElement): string {
    // Inline the computed dimensions so the standalone file renders correctly
    // when opened outside the page context.
    const rect = svg.getBoundingClientRect();
    const cloned = svg.cloneNode(true) as SVGSVGElement;
    if (!cloned.getAttribute('xmlns')) cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!cloned.getAttribute('width')) cloned.setAttribute('width', String(Math.max(1, Math.round(rect.width))));
    if (!cloned.getAttribute('height')) cloned.setAttribute('height', String(Math.max(1, Math.round(rect.height))));
    return new XMLSerializer().serializeToString(cloned);
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilename(label: string, ext: string): string {
    const slug = label.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'diagram';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `codeatlas-${slug}-${ts}.${ext}`;
}

async function exportSvg(label: string, onToast: ToastSetter): Promise<void> {
    const svg = pickSvgElement();
    if (!svg) {
        onToast('No diagram to export', 'warning');
        return;
    }
    const data = serialiseSvg(svg);
    const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, safeFilename(label, 'svg'));
    onToast('SVG downloaded', 'info');
}

async function exportPng(label: string, onToast: ToastSetter): Promise<void> {
    const svg = pickSvgElement();
    if (!svg) {
        onToast('No diagram to export', 'warning');
        return;
    }
    const data = serialiseSvg(svg);
    const rect = svg.getBoundingClientRect();
    const scale = 2; // 2× for retina-quality PNGs without bloating the file
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));

    const img = new Image();
    // SVG data URL — works for self-contained SVGs (no external <image href>).
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
    try {
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('image load failed'));
        });
    } catch {
        onToast('PNG render failed — try SVG instead', 'warning');
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        onToast('PNG render failed — canvas unavailable', 'warning');
        return;
    }
    // Match the current theme background so the PNG isn't transparent on dark themes.
    const themeBg = getComputedStyle(document.documentElement).getPropertyValue('--ca-bg').trim() || '#ffffff';
    ctx.fillStyle = themeBg;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob((blob) => {
        if (!blob) {
            onToast('PNG export failed', 'warning');
            return;
        }
        downloadBlob(blob, safeFilename(label, 'png'));
        onToast('PNG downloaded', 'info');
    }, 'image/png');
}

function exportMarkdown(onToast: ToastSetter): void {
    // The extension (or standalone toolHandler) writes architecture.md to disk
    // and opens it in the editor. We don't get a response payload back —
    // surface optimistic feedback.
    window.vscodeApi?.postMessage({ type: 'runCommand', command: 'codeatlas.exportArchitectureDocs' });
    onToast('Generating Markdown architecture docs…', 'info');
}

export default function ExportMenu({ onToast, diagramLabel }: ExportMenuProps) {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        document.addEventListener('keydown', escHandler);
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('keydown', escHandler);
        };
    }, [open]);

    const run = (fn: () => Promise<void> | void) => {
        setOpen(false);
        // Defer so the menu close animation completes before the synchronous SVG serialisation
        setTimeout(() => { void fn(); }, 0);
    };

    return (
        <div ref={wrapperRef} style={{ position: 'relative' }}>
            <button
                type="button"
                className="ca-back-btn"
                style={{ fontSize: 10, padding: '2px 8px' }}
                title="Export current diagram"
                aria-label="Export diagram"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
            >
                Export ↓
            </button>
            {open && (
                <div
                    role="menu"
                    style={{
                        position: 'absolute', top: '100%', right: 0, marginTop: 4,
                        background: 'var(--ca-surface)', color: 'var(--ca-text)',
                        border: '1px solid var(--ca-border)', borderRadius: 6,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.18)', padding: 4,
                        minWidth: 160, zIndex: 1000,
                    }}
                >
                    <MenuItem onClick={() => run(() => exportPng(diagramLabel, onToast))}>
                        <span style={{ marginRight: 8 }}>🖼️</span> PNG (raster)
                    </MenuItem>
                    <MenuItem onClick={() => run(() => exportSvg(diagramLabel, onToast))}>
                        <span style={{ marginRight: 8 }}>🎨</span> SVG (vector)
                    </MenuItem>
                    <MenuItem onClick={() => run(() => exportMarkdown(onToast))}>
                        <span style={{ marginRight: 8 }}>📄</span> Markdown + Mermaid
                    </MenuItem>
                </div>
            )}
        </div>
    );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', fontSize: 12, color: 'var(--ca-text)',
                background: 'transparent', border: 'none', borderRadius: 4,
                cursor: 'pointer',
            }}
            onMouseEnter={(e) => { (e.currentTarget.style.background = 'var(--ca-hover-bg, rgba(255,255,255,0.08))'); }}
            onMouseLeave={(e) => { (e.currentTarget.style.background = 'transparent'); }}
        >
            {children}
        </button>
    );
}
