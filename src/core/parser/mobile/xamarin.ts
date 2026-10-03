/**
 * mobile/xamarin.ts — Xamarin.Forms / .NET MAUI platform plugin (Issue #81).
 *
 * Detects screens (ContentPage / TabbedPage / NavigationPage / Shell /
 * FlyoutPage / CarouselPage / MasterDetailPage subclasses), navigation
 * routes (`Shell.Current.GoToAsync` + `Navigation.PushAsync`), HTTP
 * calls (`HttpClient.GetAsync` / PostAsync / PutAsync / DeleteAsync /
 * PatchAsync / SendAsync), and DI bindings (`builder.Services.AddSingleton`
 * / AddTransient / AddScoped).
 *
 * Gated by `using Xamarin.Forms` or `using Microsoft.Maui` so the
 * detector doesn't false-positive on ASP.NET Core HttpClient usage.
 */
import type { MobilePlatformPlugin } from './types';
import type { ApiRecord } from '../../graph/graphTypes';
import { makeItem, isTestFile } from './_shared';

function isXamarinOrMauiFile(source: string): boolean {
    return /using\s+(?:Xamarin\.Forms|Microsoft\.Maui)\b/.test(source);
}

const XAMARIN_SCREEN_BASES = new Set([
    'ContentPage',
    'TabbedPage',
    'NavigationPage',
    'Shell',
    'FlyoutPage',
    'CarouselPage',
    'MasterDetailPage',
]);

function detectXamarinItems(source: string, filePath: string, language: string): ApiRecord[] {
    if (language !== 'csharp') return [];
    if (!isXamarinOrMauiFile(source) || isTestFile(filePath)) return [];
    const items: ApiRecord[] = [];
    const seen = new Set<string>();

    // Screens — `class Name : <Base>`.
    const classPattern = /(?:public\s+|internal\s+)?(?:partial\s+)?class\s+(\w+)\s*(?::\s*(\w+))/g;
    let m: RegExpExecArray | null;
    while ((m = classPattern.exec(source)) !== null) {
        const className = m[1];
        const parent = m[2];
        if (XAMARIN_SCREEN_BASES.has(parent) && !seen.has(`screen:${className}`)) {
            seen.add(`screen:${className}`);
            items.push(makeItem('SCREEN', `/${className}`, className, filePath, m.index));
        }
    }

    // Navigation — Shell.Current.GoToAsync("route") + Navigation.PushAsync(new Page())
    const shellNav = /Shell\.Current\.GoToAsync\s*\(\s*["']([^"']+)["']/g;
    while ((m = shellNav.exec(source)) !== null) {
        const route = m[1];
        if (!seen.has(`nav:${route}`)) {
            seen.add(`nav:${route}`);
            items.push(makeItem('NAV_ROUTE', route, route, filePath, m.index));
        }
    }
    const pushAsync = /Navigation\.PushAsync\s*\(\s*new\s+(\w+)\s*\(/g;
    while ((m = pushAsync.exec(source)) !== null) {
        const pageName = m[1];
        if (!seen.has(`nav:${pageName}`)) {
            seen.add(`nav:${pageName}`);
            items.push(makeItem('NAV_ROUTE', `/${pageName}`, pageName, filePath, m.index));
        }
    }

    // Network — HttpClient.<Verb>Async("url")
    const httpPattern = /\.(GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|SendAsync)\s*\(\s*["']([^"']+)["']/g;
    while ((m = httpPattern.exec(source)) !== null) {
        const verb = m[1];
        const url = m[2];
        if (!seen.has(`net:${verb}:${url}`)) {
            seen.add(`net:${verb}:${url}`);
            items.push(makeItem('NETWORK', url, verb, filePath, m.index));
        }
    }

    // DI — builder.Services.AddSingleton<T>() / AddTransient<T>() / AddScoped<T>()
    // Two forms: `AddSingleton<IFoo, Foo>()` and `AddTransient<ApiClient>()`.
    const diPattern = /\.Services\.(AddSingleton|AddTransient|AddScoped)\s*<\s*([\w\.]+)(?:\s*,\s*([\w\.]+))?\s*>/g;
    while ((m = diPattern.exec(source)) !== null) {
        const kind = m[1];
        const implType = m[3] ?? m[2]; // Prefer the second type param (the impl); fall back to the first
        const key = `di:${kind}:${implType}`;
        if (!seen.has(key)) {
            seen.add(key);
            items.push(makeItem('DI_BINDING', `${kind}:${implType}`, `${kind}:${implType}`, filePath, m.index));
        }
    }

    return items;
}

export const xamarinPlugin: MobilePlatformPlugin = {
    id: 'xamarin',
    languages: ['csharp'],
    detect: (source, filePath, language) => detectXamarinItems(source, filePath, language as string),
};
