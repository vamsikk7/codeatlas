/**
 * mobile/__tests__/xamarin.test.ts — Issue #81 (2026-06-07).
 *
 * Xamarin / .NET MAUI mobile detection. Pure-regex pass over C# source.
 * Detects:
 *   - SCREEN: classes extending ContentPage / TabbedPage / NavigationPage / Shell
 *     / FlyoutPage / CarouselPage / MasterDetailPage
 *   - NAV_ROUTE: Shell.Current.GoToAsync("...") + Navigation.PushAsync()
 *   - NETWORK: HttpClient method calls (GetAsync / PostAsync / PutAsync /
 *     DeleteAsync / PatchAsync / SendAsync)
 *   - DI_BINDING: builder.Services.AddSingleton / AddTransient / AddScoped
 *
 * Gated by Xamarin.Forms or Microsoft.Maui using-imports so the
 * detector doesn't false-positive on ASP.NET Core HttpClient usage
 * (same C# but backend-side, picked up by the framework detector).
 */
import { describe, it, expect } from 'vitest';
import { xamarinPlugin } from '../xamarin';

describe('xamarinPlugin — Issue #81 Xamarin / MAUI detection', () => {
    it('detects a Xamarin.Forms ContentPage subclass as SCREEN', () => {
        const src = `
using Xamarin.Forms;
namespace MyApp {
    public class LoginPage : ContentPage {
        public LoginPage() { InitializeComponent(); }
    }
}`;
        const items = xamarinPlugin.detect(src, 'Pages/LoginPage.cs', 'csharp');
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen).toBeTruthy();
        expect(screen?.handlerName).toBe('LoginPage');
    });

    it('detects a MAUI ContentPage subclass as SCREEN', () => {
        const src = `
using Microsoft.Maui.Controls;
namespace MyApp {
    public class HomePage : ContentPage {
    }
}`;
        const items = xamarinPlugin.detect(src, 'Pages/HomePage.cs', 'csharp');
        const screen = items.find(i => i.method === 'SCREEN' && i.handlerName === 'HomePage');
        expect(screen).toBeTruthy();
    });

    it('detects multiple page kinds (Shell, TabbedPage, NavigationPage)', () => {
        const src = `
using Microsoft.Maui.Controls;
public class AppShell : Shell {}
public class TabsPage : TabbedPage {}
public class NavPage : NavigationPage {}
public class FlyoutMain : FlyoutPage {}
public class Carousel : CarouselPage {}
`;
        const items = xamarinPlugin.detect(src, 'Pages/All.cs', 'csharp');
        const screens = items.filter(i => i.method === 'SCREEN').map(i => i.handlerName).sort();
        expect(screens).toEqual(['AppShell', 'Carousel', 'FlyoutMain', 'NavPage', 'TabsPage']);
    });

    it('detects Shell.Current.GoToAsync("...") as NAV_ROUTE', () => {
        const src = `
using Microsoft.Maui.Controls;
public class MainPage : ContentPage {
    async void OnTap() { await Shell.Current.GoToAsync("//details/42"); }
}`;
        const items = xamarinPlugin.detect(src, 'Pages/MainPage.cs', 'csharp');
        const nav = items.find(i => i.method === 'NAV_ROUTE' && i.route === '//details/42');
        expect(nav).toBeTruthy();
    });

    it('detects Navigation.PushAsync(new Page()) as NAV_ROUTE', () => {
        const src = `
using Xamarin.Forms;
public class LoginPage : ContentPage {
    async void Submit() { await Navigation.PushAsync(new HomePage()); }
}`;
        const items = xamarinPlugin.detect(src, 'Pages/LoginPage.cs', 'csharp');
        const nav = items.find(i => i.method === 'NAV_ROUTE' && i.handlerName === 'HomePage');
        expect(nav).toBeTruthy();
    });

    it('detects HttpClient.GetAsync("url") as NETWORK', () => {
        const src = `
using System.Net.Http;
using Microsoft.Maui.Controls;
public class ApiClient {
    private HttpClient _http = new HttpClient();
    public async Task GetUser() {
        var resp = await _http.GetAsync("https://api.example.com/user");
    }
}`;
        const items = xamarinPlugin.detect(src, 'Services/ApiClient.cs', 'csharp');
        const net = items.find(i => i.method === 'NETWORK' && i.route === 'https://api.example.com/user');
        expect(net).toBeTruthy();
        expect(net?.handlerName).toMatch(/GetAsync/);
    });

    it('detects multiple HTTP method calls (PostAsync, PutAsync, DeleteAsync, PatchAsync)', () => {
        const src = `
using System.Net.Http;
using Microsoft.Maui.Controls;
public class Api {
    HttpClient http = new HttpClient();
    async Task A() { await http.PostAsync("/login", null); }
    async Task B() { await http.PutAsync("/profile", null); }
    async Task C() { await http.DeleteAsync("/account"); }
    async Task D() { await http.PatchAsync("/prefs", null); }
}`;
        const items = xamarinPlugin.detect(src, 'Services/Api.cs', 'csharp');
        const routes = items.filter(i => i.method === 'NETWORK').map(i => i.route).sort();
        expect(routes).toEqual(['/account', '/login', '/prefs', '/profile']);
    });

    it('detects builder.Services.AddSingleton<T>() as DI_BINDING', () => {
        const src = `
using Microsoft.Maui;
using Microsoft.Extensions.DependencyInjection;
public static class MauiProgram {
    public static MauiApp CreateMauiApp() {
        var builder = MauiApp.CreateBuilder();
        builder.Services.AddSingleton<IUserService, UserService>();
        builder.Services.AddTransient<ApiClient>();
        builder.Services.AddScoped<SessionState>();
        return builder.Build();
    }
}`;
        const items = xamarinPlugin.detect(src, 'MauiProgram.cs', 'csharp');
        const di = items.filter(i => i.method === 'DI_BINDING').map(i => i.handlerName).sort();
        expect(di).toEqual(['AddScoped:SessionState', 'AddSingleton:UserService', 'AddTransient:ApiClient']);
    });

    it('returns [] when no Xamarin / MAUI usings are present (back-end ASP.NET would false-positive without this gate)', () => {
        const src = `
using Microsoft.AspNetCore.Mvc;
using System.Net.Http;
public class ApiController : ControllerBase {
    HttpClient http = new HttpClient();
    async Task Proxy() { await http.GetAsync("https://backend.example/data"); }
}`;
        const items = xamarinPlugin.detect(src, 'Controllers/ApiController.cs', 'csharp');
        expect(items).toEqual([]);
    });

    it('returns [] for non-csharp languages', () => {
        const src = '<x>not csharp</x>';
        const items = xamarinPlugin.detect(src, 'a.xml', 'kotlin' as any);
        expect(items).toEqual([]);
    });

    it('skips test files', () => {
        const src = `
using Microsoft.Maui.Controls;
public class TestPage : ContentPage {}
`;
        // The shared isTestFile gate matches `.test.` / `.spec.` / `tests/`
        // / `__tests__` / `src/test/`. A canonical xUnit test path includes
        // the `.test.cs` segment.
        const items = xamarinPlugin.detect(src, 'tests/HomePage.test.cs', 'csharp');
        expect(items).toEqual([]);
    });
});
