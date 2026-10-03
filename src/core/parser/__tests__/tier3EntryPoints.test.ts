/**
 * Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — regression tests for the deferred entry-point
 * categories: AndroidManifest.xml deep links / receivers / services /
 * providers; iOS Widget extensions; Android Activity/Fragment lifecycle;
 * iOS UIViewController lifecycle.
 */

import { describe, it, expect } from 'vitest';
import { detectMobileItems, detectAndroidManifestItems } from '../mobileDetector';
import { detectFrameworkApis } from '../frameworkDetector';

describe('Tier 3 — AndroidManifest.xml deep links + components', () => {
    it('emits DEEP_LINK records for VIEW + BROWSABLE intent-filters', () => {
        const xml = `
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">
  <application>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="example.com" android:pathPrefix="/products" />
        <data android:scheme="myapp" android:host="open" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/AndroidManifest.xml');
        const deepLinks = items.filter(i => i.method === 'DEEP_LINK');
        expect(deepLinks).toHaveLength(2);
        expect(deepLinks.some(d => d.route === 'https://example.com/products')).toBe(true);
        expect(deepLinks.some(d => d.route === 'myapp://open')).toBe(true);
    });

    it('skips intent-filters that lack BROWSABLE category', () => {
        const xml = `
<manifest>
  <application>
    <activity android:name=".LauncherActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/AndroidManifest.xml');
        expect(items.filter(i => i.method === 'DEEP_LINK')).toHaveLength(0);
    });

    it('emits WIDGET record for receivers with APPWIDGET_UPDATE filter', () => {
        const xml = `
<manifest>
  <application>
    <receiver android:name=".widget.WeatherWidgetProvider" android:exported="true">
      <intent-filter>
        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
      </intent-filter>
      <meta-data android:name="android.appwidget.provider" android:resource="@xml/weather_widget_info" />
    </receiver>
  </application>
</manifest>
`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/AndroidManifest.xml');
        const widget = items.find(i => i.method === 'WIDGET');
        expect(widget).toBeDefined();
        expect(widget?.handlerName).toBe('.widget.WeatherWidgetProvider');
    });

    it('emits BG_TASK record for non-widget receivers', () => {
        const xml = `
<manifest>
  <application>
    <receiver android:name=".BootReceiver" android:exported="false">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
      </intent-filter>
    </receiver>
  </application>
</manifest>
`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/AndroidManifest.xml');
        expect(items.some(i => i.method === 'BG_TASK' && i.handlerName === '.BootReceiver')).toBe(true);
    });

    it('emits BG_TASK for declared services and CONTENT_PROVIDER for providers', () => {
        const xml = `
<manifest>
  <application>
    <service android:name=".sync.SyncService" android:exported="false" />
    <provider android:name=".data.MyContentProvider" android:authorities="com.example.provider" />
  </application>
</manifest>
`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/AndroidManifest.xml');
        expect(items.some(i => i.method === 'BG_TASK' && i.handlerName === '.sync.SyncService')).toBe(true);
        expect(items.some(i => i.method === 'CONTENT_PROVIDER' && i.handlerName === '.data.MyContentProvider')).toBe(true);
    });

    it('skips non-manifest XML files (path-gated)', () => {
        const xml = `<intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="https" android:host="x.com" /></intent-filter>`;
        const items = detectAndroidManifestItems(xml, 'app/src/main/res/xml/some_config.xml');
        expect(items).toHaveLength(0);
    });
});

describe('Tier 3 — iOS Widget extensions (WIDGET)', () => {
    it('emits WIDGET for `struct Foo: Widget` declarations', () => {
        const src = `
import WidgetKit
import SwiftUI

@main
struct WeatherWidget: Widget {
    let kind: String = "WeatherWidget"
    var body: some WidgetConfiguration { /* ... */ }
}

struct WidgetsBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget { WeatherWidget() }
}
`;
        const items = detectMobileItems(src, 'Widgets/WeatherWidget.swift', 'swift');
        const widgets = items.filter(i => i.method === 'WIDGET');
        expect(widgets.length).toBeGreaterThanOrEqual(2);
        expect(widgets.some(w => w.handlerName === 'WeatherWidget')).toBe(true);
        expect(widgets.some(w => w.handlerName === 'WidgetsBundle')).toBe(true);
    });

    it('does not emit WIDGET when WidgetKit is not imported', () => {
        const src = `
import SwiftUI
struct Foo: View { var body: some View { EmptyView() } }
`;
        const items = detectMobileItems(src, 'App/Foo.swift', 'swift');
        expect(items.filter(i => i.method === 'WIDGET')).toHaveLength(0);
    });
});

describe('Tier 3 — iOS UIViewController lifecycle (LIFECYCLE)', () => {
    it('emits LIFECYCLE for viewDidLoad/viewWillAppear in a UIViewController subclass', () => {
        const src = `
import UIKit

class HomeViewController: UIViewController {
    override func viewDidLoad() { super.viewDidLoad() }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated) }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated) }
}
`;
        const items = detectMobileItems(src, 'App/HomeViewController.swift', 'swift');
        const lifecycle = items.filter(i => i.method === 'LIFECYCLE');
        expect(lifecycle.length).toBeGreaterThanOrEqual(3);
        expect(lifecycle.some(l => l.handlerName === 'viewDidLoad')).toBe(true);
        expect(lifecycle.some(l => l.handlerName === 'viewWillAppear')).toBe(true);
        expect(lifecycle.some(l => l.handlerName === 'viewWillDisappear')).toBe(true);
    });

    it('does not emit LIFECYCLE outside a UIViewController subclass', () => {
        const src = `
import Foundation

class NetworkClient {
    func viewDidLoad() { /* not actually a lifecycle method */ }
}
`;
        const items = detectMobileItems(src, 'App/NetworkClient.swift', 'swift');
        expect(items.filter(i => i.method === 'LIFECYCLE')).toHaveLength(0);
    });
});

describe('Tier 3 — Rocket Fairings (MIDDLEWARE)', () => {
    it('emits MIDDLEWARE for `impl Fairing for FooFairing`', () => {
        const src = `
use rocket::fairing::{Fairing, Info, Kind};
use rocket::{Request, Response};

pub struct CounterFairing;

#[rocket::async_trait]
impl Fairing for CounterFairing {
    fn info(&self) -> Info {
        Info { name: "Counter", kind: Kind::Request | Kind::Response }
    }
    async fn on_request(&self, req: &mut Request<'_>, _data: &mut Data<'_>) { }
    async fn on_response<'r>(&self, _req: &'r Request<'_>, res: &mut Response<'r>) { }
}
`;
        const apis = detectFrameworkApis(src, 'src/fairings.rs', 'rust');
        expect(apis.some((a: any) => a.method === 'MIDDLEWARE' && a.handlerName === 'CounterFairing')).toBe(true);
    });
});

describe('Tier 3 — Android Activity/Fragment lifecycle (LIFECYCLE)', () => {
    it('emits LIFECYCLE for onCreate / onResume / onPause overrides in an Activity', () => {
        const src = `
package com.example

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState) }
    override fun onResume() { super.onResume() }
    override fun onPause() { super.onPause() }
    override fun onDestroy() { super.onDestroy() }
}
`;
        const items = detectMobileItems(src, 'app/src/main/kotlin/MainActivity.kt', 'kotlin');
        const lifecycle = items.filter(i => i.method === 'LIFECYCLE');
        expect(lifecycle.length).toBeGreaterThanOrEqual(4);
        expect(lifecycle.some(l => l.handlerName === 'onCreate')).toBe(true);
        expect(lifecycle.some(l => l.handlerName === 'onPause')).toBe(true);
    });

    it('emits LIFECYCLE for Fragment onCreateView / onViewCreated', () => {
        const src = `
package com.example

import androidx.fragment.app.Fragment

class HomeFragment : Fragment() {
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?) = null
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) { }
}
`;
        const items = detectMobileItems(src, 'app/src/main/kotlin/HomeFragment.kt', 'kotlin');
        const lifecycle = items.filter(i => i.method === 'LIFECYCLE');
        expect(lifecycle.length).toBeGreaterThanOrEqual(2);
    });

    it('does not emit LIFECYCLE for non-Activity classes that override onCreate', () => {
        const src = `
package com.example
import android.util.Log

class HelperView {
    override fun onCreate() { /* not really an activity */ }
}
`;
        const items = detectMobileItems(src, 'app/src/main/kotlin/HelperView.kt', 'kotlin');
        expect(items.filter(i => i.method === 'LIFECYCLE')).toHaveLength(0);
    });
});
