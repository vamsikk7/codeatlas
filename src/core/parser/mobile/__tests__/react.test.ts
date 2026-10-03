/**
 * react.test.ts — reactPlugin SCREEN over-detection regression (BUG-VERIFY-5).
 *
 * The reactPlugin emits SCREEN records into the apiIndex (feeding the L2a
 * Feature Areas list). Before the fix it treated EVERY `export default`
 * under pages/ or app/ as a screen and EVERY `*Screen`-named function in a
 * react-native file as a screen — with no exclusion for framework special
 * files. That over-counted Next.js Pages/App Router + Expo Router special
 * files (`_app`, `_document`, `404`, `_layout`, `+not-found`, `+html`,
 * `error`, `loading`, `template`, …) and even script files as screens
 * (evidence: ts-react-native reported 80 SCREENs, ~35 of them special
 * files; ts-hono showed `_app`/`_document`; ts-trpc showed `404`).
 *
 * These assertions mirror the exclusions screenDetector.ts already enforces
 * (lines 148, 315-317) so the apiIndex SCREEN list matches snapshot.screens.
 */

import { describe, it, expect } from 'vitest';
import { reactPlugin } from '../react';
import type { SupportedLanguage } from '../../treeSitterParser';

function screensFor(source: string, filePath: string, language: SupportedLanguage = 'typescript'): string[] {
    return reactPlugin
        .detect(source, filePath, language)
        .filter((r) => r.method === 'SCREEN')
        .map((r) => r.handlerName);
}

describe('reactPlugin — SCREEN special-file exclusion (BUG-VERIFY-5)', () => {
    it('Expo Router _layout.tsx is NOT a screen', () => {
        expect(screensFor('export default function RootLayout() { return null; }',
            'app/_layout.tsx')).toEqual([]);
    });

    it('Expo Router _layout.web.tsx (platform-suffixed) is NOT a screen', () => {
        expect(screensFor('export default function RootLayout() { return null; }',
            'src/app/_layout.web.tsx')).toEqual([]);
    });

    it('Expo Router +not-found.tsx is NOT a screen', () => {
        expect(screensFor('export default function NotFoundScreen() { return null; }',
            'app/+not-found.tsx')).toEqual([]);
    });

    it('Expo Router +html.tsx is NOT a screen', () => {
        expect(screensFor('export default function Root() { return null; }',
            'app/+html.tsx')).toEqual([]);
    });

    it('Next.js Pages Router _app.js / _document.js are NOT screens', () => {
        expect(screensFor('export default function App() { return null; }',
            'pages/_app.js', 'javascript')).toEqual([]);
        expect(screensFor('export default function Document() { return null; }',
            'pages/_document.js', 'javascript')).toEqual([]);
    });

    it('Next.js Pages Router 404.tsx / 500.tsx are NOT screens', () => {
        expect(screensFor('export default function Custom404() { return null; }',
            'src/pages/404.tsx')).toEqual([]);
        expect(screensFor('export default function Custom500() { return null; }',
            'src/pages/500.tsx')).toEqual([]);
    });

    it('Next.js App Router layout/loading/error/template/not-found are NOT screens', () => {
        for (const [base, name] of [['layout', 'DashLayout'], ['loading', 'DashLoading'],
            ['error', 'DashError'], ['template', 'DashTemplate'], ['not-found', 'DashNotFound']]) {
            expect(screensFor(`export default function ${name}() { return null; }`,
                `app/dashboard/${base}.tsx`)).toEqual([]);
        }
    });

    it('a *Screen function inside a /scripts/ file is NOT a screen (Block-2 misfire)', () => {
        const src = "import { View } from 'react-native';\nexport function HomeScreen() { return null; }";
        expect(screensFor(src, 'src/scripts/reset-project.js', 'javascript')).toEqual([]);
    });
});

describe('reactPlugin — real screens are still detected (no over-correction)', () => {
    it('app/page.tsx IS a screen', () => {
        expect(screensFor('export default function Page() { return null; }',
            'app/page.tsx')).toEqual(['Page']);
    });

    it('pages/dashboard.tsx IS a screen', () => {
        expect(screensFor('export default function Dashboard() { return null; }',
            'pages/dashboard.tsx')).toEqual(['Dashboard']);
    });

    it('app/(tabs)/home.tsx IS a screen', () => {
        expect(screensFor('export default function Home() { return null; }',
            'app/(tabs)/home.tsx')).toEqual(['Home']);
    });

    it('a react-native *Screen component in a normal location IS a screen', () => {
        const src = "import { View } from 'react-native';\nexport default function AboutScreen() { return null; }";
        expect(screensFor(src, 'app/(tabs)/about.tsx', 'typescript')).toContain('AboutScreen');
    });
});
