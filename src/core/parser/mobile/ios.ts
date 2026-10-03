/**
 * mobile/ios.ts — iOS (Swift / UIKit / SwiftUI / SwiftData / Combine) plugin.
 *
 * Detects UIViewController + SwiftUI View screens, NavigationLink /
 * `.navigationDestination` routes, URLSession + Alamofire network calls,
 * CoreData / SwiftData / Combine DI bindings, ViewController lifecycle
 * methods, UNUserNotificationCenter push handlers, BGTaskScheduler
 * background tasks, App / Scene Delegate lifecycle hooks, and WidgetKit
 * widget targets.
 *
 * Gated by Swift framework imports (`UIKit`, `SwiftUI`, `Combine`,
 * `Foundation`) so plain Foundation utility files don't run the full
 * detection pass.
 */

import type { MobilePlatformPlugin } from './types';
import type { ApiRecord } from '../../graph/graphTypes';
import { makeItem, isTestFile } from './_shared';

function isIOSFile(source: string): boolean {
    return /import\s+(?:UIKit|SwiftUI|Combine|Foundation)/.test(source);
}

const IOS_SCREEN_BASES = new Set([
    'UIViewController', 'UITableViewController', 'UICollectionViewController',
    'UINavigationController', 'UITabBarController', 'UIPageViewController',
]);

const SWIFTUI_VIEW_PROTOCOLS = new Set(['View']);

function detectIOSItems(source: string, filePath: string): ApiRecord[] {
    if (!isIOSFile(source) || isTestFile(filePath)) return [];
    const items: ApiRecord[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;

    // Screens: class extends UIViewController, struct conforms to View.
    // Allow optional generics and access modifiers — `public struct Foo<T>: View {`.
    const classPattern = /(?:(?:public|internal|private|fileprivate|open|final)(?:\s*\(set\))?\s+)*(?:class|struct)\s+(\w+)(?:<[^>]+>)?\s*:\s*([^{]+)\{/g;
    while ((m = classPattern.exec(source)) !== null) {
        const name = m[1];
        // Strip `where T: Hashable` suffixes so the conformance list can be
        // tokenized by comma. SwiftUI views often constrain generic params.
        const supersText = m[2].replace(/\s+where\b[\s\S]*$/, '');
        const supers = supersText.split(',').map(s => s.trim().replace(/<[^>]*>/g, ''));
        const isScreen = supers.some(s => IOS_SCREEN_BASES.has(s) || SWIFTUI_VIEW_PROTOCOLS.has(s));
        if (isScreen && !seen.has(name)) {
            seen.add(name);
            items.push(makeItem('SCREEN', `/${name}`, name, filePath, m.index));
        }
    }

    // Navigation: NavigationLink — covers all initializer shapes:
    //   NavigationLink(destination: …) { … }
    //   NavigationLink("text", destination: …)
    //   NavigationLink(value: x) { … }
    //   NavigationLink { … } label: { … }
    //   NavigationLink(item: $binding) { … }
    const navLink = /\bNavigationLink\s*[({]/g;
    while ((m = navLink.exec(source)) !== null) {
        items.push(makeItem('NAV_ROUTE', 'NavigationLink', 'NavigationLink', filePath, m.index));
    }

    // Navigation: .navigationDestination
    const navDest = /\.navigationDestination\s*\(\s*for\s*:\s*(\w+)/g;
    while ((m = navDest.exec(source)) !== null) {
        items.push(makeItem('NAV_ROUTE', m[1], m[1], filePath, m.index));
    }

    // Network: URLSession
    const urlSession = /URLSession\s*\.\s*shared\s*\.\s*(dataTask|downloadTask|uploadTask)/g;
    while ((m = urlSession.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `URLSession.${m[1]}`, m[1], filePath, m.index));
    }

    // Network: Alamofire
    const alamofire = /AF\s*\.\s*(request|download|upload)\s*\(/g;
    while ((m = alamofire.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `AF.${m[1]}`, m[1], filePath, m.index));
    }

    // DI: SwiftUI / Combine property wrappers — base set.
    // `@Published` is Combine-only but lives on ObservableObject classes that
    // SwiftUI views consume — counts toward the same DI surface area.
    // Skip access modifiers (`private`/`public`/etc.) so the captured name
    // is the actual identifier, not the modifier.
    const swiftUIDI = /@(EnvironmentObject|StateObject|ObservedObject|Published|Bindable|Model|Observable)\b\s*(?:\([^)]*\))?\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = swiftUIDI.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@${m[1]} ${m[2]}`, m[2], filePath, m.index));
    }

    // DI: SwiftUI property wrappers — extended set. Same access-modifier handling.
    const swiftUIPropertyWrappers = /@(State|Binding|AppStorage|SceneStorage|FocusState|FocusedValue|GestureState|Namespace)\b\s*(?:\([^)]*\))?\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = swiftUIPropertyWrappers.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@${m[1]} ${m[2]}`, m[2], filePath, m.index));
    }
    // @Environment(\.dismiss) / @Environment(\.colorScheme) — keypath form.
    // Allow access modifiers (`private`/`public`/etc.) between `)` and `var`,
    // and EITHER form: `var name: Type` or just `var name`.
    const swiftUIEnvironment = /@Environment\s*\(\s*\\\.(\w+)\s*\)\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = swiftUIEnvironment.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Environment(${m[1]}) ${m[2]}`, m[2], filePath, m.index));
    }
    // @Environment(MyKey.self) — newer SwiftUI / SwiftData type-based form.
    const swiftUIEnvironmentType = /@Environment\s*\(\s*([\w.]+)\s*\.\s*self\s*\)\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = swiftUIEnvironmentType.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Environment(${m[1]}.self) ${m[2]}`, m[2], filePath, m.index));
    }
    // SwiftData @Query — handle access modifiers.
    const swiftDataQuery = /@Query\b\s*(?:\([^)]*\))?\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = swiftDataQuery.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Query ${m[1]}`, m[1], filePath, m.index));
    }
    // CoreData @FetchRequest — handle access modifiers.
    const fetchRequest = /@FetchRequest\b\s*(?:\([^)]*\))?\s+(?:(?:public|internal|private|fileprivate|open)(?:\s*\(set\))?\s+)*(?:var|let)\s+(\w+)/g;
    while ((m = fetchRequest.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `@FetchRequest ${m[1]}`, m[1], filePath, m.index));
    }
    // URLSession async/await variants — `URLSession.shared.data(from:)`,
    // `.download(from:)`, `.upload(for:from:)` weren't being captured.
    const urlSessionAsync = /URLSession\s*\.\s*(?:shared|configuration[\w]*)\s*\.\s*(data|download|upload|bytes|webSocketTask)\s*\(/g;
    while ((m = urlSessionAsync.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `URLSession.${m[1]}`, m[1], filePath, m.index));
    }

    // Network: CoreData fetch requests
    const coreFetch = /NSFetchRequest\s*<\s*(\w+)\s*>/g;
    while ((m = coreFetch.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `CoreData: ${m[1]}`, `NSFetchRequest<${m[1]}>`, filePath, m.index));
    }
    const fetchedResults = /NSFetchedResultsController\s*<\s*(\w+)\s*>/g;
    while ((m = fetchedResults.exec(source)) !== null) {
        items.push(makeItem('NETWORK', `CoreData: ${m[1]}`, `NSFetchedResultsController<${m[1]}>`, filePath, m.index));
    }

    // DI: SwiftData @Model macro
    const swiftDataModel = /@Model\s+(?:final\s+)?class\s+(\w+)/g;
    while ((m = swiftDataModel.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Model ${m[1]}`, m[1], filePath, m.index));
    }

    // DI: Combine @Published — moved into swiftUIDI base set above (#357
    // hand-count closure pass). This block kept for backward compat only:
    // exits early since swiftUIDI now covers the same cases.
    const published = /(?!a)a/g; // never match
    while ((m = published.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@Published ${m[1]}`, m[1], filePath, m.index));
    }

    // Tier 2 (Issue 365 — Cascade rebuilds every api-list when one file changes) — Push handlers: UNUserNotificationCenterDelegate
    // overrides + AppDelegate APNs registration callbacks.
    if (/import\s+UserNotifications|UNUserNotificationCenter/.test(source)) {
        const unPattern = /func\s+(userNotificationCenter|application)\s*\(/g;
        while ((m = unPattern.exec(source)) !== null) {
            const tail = source.slice(m.index, m.index + 200);
            // Match the willPresent / didReceive / didRegisterFor / didFailToRegisterFor variants.
            if (/willPresent|didReceive|didRegisterForRemoteNotifications|didFailToRegisterFor/.test(tail)) {
                const fnName = m[1] === 'userNotificationCenter' ? 'userNotificationCenter' : 'application:didRegisterForRemoteNotifications';
                items.push(makeItem('PUSH_HANDLER', `apns:${fnName}`, fnName, filePath, m.index));
            }
        }
    }

    // Tier 2 — Background tasks: BGTaskScheduler.register handlers.
    if (/import\s+BackgroundTasks|BGTaskScheduler/.test(source)) {
        const bgRegister = /BGTaskScheduler\.shared\.register\s*\(\s*forTaskWithIdentifier\s*:\s*"([^"]+)"/g;
        while ((m = bgRegister.exec(source)) !== null) {
            items.push(makeItem('BG_TASK', `bgtask:${m[1]}`, m[1], filePath, m.index));
        }
        const bgClass = /class\s+(\w+)\s*:\s*BGAppRefreshTask\b|class\s+(\w+)\s*:\s*BGProcessingTask\b/g;
        while ((m = bgClass.exec(source)) !== null) {
            const name = m[1] || m[2];
            items.push(makeItem('BG_TASK', `bgtask:${name}`, name, filePath, m.index));
        }
    }

    // Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — iOS Widget Extension targets. WidgetKit-based widgets
    // declare a `Widget` protocol or `WidgetBundle` aggregator; both are
    // user-visible entry points that the OS launches independently of the host app.
    if (/import\s+WidgetKit\b|@main\s+struct\s+\w+\s*:\s*Widget(?:Bundle)?/.test(source)) {
        const widgetStruct = /struct\s+(\w+)\s*:\s*(Widget(?:Bundle)?)\b/g;
        while ((m = widgetStruct.exec(source)) !== null) {
            items.push(makeItem('WIDGET', `widget:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // Tier 3 — UIViewController lifecycle methods. Mirrors the Android
    // Activity/Fragment lifecycle handling: only when the enclosing class
    // actually conforms to UIViewController (or a subclass), and only for
    // well-known lifecycle method names.
    {
        const VC_LIFECYCLE = new Set([
            'viewDidLoad', 'viewWillAppear', 'viewDidAppear', 'viewWillDisappear', 'viewDidDisappear',
            'viewWillLayoutSubviews', 'viewDidLayoutSubviews', 'viewWillTransition',
            'didReceiveMemoryWarning', 'prepareForSegue', 'awakeFromNib',
        ]);
        const inVc = /class\s+\w+\s*:\s*[^{]*?(?:UIViewController|UITableViewController|UICollectionViewController|UINavigationController|UITabBarController|UIPageViewController)\b/.test(source);
        if (inVc) {
            const fnPattern = /(?:override\s+)?func\s+(\w+)\s*\(/g;
            while ((m = fnPattern.exec(source)) !== null) {
                if (VC_LIFECYCLE.has(m[1])) {
                    items.push(makeItem('LIFECYCLE', `lifecycle:${m[1]}`, m[1], filePath, m.index));
                }
            }
        }
    }

    // Tier 2 — App / Scene Delegate lifecycle hooks. These are entry points
    // for app-startup logic (navigation handoff, notifications wiring, etc.)
    if (/UIApplicationDelegate|UISceneDelegate|UNUserNotificationCenterDelegate/.test(source)) {
        const lifecycleHook = /func\s+(applicationDidFinishLaunching|application|sceneDidBecomeActive|sceneWillEnterForeground|sceneDidDisconnect|applicationWillTerminate|applicationDidEnterBackground)\s*\(/g;
        while ((m = lifecycleHook.exec(source)) !== null) {
            const tail = source.slice(m.index, m.index + 250);
            if (/didFinishLaunchingWithOptions|continueUserActivity|openURL|handleEvents/.test(tail)) {
                items.push(makeItem('LIFECYCLE', `applife:${m[1]}`, m[1], filePath, m.index));
            }
        }
    }

    return items;
}

export const iosPlugin: MobilePlatformPlugin = {
    id: 'ios',
    languages: ['swift'],
    detect: (source, filePath) => detectIOSItems(source, filePath),
};
