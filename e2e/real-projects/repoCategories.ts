/**
 * Repo category grouping. Backend repos drive the current test matrix;
 * frontend and mobile repos are de-prioritized while their layer-mapping
 * design is being reworked (different L1-L5 content than backend).
 *
 * To re-enable a category in tests, remove it from BACKEND-only filters
 * or change `isBackendRepo` to widen acceptance.
 */
export type RepoCategory = 'backend' | 'frontend' | 'mobile';

export const FRONTEND_REPO_IDS = new Set<string>([
    'js-nextjs',
    'ts-nextjs-pages',
    'ts-nuxt',
    'ts-remix',
    'ts-sveltekit',
]);

export const MOBILE_REPO_IDS = new Set<string>([
    'ts-react-native',
    'dart-flutter',
    'kotlin-android',
    'swift-ios',
]);

export const NON_BACKEND_REPO_IDS = new Set<string>([
    ...FRONTEND_REPO_IDS,
    ...MOBILE_REPO_IDS,
]);

export function categoryOf(id: string): RepoCategory {
    if (FRONTEND_REPO_IDS.has(id)) return 'frontend';
    if (MOBILE_REPO_IDS.has(id)) return 'mobile';
    return 'backend';
}

export function isBackendRepo(id: string): boolean {
    return !NON_BACKEND_REPO_IDS.has(id);
}

export function isFrontendRepo(id: string): boolean {
    return FRONTEND_REPO_IDS.has(id);
}

export function isMobileRepo(id: string): boolean {
    return MOBILE_REPO_IDS.has(id);
}
