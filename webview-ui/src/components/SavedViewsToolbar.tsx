/**
 * SavedViewsToolbar.tsx — #750 saved-views surface (2026-06-06).
 *
 * Mountable inline toolbar that hosts a `💾 Save view` button (with an
 * expanding name input) plus a dropdown list of saved views. Stateless
 * about persistence — the parent owns the views array and the three
 * callbacks. Designed to drop into the Knowledge Map header AND the
 * API list header without duplication.
 */
import { useState } from 'react';

export interface SavedFilterView {
    id: string;
    name: string;
    route: string;
    filters: Record<string, unknown>;
    createdAt: number;
    description?: string;
}

export interface SavedViewsToolbarProps {
    views: SavedFilterView[];
    onSave: (name: string) => void;
    onApply: (id: string) => void;
    onDelete: (id: string) => void;
}

export default function SavedViewsToolbar({ views, onSave, onApply, onDelete }: SavedViewsToolbarProps) {
    const [savingOpen, setSavingOpen] = useState(false);
    const [savingName, setSavingName] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);

    const trimmedName = savingName.trim();

    return (
        <div style={{ position: 'relative', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {!savingOpen && (
                <button
                    type="button"
                    className="ca-api-testing-send"
                    onClick={() => { setSavingOpen(true); setSavingName(''); }}
                    aria-label="Save current view"
                    data-testid="ca-saved-views-save-btn"
                >
                    💾 Save view
                </button>
            )}
            {savingOpen && (
                <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input
                        type="text"
                        className="ca-api-testing-input"
                        value={savingName}
                        onChange={(e) => setSavingName(e.target.value)}
                        placeholder="Name this view"
                        aria-label="Saved view name"
                        data-testid="ca-saved-views-name-input"
                        autoFocus
                        style={{ width: 160 }}
                    />
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => {
                            onSave(trimmedName);
                            setSavingOpen(false);
                            setSavingName('');
                        }}
                        disabled={!trimmedName}
                        data-testid="ca-saved-views-save-confirm"
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        onClick={() => { setSavingOpen(false); setSavingName(''); }}
                        aria-label="Cancel save"
                        data-testid="ca-saved-views-save-cancel"
                    >
                        ✕
                    </button>
                </div>
            )}
            {views.length > 0 && !savingOpen && (
                <>
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => setDropdownOpen(v => !v)}
                        aria-haspopup="menu"
                        aria-expanded={dropdownOpen}
                        data-testid="ca-saved-views-dropdown-btn"
                    >
                        📂 Views ({views.length}) ▾
                    </button>
                    {dropdownOpen && (
                        <ul
                            role="menu"
                            style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, padding: 4, listStyle: 'none', background: 'var(--ca-surface, #0f172a)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, minWidth: 220, maxHeight: 280, overflow: 'auto', zIndex: 50 }}
                        >
                            {views.map(view => (
                                <li
                                    key={view.id}
                                    role="none"
                                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}
                                >
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { onApply(view.id); setDropdownOpen(false); }}
                                        data-testid={`ca-saved-views-row-${view.id}`}
                                        title={`${view.route} — ${new Date(view.createdAt).toLocaleString()}`}
                                        style={{ flex: 1, textAlign: 'left', padding: '6px 8px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
                                    >
                                        {view.name}
                                        <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>
                                            {view.route}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); onDelete(view.id); }}
                                        aria-label={`Delete ${view.name}`}
                                        data-testid={`ca-saved-views-delete-${view.id}`}
                                        style={{ background: 'transparent', border: 'none', color: 'var(--ca-text-muted, #94a3b8)', cursor: 'pointer', padding: '0 6px' }}
                                    >
                                        ×
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
