/**
 * mobile/android.ts — Android (Java + Kotlin) platform plugin.
 *
 * Detects Activities / Fragments / Composables (screens), navigation
 * routes, Retrofit + Room data access, Hilt / Dagger / Koin DI bindings,
 * Activity / Fragment lifecycle methods, FCM push handlers, WorkManager
 * background tasks, and BroadcastReceiver / Service entries.
 *
 * Gated by Android-specific import patterns (`android.`, `androidx.`,
 * Dagger / Hilt, Retrofit, OkHttp) so framework annotations that overlap
 * with other ecosystems (e.g. Spring `@GET` vs Retrofit `@GET`) don't
 * produce false positives.
 */

import type { MobilePlatformPlugin } from './types';
import type { ApiRecord } from '../../graph/graphTypes';
import { makeItem, isTestFile } from './_shared';

function isAndroidFile(source: string): boolean {
    return /import\s+(?:android\.|androidx\.|com\.google\.dagger|dagger\.hilt|retrofit2|okhttp3)/.test(source);
}

const ANDROID_SCREEN_BASES = new Set([
    'Activity', 'AppCompatActivity', 'ComponentActivity', 'FragmentActivity',
    'Fragment', 'DialogFragment', 'BottomSheetDialogFragment',
    'ListFragment', 'PreferenceFragmentCompat',
]);

// TICKET-DETECT-2 — Kotlin modifiers/keywords the loose `@Composable …(\w+)`
// capture can grab instead of a real function name (`@Composable\nprivate fun`,
// `@Composable\nfun`, `@Composable get()` on a property). Never a screen name.
const KOTLIN_NON_NAME_TOKENS = new Set([
    'private', 'internal', 'public', 'protected', 'fun', 'get', 'set',
    'val', 'var', 'suspend', 'inline', 'noinline', 'crossinline', 'abstract',
    'override', 'open', 'final', 'const', 'operator', 'infix', 'tailrec',
    'external', 'expect', 'actual', 'lateinit', 'vararg', 'reified',
]);

function detectAndroidItems(source: string, filePath: string): ApiRecord[] {
    if (!isAndroidFile(source) || isTestFile(filePath)) return [];
    const items: ApiRecord[] = [];
    const seen = new Set<string>();

    // Screens: class extends Activity/Fragment
    const classPattern = /class\s+(\w+)\s*(?:<[^>]*>)?\s*(?::\s*(\w+)|extends\s+(\w+))/g;
    let m: RegExpExecArray | null;
    while ((m = classPattern.exec(source)) !== null) {
        const className = m[1];
        const parent = m[2] ?? m[3];
        if (parent && ANDROID_SCREEN_BASES.has(parent) && !seen.has(className)) {
            seen.add(className);
            items.push(makeItem('SCREEN', `/${className}`, className, filePath, m.index));
        }
    }

    // Screens: @Composable functions (Kotlin). TICKET-DETECT-2 (partial) — SAFE
    // reductions of the SCREEN over-count (the full component-vs-navigable-screen
    // distinction is a separate nav-graph effort):
    //   • skip `@Preview` composables (Compose tooling previews are dev-only
    //     renders, ~one per component — never navigable screens);
    //   • skip garbage captures: `@Composable\nprivate fun X` / `fun BoxScope.X`
    //     make the loose `(\w+)` grab a Kotlin MODIFIER/keyword (`private`,
    //     `internal`, `fun`, `get`, …) instead of a name — never a real screen;
    //   • skip NAME-based previews the annotation window missed: by Compose
    //     convention `FooPreview` / `FooPreviews` / `PreviewFoo` are tooling
    //     previews (dev-only), never navigable screens.
    const composablePattern = /@Composable\s+(?:fun\s+)?(\w+)/g;
    while ((m = composablePattern.exec(source)) !== null) {
        const fnName = m[1];
        if (/@Preview\b/.test(source.slice(Math.max(0, m.index - 80), m.index))) continue;
        if (KOTLIN_NON_NAME_TOKENS.has(fnName)) continue;
        if (/(^Preview[A-Z]|Previews?$)/.test(fnName)) continue;
        if (!seen.has(fnName)) {
            seen.add(fnName);
            // MOBILE-1 — tag composable-derived SCREENs so the snapshot-level
            // reclassifier can keep only the navigable ones (NavHost destinations
            // / *Screen) and drop pure UI components, WITHOUT touching class-based
            // Activity/Fragment screens.
            items.push({ ...makeItem('SCREEN', `/${fnName}`, fnName, filePath, m.index), meta: { composable: true } });
        }
    }

    // Navigation: composable("route") in NavHost
    const navComposable = /composable\s*\(\s*(?:route\s*=\s*)?["']([^"']+)["']/g;
    while ((m = navComposable.exec(source)) !== null) {
        const route = m[1];
        if (!seen.has(`nav:${route}`)) {
            seen.add(`nav:${route}`);
            items.push(makeItem('NAV_ROUTE', route, route, filePath, m.index));
        }
    }

    // Navigation: navigate("destination")
    const navigateCall = /\.navigate\s*\(\s*["']([^"']+)["']/g;
    while ((m = navigateCall.exec(source)) !== null) {
        const dest = m[1];
        if (!seen.has(`nav:${dest}`)) {
            seen.add(`nav:${dest}`);
            items.push(makeItem('NAV_ROUTE', dest, dest, filePath, m.index));
        }
    }

    // Network: Retrofit annotations (gated by import retrofit2)
    if (/import\s+retrofit2/.test(source)) {
        const retrofitPattern = /@(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(\s*["']([^"']+)["']\s*\)/g;
        while ((m = retrofitPattern.exec(source)) !== null) {
            items.push(makeItem('NETWORK', m[2], m[1], filePath, m.index));
        }
    }

    // Network/DB: Room DAO methods (gated by import androidx.room)
    if (/import\s+androidx\.room/.test(source)) {
        const roomQuery = /@Query\s*\(\s*["']([^"']+)["']\s*\)\s*(?:suspend\s+)?(?:fun|abstract\s+fun)\s+(\w+)/g;
        while ((m = roomQuery.exec(source)) !== null) {
            items.push(makeItem('NETWORK', `Room: ${m[1].slice(0, 40)}`, m[2], filePath, m.index));
        }
        const roomCrud = /@(Insert|Update|Delete)\b[^)]*\s*(?:suspend\s+)?(?:fun|abstract\s+fun)\s+(\w+)/g;
        while ((m = roomCrud.exec(source)) !== null) {
            items.push(makeItem('NETWORK', `Room: @${m[1]}`, m[2], filePath, m.index));
        }
    }

    // DI: Hilt/Dagger
    const hiltModule = /@Module\b/g;
    while ((m = hiltModule.exec(source)) !== null) {
        const nearby = source.slice(m.index, m.index + 200);
        const className = nearby.match(/(?:class|object)\s+(\w+)/)?.[1] ?? 'Module';
        if (!seen.has(`di:${className}`)) {
            seen.add(`di:${className}`);
            items.push(makeItem('DI_BINDING', `@Module ${className}`, className, filePath, m.index));
        }
    }

    const providesPattern = /@Provides\s+(?:fun\s+)?(\w+)/g;
    while ((m = providesPattern.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Provides ${m[1]}`, m[1], filePath, m.index));
    }

    const hiltVM = /@HiltViewModel\s+class\s+(\w+)/g;
    while ((m = hiltVM.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@HiltViewModel ${m[1]}`, m[1], filePath, m.index));
    }

    // DI: Koin
    const koinPattern = /(?:single|factory|viewModel)\s*(?:<\w+>)?\s*\{/g;
    while ((m = koinPattern.exec(source)) !== null) {
        const kind = m[0].match(/^(\w+)/)?.[1] ?? 'binding';
        items.push(makeItem('DI_BINDING', `koin:${kind}`, kind, filePath, m.index));
    }

    // DI: @Inject constructor
    const injectCtor = /@Inject\s+constructor\s*\(/g;
    while ((m = injectCtor.exec(source)) !== null) {
        const nearby = source.slice(Math.max(0, m.index - 200), m.index);
        const className = nearby.match(/class\s+(\w+)/)?.[1] ?? 'Injectable';
        items.push(makeItem('DI_BINDING', `@Inject ${className}`, className, filePath, m.index));
    }

    // Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — Activity / Fragment lifecycle methods. These are
    // entry points that the Android framework calls (not the user's own code).
    // We restrict to overrides of well-known lifecycle method names so we
    // don't false-match arbitrary Kotlin functions.
    {
        const ACTIVITY_LIFECYCLE = ['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy', 'onRestart', 'onSaveInstanceState', 'onRestoreInstanceState', 'onActivityResult', 'onNewIntent', 'onConfigurationChanged'];
        const FRAGMENT_LIFECYCLE = ['onAttach', 'onCreateView', 'onViewCreated', 'onActivityCreated', 'onDetach'];
        const allHooks = new Set([...ACTIVITY_LIFECYCLE, ...FRAGMENT_LIFECYCLE]);
        // Only emit if the file is actually an Activity or Fragment (extends
        // appropriate base class). Otherwise `onCreate` could match a generic
        // ViewModel `init`-like method.
        const inActivityOrFragment = /class\s+\w+\s*(?:\([^)]*\))?\s*:\s*(?:[\w.]+\s*\([^)]*\)\s*,\s*)*(?:AppCompatActivity|ComponentActivity|Activity|Fragment|DialogFragment|BottomSheetDialogFragment|PreferenceFragmentCompat)\b/.test(source);
        if (inActivityOrFragment) {
            const lifecyclePattern = /override\s+fun\s+(\w+)\s*\(/g;
            while ((m = lifecyclePattern.exec(source)) !== null) {
                if (allHooks.has(m[1])) {
                    items.push(makeItem('LIFECYCLE', `lifecycle:${m[1]}`, m[1], filePath, m.index));
                }
            }
        }
    }

    // Tier 2 (Issue 365 — Cascade rebuilds every api-list when one file changes) — Push handlers: Firebase Cloud Messaging service
    // overrides `onMessageReceived` (foreground / data messages).
    if (/import\s+com\.google\.firebase\.messaging|extends\s+FirebaseMessagingService/.test(source)) {
        const fcmPattern = /override\s+fun\s+(onMessageReceived|onNewToken|onDeletedMessages|onMessageSent|onSendError)\s*\(/g;
        while ((m = fcmPattern.exec(source)) !== null) {
            items.push(makeItem('PUSH_HANDLER', `fcm:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // Tier 2 — Background tasks: WorkManager Worker / CoroutineWorker subclasses.
    if (/import\s+androidx\.work\.(?:Worker|CoroutineWorker|ListenableWorker)/.test(source)) {
        const workerPattern = /class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(?:CoroutineWorker|Worker|ListenableWorker)\b/g;
        while ((m = workerPattern.exec(source)) !== null) {
            items.push(makeItem('BG_TASK', `worker:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // Tier 2 — BroadcastReceiver / JobIntentService (system events / foreground services).
    const receiverPattern = /class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(BroadcastReceiver|JobIntentService|JobService|Service)\b/g;
    while ((m = receiverPattern.exec(source)) !== null) {
        items.push(makeItem('BG_TASK', `${m[2].toLowerCase()}:${m[1]}`, m[1], filePath, m.index));
    }

    return items;
}

export const androidPlugin: MobilePlatformPlugin = {
    id: 'android',
    languages: ['java', 'kotlin'],
    detect: (source, filePath) => detectAndroidItems(source, filePath),
};
