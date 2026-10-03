/**
 * ScriptEditor.tsx — Issue #603 Phase 3.5 / 3.6 script editor wrapper.
 *
 * Renders a Monaco editor when `@monaco-editor/react` is installed,
 * falls back to a `<textarea>` otherwise. The graceful-upgrade pattern
 * lets us ship the API Testing surface today + auto-upgrade to Monaco
 * when the optional dep is added — no rebuild required from users
 * already running without it.
 *
 * Install Monaco with:
 *   cd webview-ui && npm install @monaco-editor/react
 *
 * The component is intentionally typed against a minimal surface so
 * neither path drags Monaco's full type tree into our bundle when the
 * dep is absent.
 */

import React, { useEffect, useRef, useState } from 'react';

export interface ScriptEditorProps {
    value: string;
    onChange: (value: string) => void;
    /** Monaco language id. Defaults to `javascript`. */
    language?: string;
    placeholder?: string;
    /** Editor height in CSS units. Default `160px`. */
    height?: string;
    /** Force the textarea fallback even when Monaco is available — used
     *  by tests so we don't have to spin up the Monaco runtime. */
    forceFallback?: boolean;
    'aria-label'?: string;
}

interface MonacoModule {
    default: React.ComponentType<{
        value: string;
        language?: string;
        defaultLanguage?: string;
        onChange?: (v: string | undefined) => void;
        height?: string;
        options?: Record<string, unknown>;
        theme?: string;
        loading?: React.ReactNode;
    }>;
}

let monacoModule: MonacoModule | null | undefined = undefined;
let monacoPromise: Promise<MonacoModule | null> | null = null;

function loadMonaco(): Promise<MonacoModule | null> {
    if (monacoModule !== undefined) return Promise.resolve(monacoModule);
    if (monacoPromise) return monacoPromise;
    // Use `new Function('m', 'return import(m)')` so the static bundler
    // doesn't try to resolve `@monaco-editor/react` at build time. When
    // the dep isn't installed, the dynamic import rejects and we cache
    // `null`, locking in the textarea fallback for the rest of the
    // session without retrying.
    monacoPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<MonacoModule>)('@monaco-editor/react')
        .then((mod) => { monacoModule = mod; return mod; })
        .catch(() => { monacoModule = null; return null; });
    return monacoPromise;
}

export default function ScriptEditor(props: ScriptEditorProps) {
    const [monaco, setMonaco] = useState<MonacoModule | null | undefined>(monacoModule);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (props.forceFallback) return;
        if (monaco !== undefined) return;
        let cancelled = false;
        loadMonaco().then((m) => {
            if (!cancelled) setMonaco(m);
        });
        return () => { cancelled = true; };
    }, [props.forceFallback, monaco]);

    const height = props.height ?? '160px';

    if (!props.forceFallback && monaco) {
        const Editor = monaco.default;
        return (
            <div ref={containerRef} className="ca-script-editor-monaco" style={{ height }}>
                <Editor
                    value={props.value}
                    defaultLanguage={props.language ?? 'javascript'}
                    onChange={(v) => props.onChange(v ?? '')}
                    height={height}
                    theme="vs-dark"
                    options={{
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: 12,
                        lineNumbers: 'on',
                        tabSize: 2,
                        automaticLayout: true,
                        wordWrap: 'on',
                    }}
                    loading={<span className="ca-script-editor-loading">Loading editor…</span>}
                />
            </div>
        );
    }

    return (
        <textarea
            className="ca-api-testing-textarea ca-api-testing-bodyeditor ca-script-editor-fallback"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder={props.placeholder}
            spellCheck={false}
            aria-label={props['aria-label']}
            style={{ minHeight: height }}
        />
    );
}

/**
 * Test-only escape hatch — vitest configures the static import path so
 * we can prime / reset the cached module without exposing the mutable
 * state via a public API.
 */
export const __testHooks = {
    primeMonaco(mod: MonacoModule | null) { monacoModule = mod; monacoPromise = null; },
    reset() { monacoModule = undefined; monacoPromise = null; },
};
