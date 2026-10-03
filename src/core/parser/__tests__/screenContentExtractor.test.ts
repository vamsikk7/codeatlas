/**
 * screenContentExtractor.test.ts — v2 phase 4 PR-A scaffolding tests.
 *
 * What this suite locks:
 *   1. Empty workspace (no screens) → empty result. The dispatcher's
 *      iteration shape is screen-keyed; passing zero screens emits
 *      zero items regardless of how many files are in the snapshot.
 *   2. Backend screens (impossible in practice — screenDetector
 *      gates them out — but a defensive test pins the behaviour if
 *      a future regression in screenDetector emits backend screens).
 *   3. PR-A stub: even with FE/mobile screens present, no items are
 *      emitted yet. PR-B+ will replace the stubs; this test is the
 *      contract that future PRs must keep passing (the result type
 *      shape, not the count, is what's locked here).
 *
 * Per-section detectors (interactions / data / lifecycle / nav-in /
 * nav-out / visual) get their own positive coverage in PR-B through
 * PR-E. Storage round-trip + back-compat lives in
 * snapshotStore.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { extractScreenContents } from '../screenContentExtractor';
import type { Snapshot, ScreenRecord, L2bScreenItem } from '../../graph/graphTypes';

function emptySnap(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

function mkScreen(over: Partial<ScreenRecord> & { screenId: string }): ScreenRecord {
    return {
        serviceId: 'service:web',
        routePath: '/',
        framework: 'nextjs-app',
        filePath: 'apps/web/app/page.tsx',
        anchor: { filePath: 'apps/web/app/page.tsx', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

function mkSnapWith(filePath: string, content: string): Snapshot {
    return {
        files: {
            [filePath]: { path: filePath, hash: 'h', mtime: 0, content, symbols: { functions: [], variables: [], imports: [] } },
        },
        apiIndex: {},
        graphs: {},
    };
}

function interactions(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'interactions');
}

function dataItems(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'data');
}

function lifecycleItems(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'lifecycle');
}

function navOutItems(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'nav-out');
}

function navInItems(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'nav-in');
}

function visualItems(result: Record<string, L2bScreenItem[]>): L2bScreenItem[] {
    return Object.values(result).flat().filter((i) => i.section === 'visual');
}

describe('extractScreenContents — PR-A scaffolding contract', () => {
    it('returns empty record for an empty workspace (no screens)', () => {
        const result = extractScreenContents(emptySnap(), {});
        expect(result).toEqual({});
    });

    it('returns empty record for an FE screen today (PR-A stub)', () => {
        const screens: Record<string, ScreenRecord> = {
            's1': mkScreen({ screenId: 's1', routePath: '/home', framework: 'nextjs-app' }),
        };
        const result = extractScreenContents(emptySnap(), screens);
        // PR-B will swap this to `s1` having some items. For now,
        // empty (or a `s1: []`-shaped row) is acceptable. The contract
        // is: no extra screen ids appear, and any present row is an
        // array.
        for (const [sid, items] of Object.entries(result)) {
            expect(sid).toBe('s1');
            expect(Array.isArray(items)).toBe(true);
        }
    });

    it('returns empty record for a mobile screen today (PR-A stub)', () => {
        const screens: Record<string, ScreenRecord> = {
            'm1': mkScreen({ screenId: 'm1', serviceId: 'service:mobile', framework: 'android-activity', filePath: 'apps/m/MainActivity.kt' }),
        };
        const result = extractScreenContents(emptySnap(), screens);
        for (const [sid, items] of Object.entries(result)) {
            expect(sid).toBe('m1');
            expect(Array.isArray(items)).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 4 PR-B — Interactions per framework.
//
// Each describe block exercises one framework family's interaction
// pattern. Coverage focuses on:
//   1. Positive: a representative `on*=…` shape produces one item with
//      the right `kind: 'interaction:<verb>'`.
//   2. Multiple handlers in one file → multiple items.
//   3. Inline arrow function → `handlerName` is undefined, label
//      reads `anonymous@on<Verb>` (so the L2b row doesn't show a
//      garbage `() => …` string).
//   4. The item's `itemId` is stable (`interactions:<file>:<symbol>`).
//   5. Per-framework signature gates correctly (a Vue `@click` in a
//      .tsx file doesn't fire — and vice versa).
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — JSX interactions (PR-B)', () => {
    it('JSX onClick={handler} → interaction:click item', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, 'export default function P() { return <button onClick={save}>X</button>; }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const result = extractScreenContents(snap, screens);
        const items = interactions(result);
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:click');
        expect(items[0].handlerName).toBe('save');
        expect(items[0].itemId).toBe('interactions:apps/web/app/page.tsx:save');
    });

    it('JSX inline arrow → label becomes anonymous@onClick, handlerName undefined', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, 'export default function P() { return <button onClick={() => alert("x")}>X</button>; }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:click');
        expect(items[0].handlerName).toBeUndefined();
        expect(items[0].label).toBe('anonymous@onClick');
    });

    it('multiple JSX handlers (onClick + onSubmit + onChange) → three items with distinct kinds', () => {
        const fp = 'apps/web/app/form.tsx';
        const snap = mkSnapWith(fp, '<form onSubmit={handleSubmit}>\n  <input onChange={onName} />\n  <button onClick={cancel} />\n</form>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'remix' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const kinds = items.map((i) => i.kind).sort();
        expect(kinds).toEqual(['interaction:change', 'interaction:click', 'interaction:submit']);
    });

    it('React SPA + RN nav frameworks also extract JSX interactions', () => {
        const fp = 'apps/spa/src/App.tsx';
        const snap = mkSnapWith(fp, '<button onClick={onSpa}>x</button>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'react-spa' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].handlerName).toBe('onSpa');
    });
});

describe('extractScreenContents — Vue interactions (PR-B)', () => {
    it('@click="save" → interaction:click', () => {
        const fp = 'apps/web/pages/index.vue';
        const snap = mkSnapWith(fp, '<template><button @click="save">X</button></template>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:click');
        expect(items[0].handlerName).toBe('save');
    });

    it('@submit.prevent="handleSubmit" (modifier-suffix) → interaction:submit', () => {
        const fp = 'apps/web/pages/login.vue';
        const snap = mkSnapWith(fp, '<form @submit.prevent="handleSubmit">…</form>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:submit');
        expect(items[0].handlerName).toBe('handleSubmit');
    });

    it('v-on:click="x" old-style binding also matched', () => {
        const fp = 'apps/web/pages/legacy.vue';
        const snap = mkSnapWith(fp, '<a v-on:click="navigate">go</a>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].handlerName).toBe('navigate');
    });
});

describe('extractScreenContents — Svelte interactions (PR-B)', () => {
    it('on:click={save} → interaction:click', () => {
        const fp = 'apps/web/src/routes/+page.svelte';
        const snap = mkSnapWith(fp, '<button on:click={save}>X</button>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:click');
        expect(items[0].handlerName).toBe('save');
    });

    it('on:submit|preventDefault={handleSubmit} (modifier syntax) → interaction:submit', () => {
        const fp = 'apps/web/src/routes/login/+page.svelte';
        const snap = mkSnapWith(fp, '<form on:submit|preventDefault={handleSubmit}>…</form>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:submit');
        expect(items[0].handlerName).toBe('handleSubmit');
    });

    it('inline arrow in Svelte handler → anonymous label', () => {
        const fp = 'apps/web/src/routes/test/+page.svelte';
        const snap = mkSnapWith(fp, '<button on:click={() => count++}>x</button>');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].handlerName).toBeUndefined();
        expect(items[0].label).toBe('anonymous@on:click');
    });
});

describe('extractScreenContents — SwiftUI / UIKit interactions (PR-B)', () => {
    it('.onTapGesture { … } → interaction:tap (anonymous)', () => {
        const fp = 'apps/ios/Home.swift';
        const snap = mkSnapWith(fp, 'struct HomeView: View { var body: some View { Text("hi").onTapGesture { go() } } }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:tap');
        expect(items[0].label).toBe('anonymous@onTapGesture');
    });

    it('.onSubmit { … } → interaction:submit (anonymous)', () => {
        const fp = 'apps/ios/Form.swift';
        const snap = mkSnapWith(fp, 'Form { } .onSubmit { print("submitted") }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.find((i) => i.kind === 'interaction:submit')).toBeDefined();
    });

    it('.onAppear { … } is NOT an interaction (it is a lifecycle)', () => {
        const fp = 'apps/ios/Lifecycle.swift';
        const snap = mkSnapWith(fp, 'Text("hi").onAppear { load() }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(0);
    });

    it('UIKit .addTarget(self, action: #selector(handleTap), for: .touchUpInside) → interaction:click', () => {
        const fp = 'apps/ios/MyView.swift';
        const snap = mkSnapWith(fp, 'button.addTarget(self, action: #selector(handleTap), for: .touchUpInside)');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-uikit' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBe(1);
        expect(items[0].kind).toBe('interaction:click');
        expect(items[0].handlerName).toBe('handleTap');
    });
});

describe('extractScreenContents — Compose / Android interactions (PR-B)', () => {
    it('Modifier.clickable { … } → interaction:click anonymous', () => {
        const fp = 'apps/android/src/Home.kt';
        const snap = mkSnapWith(fp, 'Box(Modifier.clickable { onClick() }) { Text("x") }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const items = interactions(extractScreenContents(snap, screens));
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items.find((i) => i.label === 'anonymous@clickable')).toBeDefined();
    });

    it('Button(onClick = ::save) → interaction:click with method-ref handlerName', () => {
        const fp = 'apps/android/src/Login.kt';
        const snap = mkSnapWith(fp, 'Button(onClick = ::save) { Text("Save") }');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const click = items.find((i) => i.handlerName === 'save');
        expect(click).toBeDefined();
        expect(click!.kind).toBe('interaction:click');
    });

    it('view.setOnClickListener(::onClick) (XML / legacy) → interaction:click', () => {
        const fp = 'apps/android/src/Detail.kt';
        const snap = mkSnapWith(fp, 'binding.btnSave.setOnClickListener(::onClick)');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-fragment' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const click = items.find((i) => i.kind === 'interaction:click');
        expect(click).toBeDefined();
        expect(click!.handlerName).toBe('onClick');
    });
});

describe('extractScreenContents — Flutter interactions (PR-B)', () => {
    it('onPressed: handler → interaction:pressed', () => {
        const fp = 'apps/flutter/lib/home.dart';
        const snap = mkSnapWith(fp, 'TextButton(onPressed: handleSave, child: Text("Save"))');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const item = items.find((i) => i.kind === 'interaction:pressed');
        expect(item).toBeDefined();
        expect(item!.handlerName).toBe('handleSave');
    });

    it('onTap: () => { … } inline → anonymous label', () => {
        const fp = 'apps/flutter/lib/tap.dart';
        const snap = mkSnapWith(fp, 'GestureDetector(onTap: () => print("tap"), child: Text("X"))');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-goroute' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const tap = items.find((i) => i.kind === 'interaction:tap');
        expect(tap).toBeDefined();
        expect(tap!.handlerName).toBeUndefined();
        expect(tap!.label).toBe('anonymous@onTap');
    });

    it('onChanged: handler → interaction:changed', () => {
        const fp = 'apps/flutter/lib/text.dart';
        const snap = mkSnapWith(fp, 'TextField(onChanged: updateValue)');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const items = interactions(extractScreenContents(snap, screens));
        const change = items.find((i) => i.kind === 'interaction:changed');
        expect(change).toBeDefined();
        expect(change!.handlerName).toBe('updateValue');
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 4 PR-C — Data sources + Lifecycle per framework.
//
// Per-framework coverage focuses on:
//   1. Each detector classifies known hooks / store consumers / lifecycle
//      overrides under the correct section + kind sub-category.
//   2. State-primitive React hooks (useState / useRef / useMemo /
//      useCallback) are intentionally NOT emitted at L2b — these are
//      noise for a screen-level overview. Same for lifecycle vs data
//      disambiguation (useEffect must go to `lifecycle`, useQuery to
//      `data:hook`).
//   3. Anchor line numbers reflect where the call site lives so
//      jump-to-definition lands on the right row.
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — JSX data + lifecycle (PR-C)', () => {
    const fp = 'apps/web/app/page.tsx';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };

    it('useQuery / useSWR / useFetch (fetcher hooks) classify as data:hook', () => {
        const snap = mkSnapWith(fp,
            "import { useQuery } from '@tanstack/react-query';\n" +
            "const x = useQuery({ queryKey: ['a'] });\n" +
            "const y = useSWR('/api/foo');\n" +
            "const z = useFetch('/api/bar');");
        const data = dataItems(extractScreenContents(snap, screens));
        const kinds = data.map((d) => `${d.handlerName}=${d.kind}`).sort();
        expect(kinds).toEqual([
            'useFetch=data:hook',
            'useQuery=data:hook',
            'useSWR=data:hook',
        ]);
    });

    it('useContext / useSelector / useStore classify as data:store', () => {
        const snap = mkSnapWith(fp,
            "const v = useContext(AuthContext);\n" +
            "const u = useSelector((s) => s.user);\n" +
            "const s = useStore();");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data.every((d) => d.kind === 'data:store')).toBe(true);
        expect(data.map((d) => d.handlerName).sort()).toEqual(['useContext', 'useSelector', 'useStore']);
    });

    it('useState / useRef / useMemo / useCallback are NOT data items (state primitives ignored)', () => {
        const snap = mkSnapWith(fp,
            "const [x, setX] = useState(0);\n" +
            "const ref = useRef(null);\n" +
            "const m = useMemo(() => 1, []);\n" +
            "const cb = useCallback(() => {}, []);");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data).toEqual([]);
    });

    it('useEffect classifies as lifecycle, NOT data', () => {
        const snap = mkSnapWith(fp,
            "useEffect(() => { load(); }, []);");
        const result = extractScreenContents(snap, screens);
        expect(dataItems(result)).toEqual([]);
        const life = lifecycleItems(result);
        expect(life.length).toBe(1);
        expect(life[0].kind).toBe('lifecycle:effect');
        expect(life[0].handlerName).toBe('useEffect');
    });

    it('useLayoutEffect + useFocusEffect both produce lifecycle items', () => {
        const snap = mkSnapWith(fp,
            "useLayoutEffect(() => {}, []);\n" +
            "useFocusEffect(() => {});");
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const kinds = life.map((l) => l.kind).sort();
        expect(kinds).toEqual(['lifecycle:focuseffect', 'lifecycle:layouteffect']);
    });
});

describe('extractScreenContents — Vue data + lifecycle (PR-C)', () => {
    const fp = 'apps/web/pages/index.vue';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };

    it('useFetch / useAsyncData are data:hook', () => {
        const snap = mkSnapWith(fp,
            "<script setup>\nconst { data } = await useFetch('/api/foo');\nconst u = useAsyncData('u', () => $fetch('/api/u'));\n</script>");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data.length).toBe(2);
        expect(data.every((d) => d.kind === 'data:hook')).toBe(true);
    });

    it('useStore / storeToRefs are data:store', () => {
        const snap = mkSnapWith(fp,
            "<script setup>\nconst store = useStore();\nconst { user } = storeToRefs(store);\n</script>");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data.every((d) => d.kind === 'data:store')).toBe(true);
    });

    it('inject(key) is data:inject', () => {
        const snap = mkSnapWith(fp,
            "<script setup>\nconst svc = inject('AuthService');\n</script>");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data.length).toBe(1);
        expect(data[0].kind).toBe('data:inject');
    });

    it('onMounted / onUnmounted are lifecycle items', () => {
        const snap = mkSnapWith(fp,
            "<script setup>\nonMounted(() => load());\nonUnmounted(() => cleanup());\n</script>");
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const kinds = life.map((l) => l.kind).sort();
        expect(kinds).toEqual(['lifecycle:mounted', 'lifecycle:unmounted']);
    });
});

describe('extractScreenContents — Svelte data + lifecycle (PR-C)', () => {
    const fp = 'apps/web/src/routes/+page.svelte';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };

    it('$page / $session store usage → data:store items', () => {
        const snap = mkSnapWith(fp,
            "<script>\nimport { page } from '$app/stores';\n$: name = $page.params.id;\nconst s = $session;\n</script>");
        const data = dataItems(extractScreenContents(snap, screens));
        const labels = data.map((d) => d.label).sort();
        expect(labels).toEqual(['$page', '$session']);
    });

    it('getContext("Foo") → data:store', () => {
        const snap = mkSnapWith(fp,
            "<script>\nconst x = getContext('AuthCtx');\n</script>");
        const data = dataItems(extractScreenContents(snap, screens));
        expect(data.length).toBe(1);
        expect(data[0].label).toBe('getContext:AuthCtx');
    });

    it('onMount / onDestroy are lifecycle items', () => {
        const snap = mkSnapWith(fp,
            "<script>\nimport { onMount, onDestroy } from 'svelte';\nonMount(() => {});\nonDestroy(() => {});\n</script>");
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const kinds = life.map((l) => l.kind).sort();
        expect(kinds).toEqual(['lifecycle:destroy', 'lifecycle:mount']);
    });
});

describe('extractScreenContents — SwiftUI + UIKit data + lifecycle (PR-C)', () => {
    it('SwiftUI @StateObject / @ObservedObject / @EnvironmentObject → data:store', () => {
        const fp = 'apps/ios/HomeView.swift';
        const snap = mkSnapWith(fp,
            "struct HomeView: View {\n  @StateObject var vm = HomeViewModel()\n  @ObservedObject var profile: ProfileStore\n  @EnvironmentObject var auth: AuthStore\n  var body: some View { Text(\"x\") }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const data = dataItems(extractScreenContents(snap, screens));
        const labels = data.map((d) => d.label).sort();
        expect(labels).toEqual(['@EnvironmentObject', '@ObservedObject', '@StateObject']);
        expect(data.every((d) => d.kind === 'data:store')).toBe(true);
    });

    it('SwiftUI .onAppear / .task → lifecycle items', () => {
        const fp = 'apps/ios/Lifecycle.swift';
        const snap = mkSnapWith(fp,
            "struct V: View {\n  var body: some View {\n    Text(\"hi\")\n      .onAppear { load() }\n      .task { await fetch() }\n  }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const kinds = life.map((l) => l.kind).sort();
        expect(kinds).toContain('lifecycle:appear');
        expect(kinds).toContain('lifecycle:task');
    });

    it('UIKit viewDidLoad / viewWillAppear overrides → lifecycle items', () => {
        const fp = 'apps/ios/HomeViewController.swift';
        const snap = mkSnapWith(fp,
            "class HomeViewController: UIViewController {\n  override func viewDidLoad() { super.viewDidLoad() }\n  override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated) }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-uikit' }) };
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const labels = life.map((l) => l.label).sort();
        expect(labels).toEqual(['viewDidLoad', 'viewWillAppear']);
    });
});

describe('extractScreenContents — Compose + Android data + lifecycle (PR-C)', () => {
    it('Compose viewModel() / hiltViewModel() / collectAsState() → data:store', () => {
        const fp = 'apps/android/src/Home.kt';
        const snap = mkSnapWith(fp,
            "@Composable\nfun HomeScreen() {\n  val vm: HomeViewModel = viewModel()\n  val cart: CartViewModel = hiltViewModel()\n  val state = vm.uiState.collectAsState()\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const data = dataItems(extractScreenContents(snap, screens));
        const names = data.map((d) => d.handlerName).sort();
        expect(names).toContain('viewModel');
        expect(names).toContain('hiltViewModel');
        expect(names).toContain('collectAsState');
    });

    it('@Inject + by viewModels() Activity delegate → data:inject + data:store', () => {
        const fp = 'apps/android/src/MainActivity.kt';
        const snap = mkSnapWith(fp,
            "class MainActivity : AppCompatActivity() {\n  @Inject lateinit var auth: AuthRepository\n  private val vm: HomeViewModel by viewModels()\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const data = dataItems(extractScreenContents(snap, screens));
        const inject = data.find((d) => d.kind === 'data:inject');
        const delegate = data.find((d) => d.kind === 'data:store' && d.handlerName === 'vm');
        expect(inject).toBeDefined();
        expect(inject!.handlerName).toBe('auth');
        expect(delegate).toBeDefined();
    });

    it('Compose LaunchedEffect / DisposableEffect / SideEffect → lifecycle items', () => {
        const fp = 'apps/android/src/Effects.kt';
        const snap = mkSnapWith(fp,
            "@Composable\nfun S() {\n  LaunchedEffect(Unit) { load() }\n  DisposableEffect(Unit) { onDispose {} }\n  SideEffect { update() }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const labels = life.map((l) => l.label).sort();
        expect(labels).toEqual(['DisposableEffect', 'LaunchedEffect', 'SideEffect']);
    });

    it('Activity onCreate / onResume / onDestroy overrides → lifecycle items', () => {
        const fp = 'apps/android/src/MainActivity.kt';
        const snap = mkSnapWith(fp,
            "class MainActivity : AppCompatActivity() {\n  override fun onCreate(b: Bundle?) {}\n  override fun onResume() {}\n  override fun onDestroy() {}\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const labels = life.map((l) => l.label).sort();
        expect(labels).toEqual(['onCreate', 'onDestroy', 'onResume']);
    });
});

describe('extractScreenContents — Flutter data + lifecycle (PR-C)', () => {
    it('Provider.of / context.watch / Consumer / BlocBuilder / FutureBuilder → data:store', () => {
        const fp = 'apps/flutter/lib/home.dart';
        const snap = mkSnapWith(fp,
            "class HomeWidget extends StatelessWidget {\n  Widget build(BuildContext context) {\n    final auth = Provider.of<AuthService>(context);\n    final cart = context.watch<CartModel>();\n    return Consumer<UserModel>(builder: (_, m, __) => Text(m.name));\n  }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const data = dataItems(extractScreenContents(snap, screens));
        const labels = data.map((d) => d.label).sort();
        expect(labels).toContain('Provider.of');
        expect(labels).toContain('context.watch');
        expect(labels).toContain('Consumer');
    });

    it('Riverpod ref.watch / ref.read → data:store', () => {
        const fp = 'apps/flutter/lib/profile.dart';
        const snap = mkSnapWith(fp,
            "class Profile extends ConsumerWidget {\n  Widget build(BuildContext context, WidgetRef ref) {\n    final user = ref.watch(userProvider);\n    final repo = ref.read(repoProvider);\n    return Text(user.name);\n  }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-goroute' }) };
        const data = dataItems(extractScreenContents(snap, screens));
        const labels = data.map((d) => d.label).sort();
        expect(labels).toContain('ref.watch');
        expect(labels).toContain('ref.read');
    });

    it('Flutter initState / dispose / didChangeDependencies → lifecycle items', () => {
        const fp = 'apps/flutter/lib/home.dart';
        const snap = mkSnapWith(fp,
            "class _S extends State<Home> {\n  @override void initState() { super.initState(); }\n  @override void dispose() { super.dispose(); }\n  @override void didChangeDependencies() { super.didChangeDependencies(); }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const life = lifecycleItems(extractScreenContents(snap, screens));
        const labels = life.map((l) => l.label).sort();
        expect(labels).toEqual(['didChangeDependencies', 'dispose', 'initState']);
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 4 PR-D — Nav-out + Nav-in per framework.
//
// Coverage focus:
//   1. Each framework's primary nav-out shapes (link tags, push calls,
//      navigate / segue / present / startActivity / Navigator.push) are
//      detected with the right kind + route.
//   2. External anchors (http://, mailto:) and same-page anchors (#)
//      do NOT count as in-app navigation (negative test).
//   3. Built-in Flutter widgets in Navigator.push builders are
//      filtered (matches the PR-D screen-detector filter).
//   4. Nav-in items come from the snapshot's apiIndex, NOT from the
//      screen file directly — DEEP_LINK / PUSH_HANDLER records
//      attached to the same filePath surface as nav-in items.
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — JSX nav-out (PR-D)', () => {
    const fp = 'apps/web/app/page.tsx';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };

    it('<Link to="/dashboard"> → nav-out:link with route /dashboard', () => {
        const snap = mkSnapWith(fp, "import Link from 'next/link';\n<Link to=\"/dashboard\">Go</Link>");
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.length).toBe(1);
        expect(nav[0].kind).toBe('nav-out:link');
        expect(nav[0].route).toBe('/dashboard');
    });

    it('<a href="/internal"> → nav-out:link; external https URL is ignored', () => {
        const snap = mkSnapWith(fp, '<a href="/profile">x</a>\n<a href="https://google.com">y</a>\n<a href="mailto:hi@x.com">z</a>');
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.length).toBe(1);
        expect(nav[0].route).toBe('/profile');
    });

    it('router.push("/foo") → nav-out:push', () => {
        const snap = mkSnapWith(fp, "router.push('/admin');");
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.length).toBe(1);
        expect(nav[0].kind).toBe('nav-out:push');
        expect(nav[0].route).toBe('/admin');
    });

    it('navigate("/foo") from useNavigate → nav-out:navigate', () => {
        const snap = mkSnapWith(fp, "const navigate = useNavigate();\nnavigate('/login');");
        const nav = navOutItems(extractScreenContents(snap, screens));
        const navigated = nav.find((i) => i.kind === 'nav-out:navigate' && i.route === '/login');
        expect(navigated).toBeDefined();
    });
});

// BUG-FE-NEXTJS-SCREEN-CONTENT (2026-07-19): Next.js App Router server-side
// nav-out (`redirect`/`notFound`/`permanentRedirect` from `next/navigation`)
// and Next.js `<Link href>` were under-detected — real App Router screens
// showed "Navigation out (0)" even when they navigate.
describe('extractScreenContents — Next.js App Router nav-out (BUG-FE-NEXTJS-SCREEN-CONTENT)', () => {
    const fp = 'apps/web/src/app/(checkout)/checkout/[clientSecret]/page.tsx';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };

    it('redirect("/login") + notFound() + <Link href="/dashboard"> detected; external <Link> ignored', () => {
        const content = [
            "import { redirect, notFound } from 'next/navigation';",
            "import Link from 'next/link';",
            "export default async function Page({ params }) {",
            "  if (!params.ok) redirect('/login');",
            "  if (!params.found) notFound();",
            "  return (<div>",
            "    <Link href=\"/dashboard\">Dashboard</Link>",
            "    <Link href=\"https://x.com\">External</Link>",
            "  </div>);",
            "}",
        ].join('\n');
        const snap = mkSnapWith(fp, content);
        const nav = navOutItems(extractScreenContents(snap, screens));

        const redir = nav.find((i) => i.kind === 'nav-out:redirect' && i.route === '/login');
        expect(redir).toBeDefined();

        const notFoundItem = nav.find((i) => i.kind === 'nav-out:not-found');
        expect(notFoundItem).toBeDefined();

        const dashboardLink = nav.find((i) => i.kind === 'nav-out:link' && i.route === '/dashboard');
        expect(dashboardLink).toBeDefined();

        // External <Link href="https://…"> must NOT be a nav-out item.
        expect(nav.some((i) => i.route === 'https://x.com')).toBe(false);
    });

    it('permanentRedirect("/new") from next/navigation → nav-out:redirect', () => {
        const content = [
            "import { permanentRedirect } from 'next/navigation';",
            "export default function Page() { permanentRedirect('/new'); }",
        ].join('\n');
        const snap = mkSnapWith(fp, content);
        const nav = navOutItems(extractScreenContents(snap, screens));
        const redir = nav.find((i) => i.kind === 'nav-out:redirect' && i.route === '/new');
        expect(redir).toBeDefined();
    });

    it('redirect()/notFound() are ignored when next/navigation is NOT imported (avoids false positives)', () => {
        // A local `redirect` helper unrelated to Next.js must not be picked up.
        const content = [
            "function redirect(x) { return x; }",
            "redirect('/nope');",
        ].join('\n');
        const snap = mkSnapWith(fp, content);
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.some((i) => i.kind === 'nav-out:redirect')).toBe(false);
    });
});

describe('extractScreenContents — Vue nav-out (PR-D)', () => {
    const fp = 'apps/web/pages/home.vue';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };

    it('<NuxtLink to="/foo"> → nav-out:link', () => {
        const snap = mkSnapWith(fp, '<NuxtLink to="/about">About</NuxtLink>');
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.length).toBe(1);
        expect(nav[0].route).toBe('/about');
    });

    it('router.push("/foo") → nav-out:push', () => {
        const snap = mkSnapWith(fp, "<script setup>\nconst router = useRouter();\nrouter.push('/profile');\n</script>");
        const nav = navOutItems(extractScreenContents(snap, screens));
        const push = nav.find((i) => i.kind === 'nav-out:push' && i.route === '/profile');
        expect(push).toBeDefined();
    });
});

describe('extractScreenContents — Svelte nav-out (PR-D)', () => {
    const fp = 'apps/web/src/routes/+page.svelte';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };

    it('<a href="/foo"> → nav-out:link', () => {
        const snap = mkSnapWith(fp, '<a href="/dashboard">Dashboard</a>');
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.length).toBe(1);
        expect(nav[0].route).toBe('/dashboard');
    });

    it('goto("/foo") from $app/navigation → nav-out:goto', () => {
        const snap = mkSnapWith(fp, "import { goto } from '$app/navigation';\ngoto('/admin');");
        const nav = navOutItems(extractScreenContents(snap, screens));
        const gotoItem = nav.find((i) => i.kind === 'nav-out:goto');
        expect(gotoItem).toBeDefined();
        expect(gotoItem!.route).toBe('/admin');
    });
});

describe('extractScreenContents — SwiftUI / UIKit nav-out (PR-D)', () => {
    it('NavigationLink(destination: ProfileView()) → nav-out:link', () => {
        const fp = 'apps/ios/Home.swift';
        const snap = mkSnapWith(fp,
            "struct HomeView: View { var body: some View { NavigationLink(destination: ProfileView()) { Text(\"Profile\") } } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:link' && i.route === 'ProfileView')).toBeDefined();
    });

    it('dismiss() → nav-out:dismiss', () => {
        const fp = 'apps/ios/Modal.swift';
        const snap = mkSnapWith(fp,
            "struct ModalView: View {\n  @Environment(\\.dismiss) var dismiss\n  var body: some View { Button(\"Close\") { dismiss() } }\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:dismiss')).toBeDefined();
    });

    it('UIKit pushViewController(vc) → nav-out:push', () => {
        const fp = 'apps/ios/Detail.swift';
        const snap = mkSnapWith(fp,
            "class DetailVC: UIViewController { func go() { navigationController?.pushViewController(NextVC(), animated: true) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-uikit' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:push' && i.route === 'NextVC')).toBeDefined();
    });

    it('UIKit performSegue(withIdentifier: "showDetail") → nav-out:segue', () => {
        const fp = 'apps/ios/List.swift';
        const snap = mkSnapWith(fp,
            "class ListVC: UIViewController { func tap() { performSegue(withIdentifier: \"showDetail\", sender: self) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-uikit' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:segue' && i.route === 'showDetail')).toBeDefined();
    });
});

describe('extractScreenContents — Compose / Android nav-out (PR-D)', () => {
    it('navController.navigate("home") → nav-out:navigate', () => {
        const fp = 'apps/android/Nav.kt';
        const snap = mkSnapWith(fp,
            "@Composable\nfun App() {\n  val navController = rememberNavController()\n  Button(onClick = { navController.navigate(\"home\") }) {}\n}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:navigate' && i.route === 'home')).toBeDefined();
    });

    it('navController.popBackStack() → nav-out:pop', () => {
        const fp = 'apps/android/Back.kt';
        const snap = mkSnapWith(fp, "navController.popBackStack()");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:pop')).toBeDefined();
    });

    it('startActivity(Intent(this, NextActivity::class.java)) → nav-out:start-activity', () => {
        const fp = 'apps/android/Home.kt';
        const snap = mkSnapWith(fp,
            "class MainActivity : AppCompatActivity() { fun go() { startActivity(Intent(this, NextActivity::class.java)) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:start-activity' && i.route === 'NextActivity')).toBeDefined();
    });
});

describe('extractScreenContents — Flutter nav-out (PR-D)', () => {
    it('Navigator.pushNamed(context, "/profile") → nav-out:pushNamed', () => {
        const fp = 'apps/flutter/home.dart';
        const snap = mkSnapWith(fp, "Navigator.pushNamed(context, '/profile');");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:pushNamed' && i.route === '/profile')).toBeDefined();
    });

    it('Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen())) → nav-out:push', () => {
        const fp = 'apps/flutter/home.dart';
        const snap = mkSnapWith(fp,
            "Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen()));");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:push' && i.route === 'DetailScreen')).toBeDefined();
    });

    it('Navigator.push(... builder: (_) => Container()) is filtered (built-in widget)', () => {
        const fp = 'apps/flutter/home.dart';
        const snap = mkSnapWith(fp,
            "Navigator.push(context, MaterialPageRoute(builder: (_) => Container()));");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.filter((i) => i.kind === 'nav-out:push')).toEqual([]);
    });

    it('context.go("/admin") (GoRouter) → nav-out:go', () => {
        const fp = 'apps/flutter/home.dart';
        const snap = mkSnapWith(fp, "context.go('/admin');");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-goroute' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:go' && i.route === '/admin')).toBeDefined();
    });

    it('context.pop() → nav-out:pop', () => {
        const fp = 'apps/flutter/detail.dart';
        const snap = mkSnapWith(fp, "context.pop();");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-goroute' }) };
        const nav = navOutItems(extractScreenContents(snap, screens));
        expect(nav.find((i) => i.kind === 'nav-out:pop')).toBeDefined();
    });
});

describe('extractScreenContents — nav-in via apiIndex (PR-D)', () => {
    it('DEEP_LINK ApiRecord on same filePath becomes a nav-in item', () => {
        const fp = 'apps/android/MainActivity.kt';
        const snap: Snapshot = {
            files: {
                [fp]: { path: fp, hash: 'h', mtime: 0, content: 'class MainActivity : AppCompatActivity() {}', symbols: { functions: [], variables: [], imports: [] } },
            },
            apiIndex: {
                'd1': {
                    apiId: 'd1', method: 'DEEP_LINK', route: '/profile/:id',
                    handlerName: 'MainActivity', filePath: fp,
                    anchor: { filePath: fp, lineStart: 1, lineEnd: 1 },
                },
            },
            graphs: {},
        };
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const navIn = navInItems(extractScreenContents(snap, screens));
        expect(navIn.length).toBe(1);
        expect(navIn[0].kind).toBe('nav-in:deep-link');
        expect(navIn[0].route).toBe('/profile/:id');
    });

    it('PUSH_HANDLER on same filePath becomes nav-in:push-handler', () => {
        const fp = 'apps/android/PushService.kt';
        const snap: Snapshot = {
            files: { [fp]: { path: fp, hash: 'h', mtime: 0, content: 'x', symbols: { functions: [], variables: [], imports: [] } } },
            apiIndex: {
                'p1': {
                    apiId: 'p1', method: 'PUSH_HANDLER', route: 'fcm:default',
                    handlerName: 'PushService', filePath: fp,
                    anchor: { filePath: fp, lineStart: 1, lineEnd: 1 },
                },
            },
            graphs: {},
        };
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const navIn = navInItems(extractScreenContents(snap, screens));
        expect(navIn.length).toBe(1);
        expect(navIn[0].kind).toBe('nav-in:push-handler');
    });

    it('DEEP_LINK ApiRecord on a DIFFERENT file is not attached to this screen', () => {
        const fp = 'apps/android/MainActivity.kt';
        const otherFp = 'apps/android/OtherActivity.kt';
        const snap: Snapshot = {
            files: {
                [fp]: { path: fp, hash: 'h', mtime: 0, content: 'x', symbols: { functions: [], variables: [], imports: [] } },
                [otherFp]: { path: otherFp, hash: 'h', mtime: 0, content: 'x', symbols: { functions: [], variables: [], imports: [] } },
            },
            apiIndex: {
                'd1': { apiId: 'd1', method: 'DEEP_LINK', route: '/foo', handlerName: 'Other', filePath: otherFp, anchor: { filePath: otherFp, lineStart: 1, lineEnd: 1 } },
            },
            graphs: {},
        };
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const navIn = navInItems(extractScreenContents(snap, screens));
        expect(navIn).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 4 PR-E — Visual inventory classifier.
//
// Coverage focus:
//   1. Each known element name resolves to the right `VisualElementKind`
//      (Button / Input / List / Label / Image / Form / Layout / Divider /
//      Indicator / Modal / Custom).
//   2. Duplicate occurrences of the same element produce ONE aggregate
//      item with `label: 'Name × N'` — keeps the snapshot bounded on
//      large screens.
//   3. PascalCase non-primitive elements fall through to `'custom'` so
//      user components are visible in the inventory.
//   4. Common type constructors (String(...), Int(...)) are NOT
//      misclassified as views.
//   5. HTML reserved tags (<script>, <style>, <meta>) never count as
//      visual items.
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — JSX visual classifier (PR-E)', () => {
    const fp = 'apps/web/app/page.tsx';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };

    it('classifies <button>, <input>, <ul>, <img>, <hr>, <Modal> into the right kinds', () => {
        const snap = mkSnapWith(fp,
            '<div><button>Save</button><input /><ul><li>x</li></ul><img src="x" /><hr /><Modal /></div>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const byKind: Record<string, string[]> = {};
        for (const v of visual) {
            const k = v.visualKind ?? '?';
            (byKind[k] ??= []).push(v.label);
        }
        expect(byKind.button).toContain('button');
        expect(byKind.input).toContain('input');
        expect(byKind.list).toContain('ul');
        expect(byKind.image).toContain('img');
        expect(byKind.divider).toContain('hr');
        expect(byKind.modal).toContain('Modal');
    });

    it('aggregates duplicates into one item with × N count', () => {
        const snap = mkSnapWith(fp,
            '<div><button>A</button><button>B</button><button>C</button></div>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const btn = visual.find((v) => v.visualKind === 'button');
        expect(btn).toBeDefined();
        expect(btn!.label).toBe('button × 3');
    });

    it('PascalCase non-primitive component → custom kind', () => {
        const snap = mkSnapWith(fp, '<div><LoginForm /><UserAvatar /></div>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const customs = visual.filter((v) => v.visualKind === 'custom').map((v) => v.label).sort();
        expect(customs).toEqual(['LoginForm', 'UserAvatar']);
    });

    it('HTML reserved tags (<script>, <style>) are NOT visual items', () => {
        const snap = mkSnapWith(fp,
            '<div><script>alert("x")</script><style>{`p{color:red}`}</style></div>');
        const visual = visualItems(extractScreenContents(snap, screens));
        expect(visual.filter((v) => v.label === 'script' || v.label === 'style')).toEqual([]);
    });

    it('React Native primitives (<View>, <Text>, <Image>, <TouchableOpacity>) classify correctly', () => {
        const fpRN = 'apps/mobile/screens/Home.tsx';
        const snap = mkSnapWith(fpRN,
            'export default function Home() { return <View><Text>Hi</Text><Image source={src} /><TouchableOpacity onPress={x}><Text>Go</Text></TouchableOpacity></View>; }');
        const rn = { s: mkScreen({ screenId: 's', filePath: fpRN, framework: 'react-native-nav' }) };
        const visual = visualItems(extractScreenContents(snap, rn));
        const kindByName = Object.fromEntries(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kindByName['View']).toBe('layout');
        expect(kindByName['Text']).toBe('label');
        expect(kindByName['Image']).toBe('image');
        expect(kindByName['TouchableOpacity']).toBe('button');
    });
});

// #485-VISUAL (2026-06-07) — Vue + Svelte visual classifier wiring.
// Before this PR the Vue/Svelte branches reused `extractJsxVisual` and
// the JSX-only inline table, which knows nothing about Vuetify
// (`v-btn`), Element Plus (`el-button`), Naive UI (`n-button`), Quasar
// (`q-btn`), or Svelte's `<svelte:component>` / `<svelte:fragment>`
// specials. Every component-library element collapsed into the
// `custom` bucket. The standalone classifier modules
// (`visualElementClassifier/{vue,svelte}.ts`) cover them; this regression
// suite locks the wiring that bridges PascalCase → lowercase kinds.
describe('extractScreenContents — Vue component-library visual classifier (#485-VISUAL)', () => {
    const fp = 'apps/web/pages/index.vue';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nuxt' }) };

    it('Vuetify <v-btn>, <v-text-field>, <v-card> classify into button / input / layout', () => {
        const snap = mkSnapWith(fp,
            '<template><v-card><v-text-field /><v-btn>Save</v-btn></v-card></template>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const byName = Object.fromEntries(visual.map(v => [v.label.split(' ')[0], v.visualKind]));
        expect(byName['v-btn']).toBe('button');
        expect(byName['v-text-field']).toBe('input');
        expect(byName['v-card']).toBe('layout');
    });

    it('Element Plus <el-button>, <el-input>, <el-form> classify correctly', () => {
        const snap = mkSnapWith(fp,
            '<template><el-form><el-input /><el-button>Submit</el-button></el-form></template>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const byName = Object.fromEntries(visual.map(v => [v.label.split(' ')[0], v.visualKind]));
        expect(byName['el-button']).toBe('button');
        expect(byName['el-input']).toBe('input');
        expect(byName['el-form']).toBe('form');
    });

    it('an unknown PascalCase Vue component still lands in custom', () => {
        const snap = mkSnapWith(fp, '<template><MyOwnWidget /></template>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const widget = visual.find(v => v.label.startsWith('MyOwnWidget'));
        expect(widget?.visualKind).toBe('custom');
    });
});

describe('extractScreenContents — Svelte visual classifier (#485-VISUAL)', () => {
    const fp = 'apps/web/src/routes/+page.svelte';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'sveltekit' }) };

    it('honors standard HTML primitives even on Svelte files', () => {
        const snap = mkSnapWith(fp,
            '<button>X</button><input type="text" /><ul><li>a</li></ul>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const byName = Object.fromEntries(visual.map(v => [v.label.split(' ')[0], v.visualKind]));
        expect(byName['button']).toBe('button');
        expect(byName['input']).toBe('input');
        expect(byName['ul']).toBe('list');
    });

    it('treats Svelte specials (<svelte:component>) as scaffolding — NOT visual items', () => {
        // Per `classifySvelteElement` design: svelte:* specials are
        // structural directives, not user-facing widgets. They get
        // filtered out of the visual inventory so the section stays
        // signal-rich rather than buried under template helpers.
        const snap = mkSnapWith(fp,
            '<svelte:component this={CurrentTab} /><svelte:fragment>x</svelte:fragment><button>Save</button>');
        const visual = visualItems(extractScreenContents(snap, screens));
        const sc = visual.find(v => v.label.includes('svelte:'));
        expect(sc).toBeUndefined();
        // Sanity: the surrounding <button> is still emitted.
        expect(visual.find(v => v.label.startsWith('button'))?.visualKind).toBe('button');
    });
});

describe('extractScreenContents — SwiftUI visual classifier (PR-E)', () => {
    const fp = 'apps/ios/Home.swift';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };

    it('VStack / HStack / Text / Button / TextField classify as layout / label / button / input', () => {
        const snap = mkSnapWith(fp,
            "struct HomeView: View {\n  var body: some View {\n    VStack {\n      Text(\"Hello\")\n      Button(\"Save\") {}\n      TextField(\"Name\", text: $name)\n      HStack { Text(\"x\") }\n    }\n  }\n}");
        const visual = visualItems(extractScreenContents(snap, screens));
        const kinds = new Map(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kinds.get('VStack')).toBe('layout');
        expect(kinds.get('HStack')).toBe('layout');
        expect(kinds.get('Text')).toBe('label');
        expect(kinds.get('Button')).toBe('button');
        expect(kinds.get('TextField')).toBe('input');
    });

    it('built-in Swift type constructors (String, Int) are NOT visual items', () => {
        const snap = mkSnapWith(fp,
            "struct V: View { var body: some View { Text(String(42)) } }");
        const visual = visualItems(extractScreenContents(snap, screens));
        expect(visual.find((v) => v.label === 'String')).toBeUndefined();
        expect(visual.find((v) => v.label === 'Int')).toBeUndefined();
    });
});

describe('extractScreenContents — Compose visual classifier (PR-E)', () => {
    const fp = 'apps/android/src/Home.kt';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };

    it('Column / Row / Box / Text / Button / TextField classify correctly', () => {
        const snap = mkSnapWith(fp,
            "@Composable\nfun HomeScreen() {\n  Column {\n    Text(\"Hello\")\n    Button(onClick = {}) { Text(\"Save\") }\n    Row { TextField(value = name, onValueChange = {}) }\n    Box {}\n  }\n}");
        const visual = visualItems(extractScreenContents(snap, screens));
        const kinds = new Map(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kinds.get('Column')).toBe('layout');
        expect(kinds.get('Row')).toBe('layout');
        expect(kinds.get('Box')).toBe('layout');
        expect(kinds.get('Text')).toBe('label');
        expect(kinds.get('Button')).toBe('button');
        expect(kinds.get('TextField')).toBe('input');
    });

    it('LazyColumn / LazyRow classify as list', () => {
        const snap = mkSnapWith(fp,
            "@Composable\nfun L() { LazyColumn { item { Text(\"x\") } } }");
        const visual = visualItems(extractScreenContents(snap, screens));
        const lazy = visual.find((v) => v.label.startsWith('LazyColumn'));
        expect(lazy).toBeDefined();
        expect(lazy!.visualKind).toBe('list');
    });

    it('CircularProgressIndicator → indicator; AlertDialog → modal', () => {
        const snap = mkSnapWith(fp,
            "@Composable\nfun L() {\n  CircularProgressIndicator()\n  AlertDialog(onDismissRequest = {}, confirmButton = {})\n}");
        const visual = visualItems(extractScreenContents(snap, screens));
        const ind = visual.find((v) => v.label.startsWith('CircularProgressIndicator'));
        const modal = visual.find((v) => v.label.startsWith('AlertDialog'));
        expect(ind!.visualKind).toBe('indicator');
        expect(modal!.visualKind).toBe('modal');
    });
});

describe('extractScreenContents — Flutter visual classifier (PR-E)', () => {
    const fp = 'apps/flutter/lib/home.dart';
    const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };

    it('Container / Column / Row / Text / ElevatedButton classify correctly', () => {
        const snap = mkSnapWith(fp,
            "class Home extends StatelessWidget {\n  Widget build(BuildContext context) {\n    return Container(child: Column(children: [\n      Text('Hi'),\n      ElevatedButton(onPressed: save, child: Text('Save')),\n      Row(children: [Text('a')]),\n    ]));\n  }\n}");
        const visual = visualItems(extractScreenContents(snap, screens));
        const kinds = new Map(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kinds.get('Container')).toBe('layout');
        expect(kinds.get('Column')).toBe('layout');
        expect(kinds.get('Row')).toBe('layout');
        expect(kinds.get('Text')).toBe('label');
        expect(kinds.get('ElevatedButton')).toBe('button');
    });

    it('ListView / GridView → list; Image → image; Divider → divider', () => {
        const snap = mkSnapWith(fp,
            "Widget build(BuildContext c) {\n  return Column(children: [\n    Image(image: AssetImage('x')),\n    ListView(),\n    GridView(),\n    Divider(),\n  ]);\n}");
        const visual = visualItems(extractScreenContents(snap, screens));
        const kinds = new Map(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kinds.get('ListView')).toBe('list');
        expect(kinds.get('GridView')).toBe('list');
        expect(kinds.get('Image')).toBe('image');
        expect(kinds.get('Divider')).toBe('divider');
    });

    it('PascalCase user widget (HomeCard) falls through to custom', () => {
        const snap = mkSnapWith(fp,
            "Widget build(BuildContext c) { return HomeCard(); }");
        const visual = visualItems(extractScreenContents(snap, screens));
        const custom = visual.find((v) => v.label.startsWith('HomeCard'));
        expect(custom!.visualKind).toBe('custom');
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 7 PR-A — library-component coverage polish.
//
// Phase 4 PR-E already shipped per-framework primitive recognition.
// Phase 7 extends the lookup tables with the most-used component
// libraries so users of Material UI / shadcn / Material 3 / Cupertino
// see real component kinds in the L2b Visual section instead of the
// `custom` fallback.
//
// Coverage focus:
//   1. Material UI primitives in a JSX screen classify into the right
//      kinds (Button → button, TextField → input, Typography → label,
//      Box / Container / Stack → layout, CircularProgress → indicator).
//   2. shadcn / Radix wrappers (AlertDialog → modal, Sheet → modal,
//      Tabs → layout) classify correctly.
//   3. Chakra UI layout primitives (Flex / HStack / VStack / Wrap)
//      classify as layout.
//   4. Material 3 Compose extras (Chip family, SearchBar, Badge)
//      classify correctly.
//   5. Cupertino + extended Flutter widgets (CupertinoButton,
//      CupertinoSwitch, SafeArea, Expanded, CupertinoActivityIndicator)
//      classify correctly.
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — visual classifier polish (PR-A phase 7)', () => {
    function classifyMap(result: Record<string, L2bScreenItem[]>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const item of Object.values(result).flat()) {
            if (item.section !== 'visual') continue;
            const name = item.label.split(' ')[0];  // strip " × N"
            out[name] = item.visualKind ?? '?';
        }
        return out;
    }

    it('Material UI: Button / TextField / Typography / Box / CircularProgress classify into native kinds', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp,
            `<Box>\n` +
            `  <Container>\n` +
            `    <Stack>\n` +
            `      <Typography>Hi</Typography>\n` +
            `      <TextField label="Name" />\n` +
            `      <Button>Save</Button>\n` +
            `      <CircularProgress />\n` +
            `    </Stack>\n` +
            `  </Container>\n` +
            `</Box>`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Box']).toBe('layout');
        expect(kinds['Container']).toBe('layout');
        expect(kinds['Stack']).toBe('layout');
        expect(kinds['Typography']).toBe('label');
        expect(kinds['TextField']).toBe('input');
        expect(kinds['Button']).toBe('button');
        expect(kinds['CircularProgress']).toBe('indicator');
    });

    it('Material UI: Dialog / Drawer / Snackbar classify as modal / modal / indicator', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, `<>\n  <Dialog />\n  <Drawer />\n  <Snackbar />\n  <Popover />\n</>`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Dialog']).toBe('modal');
        expect(kinds['Drawer']).toBe('modal');
        expect(kinds['Snackbar']).toBe('indicator');
        expect(kinds['Popover']).toBe('modal');
    });

    it('shadcn / Radix: AlertDialog / Sheet / Tabs classify correctly', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, `<>\n  <AlertDialog />\n  <Sheet />\n  <Tabs />\n</>`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['AlertDialog']).toBe('modal');
        expect(kinds['Sheet']).toBe('modal');
        expect(kinds['Tabs']).toBe('layout');
    });

    it('Chakra: Flex / HStack / VStack / Wrap / Heading classify as layout / layout / layout / layout / label', () => {
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, `<Flex><HStack><VStack><Wrap><Heading>Hi</Heading></Wrap></VStack></HStack></Flex>`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Flex']).toBe('layout');
        expect(kinds['HStack']).toBe('layout');
        expect(kinds['VStack']).toBe('layout');
        expect(kinds['Wrap']).toBe('layout');
        expect(kinds['Heading']).toBe('label');
    });

    it('Material 3 Compose: Chip / SearchBar / Badge / NavigationBar classify correctly', () => {
        const fp = 'apps/android/src/Home.kt';
        const snap = mkSnapWith(fp,
            `@Composable\nfun HomeScreen() {\n` +
            `  Chip(onClick = {}) { Text("x") }\n` +
            `  SearchBar(query = "")\n` +
            `  Badge { Text("3") }\n` +
            `  NavigationBar { /* … */ }\n` +
            `  SuggestionChip(onClick = {}) { Text("y") }\n` +
            `}`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Chip']).toBe('button');
        expect(kinds['SearchBar']).toBe('input');
        expect(kinds['Badge']).toBe('indicator');
        expect(kinds['NavigationBar']).toBe('layout');
        expect(kinds['SuggestionChip']).toBe('button');
    });

    it('SwiftUI: Link / Stepper / Slider / NavigationSplitView / TabView classify correctly', () => {
        const fp = 'apps/ios/Home.swift';
        const snap = mkSnapWith(fp,
            `struct HomeView: View {\n  var body: some View {\n` +
            `    NavigationSplitView {\n` +
            `      TabView {\n` +
            `        Link("Go", destination: URL(string: "x")!)\n` +
            `        Stepper("Count", value: $count)\n` +
            `        Slider(value: $vol)\n` +
            `      }\n` +
            `    }\n` +
            `  }\n` +
            `}`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'ios-swiftui' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Link']).toBe('button');
        expect(kinds['Stepper']).toBe('input');
        expect(kinds['Slider']).toBe('input');
        expect(kinds['NavigationSplitView']).toBe('layout');
        expect(kinds['TabView']).toBe('layout');
    });

    it('Flutter Cupertino: CupertinoButton / CupertinoSwitch / CupertinoActivityIndicator / CupertinoAlertDialog classify correctly', () => {
        const fp = 'apps/flutter/lib/home.dart';
        const snap = mkSnapWith(fp,
            `class Home extends StatelessWidget {\n  Widget build(BuildContext c) {\n` +
            `    return CupertinoPageScaffold(\n` +
            `      child: Column(children: [\n` +
            `        CupertinoButton(onPressed: () {}, child: Text("Tap")),\n` +
            `        CupertinoSwitch(value: x, onChanged: (_) {}),\n` +
            `        CupertinoActivityIndicator(),\n` +
            `        CupertinoAlertDialog(),\n` +
            `      ]),\n` +
            `    );\n` +
            `  }\n` +
            `}`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['CupertinoPageScaffold']).toBe('layout');
        expect(kinds['CupertinoButton']).toBe('button');
        expect(kinds['CupertinoSwitch']).toBe('input');
        expect(kinds['CupertinoActivityIndicator']).toBe('indicator');
        expect(kinds['CupertinoAlertDialog']).toBe('modal');
    });

    it('Flutter extended layout: Expanded / Flexible / Center / SafeArea / Padding classify as layout', () => {
        const fp = 'apps/flutter/lib/layout.dart';
        const snap = mkSnapWith(fp,
            `Widget build(BuildContext c) {\n` +
            `  return SafeArea(\n` +
            `    child: Center(\n` +
            `      child: Padding(\n` +
            `        padding: EdgeInsets.all(8),\n` +
            `        child: Column(children: [\n` +
            `          Expanded(child: Text("a")),\n` +
            `          Flexible(child: Text("b")),\n` +
            `        ]),\n` +
            `      ),\n` +
            `    ),\n` +
            `  );\n` +
            `}`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'flutter-material-page-route' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        for (const layout of ['SafeArea', 'Center', 'Padding', 'Column', 'Expanded', 'Flexible']) {
            expect(kinds[layout], `${layout}=${kinds[layout]}`).toBe('layout');
        }
    });

    it('library coverage does NOT touch the `custom` fallback for actually unknown components', () => {
        // PascalCase non-primitive components NOT in any catalog still
        // bucket to `custom` (so users see their own components).
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, `<Box><LoginForm /><CustomWidget /></Box>`);
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const kinds = classifyMap(extractScreenContents(snap, screens));
        expect(kinds['Box']).toBe('layout');
        expect(kinds['LoginForm']).toBe('custom');
        expect(kinds['CustomWidget']).toBe('custom');
    });
});

describe('extractScreenContents — framework cross-contamination (PR-B)', () => {
    it('Vue @click in a Next.js framework screen is ignored (wrong dispatcher)', () => {
        // A .tsx file labelled as nextjs-app but containing Vue syntax
        // somewhere (e.g. inside a string) must not match the Vue
        // interaction regex.
        const fp = 'apps/web/app/page.tsx';
        const snap = mkSnapWith(fp, 'export const docs = "<button @click=\\"save\\">x</button>";');
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'nextjs-app' }) };
        const items = interactions(extractScreenContents(snap, screens));
        // No JSX onClick={...} = empty interaction set.
        expect(items.length).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 follow-up #718 — Android XML layout visual classifier.
//
// Classic Activity / Fragment screens drive their UI from
// `res/layout/X.xml` files, not Compose calls. The extractor walks
// the Kotlin source for `setContentView(R.layout.X)` /
// `inflate(R.layout.X, …)` references, resolves the matching XML
// (via the supplied resolver), and merges primitive tags into the
// visual section. Compose-only Activities don't reference R.layout
// and get no XML items (their Compose calls already supply visual
// rows).
// ─────────────────────────────────────────────────────────────────────

describe('extractScreenContents — Android XML layout classifier (#718)', () => {
    it('setContentView(R.layout.activity_main) + activity_main.xml → button/label/input items', () => {
        const fp = 'apps/android/MainActivity.kt';
        const snap = mkSnapWith(fp,
            "class MainActivity : AppCompatActivity() {\n" +
            "  override fun onCreate(b: Bundle?) {\n" +
            "    super.onCreate(b)\n" +
            "    setContentView(R.layout.activity_main)\n" +
            "  }\n" +
            "}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const xml: Record<string, string> = {
            'activity_main':
                `<?xml version="1.0" encoding="utf-8"?>\n` +
                `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:orientation="vertical">\n` +
                `  <TextView android:text="Hello" />\n` +
                `  <EditText android:hint="Name" />\n` +
                `  <Button android:text="Save" />\n` +
                `</LinearLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result);
        const kindByName = Object.fromEntries(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kindByName['LinearLayout']).toBe('layout');
        expect(kindByName['TextView']).toBe('label');
        expect(kindByName['EditText']).toBe('input');
        expect(kindByName['Button']).toBe('button');
    });

    it('fragment inflate(R.layout.fragment_home, …) → matching XML walked', () => {
        const fp = 'apps/android/HomeFragment.kt';
        const snap = mkSnapWith(fp,
            "class HomeFragment : Fragment() {\n" +
            "  override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {\n" +
            "    return i.inflate(R.layout.fragment_home, c, false)\n" +
            "  }\n" +
            "}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-fragment' }) };
        const xml: Record<string, string> = {
            'fragment_home':
                `<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android">\n` +
                `  <RecyclerView android:id="@+id/list" />\n` +
                `  <ProgressBar android:visibility="gone" />\n` +
                `</FrameLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result);
        const kindByName = Object.fromEntries(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kindByName['FrameLayout']).toBe('layout');
        expect(kindByName['RecyclerView']).toBe('list');
        expect(kindByName['ProgressBar']).toBe('indicator');
    });

    it('fully-qualified XML tag (androidx.constraintlayout.widget.ConstraintLayout) normalizes to simple name', () => {
        const fp = 'apps/android/DetailActivity.kt';
        const snap = mkSnapWith(fp,
            "class DetailActivity : AppCompatActivity() { override fun onCreate(b: Bundle?) { setContentView(R.layout.activity_detail) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const xml: Record<string, string> = {
            'activity_detail':
                `<androidx.constraintlayout.widget.ConstraintLayout xmlns:android="http://schemas.android.com/apk/res/android">\n` +
                `  <com.google.android.material.button.MaterialButton android:text="Go" />\n` +
                `  <com.google.android.material.textfield.TextInputEditText />\n` +
                `</androidx.constraintlayout.widget.ConstraintLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result);
        const kindByName = Object.fromEntries(visual.map((v) => [v.label.split(' ')[0], v.visualKind]));
        expect(kindByName['ConstraintLayout']).toBe('layout');
        expect(kindByName['MaterialButton']).toBe('button');
        expect(kindByName['TextInputEditText']).toBe('input');
    });

    it('unknown PascalCase XML tag → custom; lowercase tags ignored', () => {
        const fp = 'apps/android/CustomActivity.kt';
        const snap = mkSnapWith(fp,
            "class CustomActivity : AppCompatActivity() { override fun onCreate(b: Bundle?) { setContentView(R.layout.weird) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const xml: Record<string, string> = {
            'weird':
                `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">\n` +
                `  <MyCustomWidget />\n` +
                `</LinearLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result);
        const custom = visual.find((v) => v.label.startsWith('MyCustomWidget'));
        expect(custom!.visualKind).toBe('custom');
    });

    it('no R.layout reference in source → no XML items emitted', () => {
        const fp = 'apps/android/PureComposeActivity.kt';
        const snap = mkSnapWith(fp,
            "class PureComposeActivity : ComponentActivity() {\n" +
            "  override fun onCreate(b: Bundle?) {\n" +
            "    super.onCreate(b)\n" +
            "    setContent { Greeting() }\n" +
            "  }\n" +
            "}");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        // Resolver would return something, but the source never asks.
        const resolver = (_: string) => '<LinearLayout/>';
        const result = extractScreenContents(snap, screens, undefined, resolver);
        const visual = visualItems(result).filter((v) => v.filePath.startsWith('res/layout/'));
        expect(visual.length).toBe(0);
    });

    it('R.layout reference but resolver returns undefined → silently skipped', () => {
        const fp = 'apps/android/MissingLayout.kt';
        const snap = mkSnapWith(fp,
            "class MissingLayout : AppCompatActivity() { override fun onCreate(b: Bundle?) { setContentView(R.layout.gone) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const result = extractScreenContents(snap, screens, undefined, (_) => undefined);
        const visual = visualItems(result).filter((v) => v.filePath.startsWith('res/layout/'));
        expect(visual.length).toBe(0);
    });

    it('Compose-only screen (framework: android-compose) ignores R.layout references', () => {
        // Even if a Compose file accidentally referenced R.layout
        // (e.g. shared utility), the dispatcher only walks XML on
        // android-activity / android-fragment screens to avoid
        // duplicating with Compose-call extraction.
        const fp = 'apps/android/PureCompose.kt';
        const snap = mkSnapWith(fp,
            "@Composable fun Home() { val id = R.layout.activity_main; Text(\"Hi\") }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-compose' }) };
        const xml: Record<string, string> = {
            'activity_main': `<LinearLayout><Button /></LinearLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result).filter((v) => v.filePath.startsWith('res/layout/'));
        expect(visual.length).toBe(0);
    });

    it('XML items aggregate with count when a tag repeats', () => {
        const fp = 'apps/android/MultiActivity.kt';
        const snap = mkSnapWith(fp,
            "class MultiActivity : AppCompatActivity() { override fun onCreate(b: Bundle?) { setContentView(R.layout.repeat_main) } }");
        const screens = { s: mkScreen({ screenId: 's', filePath: fp, framework: 'android-activity' }) };
        const xml: Record<string, string> = {
            'repeat_main':
                `<LinearLayout>\n` +
                `  <TextView android:id="@+id/t1" />\n` +
                `  <TextView android:id="@+id/t2" />\n` +
                `  <TextView android:id="@+id/t3" />\n` +
                `</LinearLayout>`,
        };
        const result = extractScreenContents(snap, screens, undefined, (name) => xml[name]);
        const visual = visualItems(result);
        const tv = visual.find((v) => v.label.startsWith('TextView'));
        expect(tv!.label).toBe('TextView × 3');
    });
});
