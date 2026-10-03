/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — registration entry-point for the three
 * default analyzers. Imported once from the extension's activate()
 * (and from the standalone MCP bootstrap, if/when it grows multi-repo
 * support) to populate `defaultCrossRepoRegistry`.
 *
 * Kept as a separate module so tests can avoid the global side-effect
 * by not importing it.
 */
import { defaultCrossRepoRegistry } from '../sync/crossRepoAnalyzer';
import { sharedExternalAnalyzer } from './sharedExternalAnalyzer';
import { sharedSchemaAnalyzer } from './sharedSchemaAnalyzer';
import { crossRepoHttpAnalyzer } from './crossRepoHttpAnalyzer';

let registered = false;

export function registerDefaultCrossRepoAnalyzers(): void {
    if (registered) return;
    defaultCrossRepoRegistry.register(sharedExternalAnalyzer);
    defaultCrossRepoRegistry.register(sharedSchemaAnalyzer);
    defaultCrossRepoRegistry.register(crossRepoHttpAnalyzer);
    registered = true;
}

/** Test hook — unregisters all and clears the dedup flag. */
export function resetDefaultCrossRepoAnalyzersForTest(): void {
    defaultCrossRepoRegistry.unregister(sharedExternalAnalyzer.id);
    defaultCrossRepoRegistry.unregister(sharedSchemaAnalyzer.id);
    defaultCrossRepoRegistry.unregister(crossRepoHttpAnalyzer.id);
    registered = false;
}
