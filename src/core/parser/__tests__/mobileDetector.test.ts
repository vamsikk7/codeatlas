/**
 * mobileDetector.test.ts
 *
 * Tests for mobile/UI framework item detection: screens, navigation, network calls, DI bindings.
 * Uses realistic folder-level fixtures simulating real Android, iOS, and React projects.
 */

import { describe, it, expect } from 'vitest';
import { detectMobileItems } from '../mobileDetector';
import { DIFF_SYMBOLS, DIFF_BORDER_STYLES, NODE_DIFF_COLORS } from '../../../../webview-ui/src/diffColors';

// ─── Android Fixtures ────────────────────────────────────────────────────────

const ANDROID_ACTIVITY_JAVA = `
package com.app.features.home;
import androidx.appcompat.app.AppCompatActivity;
import android.os.Bundle;

public class HomeActivity extends AppCompatActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_home);
    }
}
`;

const ANDROID_FRAGMENT_JAVA = `
package com.app.features.auth;
import androidx.fragment.app.Fragment;

public class LoginFragment extends Fragment {
    // fragment content
}
`;

const ANDROID_COMPOSE_KT = `
package com.app.features.home
import androidx.compose.runtime.Composable
import androidx.compose.material3.Text
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun HomeScreen(viewModel: HomeViewModel = hiltViewModel()) {
    Text("Home")
}

@Composable
fun SettingsScreen() {
    Text("Settings")
}
`;

const ANDROID_NAV_KT = `
package com.app.nav
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable

NavHost(navController, startDestination = "home") {
    composable("home") { HomeScreen() }
    composable("settings") { SettingsScreen() }
    composable("profile/{userId}") { ProfileScreen() }
}
`;

const ANDROID_RETROFIT_KT = `
package com.app.data.api
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Body

interface TodoApi {
    @GET("todos")
    suspend fun list(): List<Todo>

    @POST("todos")
    suspend fun create(@Body todo: Todo): Todo
}
`;

const ANDROID_HILT_KT = `
package com.app.di
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dagger.Module
import dagger.Provides

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    fun provideTodoRepository(): TodoRepository = TodoRepositoryImpl()
}
`;

const ANDROID_VIEWMODEL_KT = `
package com.app.features.home
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: TodoRepository
) : ViewModel() {
    fun loadTodos() = repository.getAll()
}
`;

// ─── iOS Fixtures ────────────────────────────────────────────────────────────

const IOS_UIKIT_SWIFT = `
import UIKit

class SettingsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
    }
}
`;

const IOS_SWIFTUI_SWIFT = `
import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: AppStore
    @StateObject var viewModel = ContentViewModel()

    var body: some View {
        NavigationStack {
            List { /* items */ }
            .navigationDestination(for: DetailItem.self) { item in
                DetailView(item: item)
            }
        }
    }
}

struct ProfileView: View {
    var body: some View {
        NavigationLink(destination: EditProfileView()) {
            Text("Edit")
        }
    }
}
`;

const IOS_NETWORK_SWIFT = `
import Foundation

class ApiClient {
    func fetchData() {
        URLSession.shared.dataTask(with: url) { data, response, error in
            // handle response
        }.resume()
    }

    func upload() {
        AF.upload(data, to: endpoint) { response in }
    }
}
`;

// ─── React / Next.js Fixtures ────────────────────────────────────────────────

const REACT_PAGE_TSX = `
export default function HomePage() {
    return <div>Welcome</div>;
}
`;

const REACT_DASHBOARD_TSX = `
import useSWR from 'swr';

export default function DashboardPage() {
    const { data } = useSWR('/api/stats');
    return <div>{data?.total}</div>;
}
`;

const REACT_API_HANDLER_TS = `
export default function handler(req, res) {
    res.json({ users: [] });
}
`;

const REACT_ROUTER_TSX = `
import { Route, Link } from 'react-router-dom';

function AppRoutes() {
    return (
        <>
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile/:id" element={<Profile />} />
            <Link to="/dashboard">Dashboard</Link>
        </>
    );
}
`;

const REACT_STORE_TS = `
import { configureStore, createSlice } from '@reduxjs/toolkit';

const todosSlice = createSlice({
    name: 'todos',
    initialState: [],
    reducers: { add: (state, action) => [...state, action.payload] },
});

export const store = configureStore({ reducer: { todos: todosSlice.reducer } });
`;

const REACT_CONTEXT_TSX = `
import React, { createContext, useContext } from 'react';

const ThemeContext = createContext({ dark: false });

function ThemeProvider({ children }) {
    return <ThemeContext.Provider value={{ dark: true }}>{children}</ThemeContext.Provider>;
}
`;

const REACT_FETCH_TSX = `
export default function TodoList() {
    useEffect(() => {
        fetch('/api/todos').then(r => r.json()).then(setTodos);
    }, []);
    return <ul>{todos.map(t => <li>{t.title}</li>)}</ul>;
}
`;

// ─── Non-mobile fixtures (negative cases) ────────────────────────────────────

const SPRING_CONTROLLER_JAVA = `
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    @GetMapping("/api/users")
    public List<User> list() { return userService.findAll(); }
}
`;

const DJANGO_VIEW_PY = `
from django.views import View

class MyView(View):
    def get(self, request):
        return HttpResponse("hello")
`;

const PLAIN_JAVA = `
public class UserService {
    public List<User> findAll() { return List.of(); }
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Android: Screen detection', () => {
    it('detects Activity subclass as SCREEN', () => {
        const items = detectMobileItems(ANDROID_ACTIVITY_JAVA, 'app/features/home/HomeActivity.java', 'java');
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen).toBeDefined();
        expect(screen!.handlerName).toBe('HomeActivity');
    });

    it('detects Fragment subclass as SCREEN', () => {
        const items = detectMobileItems(ANDROID_FRAGMENT_JAVA, 'app/features/auth/LoginFragment.java', 'java');
        expect(items.find(i => i.method === 'SCREEN' && i.handlerName === 'LoginFragment')).toBeDefined();
    });

    it('detects @Composable functions as SCREEN', () => {
        const items = detectMobileItems(ANDROID_COMPOSE_KT, 'app/features/home/HomeScreen.kt', 'kotlin');
        const screens = items.filter(i => i.method === 'SCREEN');
        expect(screens.length).toBeGreaterThanOrEqual(2);
        expect(screens.some(s => s.handlerName === 'HomeScreen')).toBe(true);
        expect(screens.some(s => s.handlerName === 'SettingsScreen')).toBe(true);
    });

    it('does NOT treat @Preview composables as screens (TICKET-DETECT-2)', () => {
        const src = `
package com.app.ui
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun HomeScreen() {}

@Preview
@Composable
fun HomeScreenPreview() {}
`;
        const items = detectMobileItems(src, 'app/ui/Home.kt', 'kotlin');
        const screens = items.filter(i => i.method === 'SCREEN');
        expect(screens.some(s => s.handlerName === 'HomeScreen'), 'real screen kept').toBe(true);
        expect(screens.some(s => s.handlerName === 'HomeScreenPreview'), '@Preview must be skipped').toBe(false);
    });

    it('does NOT capture Kotlin modifiers/keywords as screen names (TICKET-DETECT-2)', () => {
        const src = `
package com.app.ui
import androidx.compose.runtime.Composable

@Composable
private fun InternalCard() {}

@Composable
fun RealScreen() {}
`;
        const items = detectMobileItems(src, 'app/ui/Cards.kt', 'kotlin');
        const screens = items.filter(i => i.method === 'SCREEN');
        // `@Composable\nprivate fun` makes the loose (\w+) grab "private" — a
        // keyword, never a screen name. It must be dropped, not surfaced as
        // "/private". RealScreen (clean `@Composable fun`) is still detected.
        expect(screens.some(s => s.handlerName === 'private'), '"private" keyword must not be a screen').toBe(false);
        expect(screens.some(s => s.handlerName === 'fun'), '"fun" keyword must not be a screen').toBe(false);
        expect(screens.some(s => s.handlerName === 'RealScreen'), 'clean composable kept').toBe(true);
    });

    it('skips NAME-based preview composables the annotation window missed (TICKET-DETECT-2)', () => {
        const src = `
package com.app.ui
import androidx.compose.runtime.Composable

@Composable
fun HomeScreen() {}

// preview functions whose @Preview annotation sits far above / on another line
@Composable
fun HomeScreenPreview() {}
@Composable
fun PostCardTopPreviews() {}
@Composable
fun PreviewHomeListNavRail() {}
`;
        const items = detectMobileItems(src, 'app/ui/Home.kt', 'kotlin');
        const screens = items.filter(i => i.method === 'SCREEN');
        expect(screens.some(s => s.handlerName === 'HomeScreen'), 'real screen kept').toBe(true);
        expect(screens.some(s => s.handlerName === 'HomeScreenPreview'), 'FooPreview skipped').toBe(false);
        expect(screens.some(s => s.handlerName === 'PostCardTopPreviews'), 'FooPreviews skipped').toBe(false);
        expect(screens.some(s => s.handlerName === 'PreviewHomeListNavRail'), 'PreviewFoo skipped').toBe(false);
    });

});

describe('Android: Navigation detection', () => {
    it('detects composable("route") as NAV_ROUTE', () => {
        const items = detectMobileItems(ANDROID_NAV_KT, 'app/nav/AppNavGraph.kt', 'kotlin');
        const routes = items.filter(i => i.method === 'NAV_ROUTE');
        expect(routes.some(r => r.route === 'home')).toBe(true);
        expect(routes.some(r => r.route === 'settings')).toBe(true);
    });

    it('detects dynamic route parameters', () => {
        const items = detectMobileItems(ANDROID_NAV_KT, 'app/nav/AppNavGraph.kt', 'kotlin');
        expect(items.some(i => i.route === 'profile/{userId}')).toBe(true);
    });
});

describe('Android: Network detection', () => {
    it('detects Retrofit @GET as NETWORK (gated by import)', () => {
        const items = detectMobileItems(ANDROID_RETROFIT_KT, 'app/data/api/TodoApi.kt', 'kotlin');
        const network = items.filter(i => i.method === 'NETWORK');
        expect(network.some(n => n.route === 'todos')).toBe(true);
    });

    it('detects Retrofit @POST as NETWORK', () => {
        const items = detectMobileItems(ANDROID_RETROFIT_KT, 'app/data/api/TodoApi.kt', 'kotlin');
        expect(items.some(i => i.method === 'NETWORK' && i.handlerName === 'POST')).toBe(true);
    });
});

describe('Android: DI detection', () => {
    it('detects Hilt @Module as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_HILT_KT, 'app/di/AppModule.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@Module'))).toBe(true);
    });

    it('detects @Provides as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_HILT_KT, 'app/di/AppModule.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@Provides'))).toBe(true);
    });

    it('detects @HiltViewModel as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_VIEWMODEL_KT, 'app/features/home/HomeViewModel.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@HiltViewModel'))).toBe(true);
    });

    it('detects @Inject constructor as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_VIEWMODEL_KT, 'app/features/home/HomeViewModel.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@Inject'))).toBe(true);
    });
});

describe('iOS: Screen detection', () => {
    it('detects UIViewController subclass as SCREEN', () => {
        const items = detectMobileItems(IOS_UIKIT_SWIFT, 'App/Screens/SettingsViewController.swift', 'swift');
        expect(items.some(i => i.method === 'SCREEN' && i.handlerName === 'SettingsViewController')).toBe(true);
    });

    it('detects SwiftUI View struct as SCREEN', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        const screens = items.filter(i => i.method === 'SCREEN');
        expect(screens.some(s => s.handlerName === 'ContentView')).toBe(true);
        expect(screens.some(s => s.handlerName === 'ProfileView')).toBe(true);
    });
});

describe('iOS: Navigation detection', () => {
    it('detects NavigationLink as NAV_ROUTE', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        expect(items.some(i => i.method === 'NAV_ROUTE')).toBe(true);
    });

    it('detects .navigationDestination as NAV_ROUTE', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === 'DetailItem')).toBe(true);
    });
});

describe('iOS: Network detection', () => {
    it('detects URLSession.shared.dataTask as NETWORK', () => {
        const items = detectMobileItems(IOS_NETWORK_SWIFT, 'App/Services/ApiClient.swift', 'swift');
        expect(items.some(i => i.method === 'NETWORK' && i.route.includes('URLSession'))).toBe(true);
    });

    it('detects Alamofire AF.upload as NETWORK', () => {
        const items = detectMobileItems(IOS_NETWORK_SWIFT, 'App/Services/ApiClient.swift', 'swift');
        expect(items.some(i => i.method === 'NETWORK' && i.route.includes('AF.'))).toBe(true);
    });
});

describe('iOS: DI detection', () => {
    it('detects @EnvironmentObject as DI_BINDING', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@EnvironmentObject'))).toBe(true);
    });

    it('detects @StateObject as DI_BINDING', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@StateObject'))).toBe(true);
    });
});

describe('React: Screen detection', () => {
    it('detects export default in pages/ as SCREEN', () => {
        const items = detectMobileItems(REACT_PAGE_TSX, 'pages/index.tsx', 'typescript');
        expect(items.some(i => i.method === 'SCREEN' && i.handlerName === 'HomePage')).toBe(true);
    });

    it('infers route from file path', () => {
        const items = detectMobileItems(REACT_PAGE_TSX, 'pages/index.tsx', 'typescript');
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen!.route).toBe('/');
    });

    it('detects dashboard page with correct route', () => {
        const items = detectMobileItems(REACT_DASHBOARD_TSX, 'pages/dashboard.tsx', 'typescript');
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen).toBeDefined();
        expect(screen!.route).toBe('/dashboard');
    });
});

describe('React: Navigation detection', () => {
    it('detects <Route path="..."> as NAV_ROUTE', () => {
        const items = detectMobileItems(REACT_ROUTER_TSX, 'components/Nav.tsx', 'typescript');
        const routes = items.filter(i => i.method === 'NAV_ROUTE');
        expect(routes.some(r => r.route === '/settings')).toBe(true);
    });

    it('detects <Link to="..."> as NAV_ROUTE', () => {
        const items = detectMobileItems(REACT_ROUTER_TSX, 'components/Nav.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/dashboard')).toBe(true);
    });
});

describe('React: Network detection', () => {
    it('detects useSWR as NETWORK', () => {
        const items = detectMobileItems(REACT_DASHBOARD_TSX, 'pages/dashboard.tsx', 'typescript');
        expect(items.some(i => i.method === 'NETWORK' && i.route === '/api/stats')).toBe(true);
    });

    it('detects fetch("/api/...") as NETWORK in non-API files', () => {
        const items = detectMobileItems(REACT_FETCH_TSX, 'screens/TodoList.tsx', 'typescript');
        expect(items.some(i => i.method === 'NETWORK' && i.route === '/api/todos')).toBe(true);
    });
});

describe('React: DI detection', () => {
    it('detects configureStore as DI_BINDING', () => {
        const items = detectMobileItems(REACT_STORE_TS, 'store/index.ts', 'typescript');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Redux'))).toBe(true);
    });

    it('detects createSlice as DI_BINDING', () => {
        const items = detectMobileItems(REACT_STORE_TS, 'store/index.ts', 'typescript');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Slice:todos'))).toBe(true);
    });

    it('detects createContext as DI_BINDING', () => {
        const items = detectMobileItems(REACT_CONTEXT_TSX, 'contexts/theme.tsx', 'typescript');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Context:ThemeContext'))).toBe(true);
    });
});

// ─── Negative cases ──────────────────────────────────────────────────────────

describe('Negative cases', () => {
    it('Spring @GetMapping NOT detected as mobile item', () => {
        const items = detectMobileItems(SPRING_CONTROLLER_JAVA, 'src/main/UserController.java', 'java');
        expect(items).toHaveLength(0);
    });

    it('pages/api/ NOT detected as SCREEN', () => {
        const items = detectMobileItems(REACT_API_HANDLER_TS, 'pages/api/users.ts', 'typescript');
        const screens = items.filter(i => i.method === 'SCREEN');
        expect(screens).toHaveLength(0);
    });

    it('Python Django View NOT detected as mobile SCREEN', () => {
        const items = detectMobileItems(DJANGO_VIEW_PY, 'views.py', 'python');
        expect(items).toHaveLength(0);
    });

    it('Java class without android import NOT detected', () => {
        const items = detectMobileItems(PLAIN_JAVA, 'src/UserService.java', 'java');
        expect(items).toHaveLength(0);
    });

    it('test files are excluded', () => {
        const items = detectMobileItems(ANDROID_ACTIVITY_JAVA, 'src/test/HomeActivityTest.java', 'java');
        expect(items).toHaveLength(0);
    });

    it('Dart file without flutter import returns empty', () => {
        const items = detectMobileItems('class MyWidget extends StatelessWidget {}', 'lib/main.dart', 'dart');
        // No `import 'package:flutter/` → gate prevents detection
        expect(items).toHaveLength(0);
    });
});

// ─── Dangling node / integrity checks ────────────────────────────────────────

describe('Item integrity', () => {
    it('every item has non-empty apiId', () => {
        const items = detectMobileItems(ANDROID_COMPOSE_KT, 'app/screens/Home.kt', 'kotlin');
        for (const item of items) {
            expect(item.apiId).toBeTruthy();
            expect(item.apiId.length).toBeGreaterThan(5);
        }
    });

    it('every SCREEN has non-empty handlerName', () => {
        const items = detectMobileItems(ANDROID_COMPOSE_KT, 'app/screens/Home.kt', 'kotlin');
        for (const item of items.filter(i => i.method === 'SCREEN')) {
            expect(item.handlerName).toBeTruthy();
        }
    });

    it('every NAV_ROUTE has non-empty route', () => {
        const items = detectMobileItems(ANDROID_NAV_KT, 'app/nav/AppNavGraph.kt', 'kotlin');
        for (const item of items.filter(i => i.method === 'NAV_ROUTE')) {
            expect(item.route).toBeTruthy();
            expect(item.route.length).toBeGreaterThan(0);
        }
    });

    it('every NETWORK has non-empty route', () => {
        const items = detectMobileItems(ANDROID_RETROFIT_KT, 'app/data/api/TodoApi.kt', 'kotlin');
        for (const item of items.filter(i => i.method === 'NETWORK')) {
            expect(item.route.length).toBeGreaterThan(0);
        }
    });

    it('no duplicate apiIds', () => {
        const items = detectMobileItems(ANDROID_COMPOSE_KT, 'app/screens/Home.kt', 'kotlin');
        const ids = items.map(i => i.apiId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every item has valid filePath', () => {
        const items = detectMobileItems(IOS_SWIFTUI_SWIFT, 'App/Screens/ContentView.swift', 'swift');
        for (const item of items) {
            expect(item.filePath).toBe('App/Screens/ContentView.swift');
        }
    });

    it('no items with undefined method or route', () => {
        const allFixtures: [string, string, any][] = [
            [ANDROID_COMPOSE_KT, 'a.kt', 'kotlin'],
            [IOS_SWIFTUI_SWIFT, 'b.swift', 'swift'],
            [REACT_ROUTER_TSX, 'components/Nav.tsx', 'typescript'],
        ];
        for (const [src, fp, lang] of allFixtures) {
            const items = detectMobileItems(src, fp, lang);
            for (const item of items) {
                expect(item.method).toBeDefined();
                expect(item.route).toBeDefined();
            }
        }
    });
});

// ─── iOS: CoreData, SwiftData, Combine (Issue 80 — iOS: CoreData, SwiftData, Combine detection) ────────────────────────────

const IOS_COREDATA_SWIFT = `
import UIKit
import CoreData

class DataManager {
    func fetchItems() -> [Item] {
        let request = NSFetchRequest<Item>(entityName: "Item")
        return try! context.fetch(request)
    }

    func observeItems() {
        let frc = NSFetchedResultsController<Item>(fetchRequest: request, managedObjectContext: context, sectionNameKeyPath: nil, cacheName: nil)
    }
}
`;

const IOS_SWIFTDATA_SWIFT = `
import SwiftUI

@Model
final class TodoItem {
    var title: String
    var isComplete: Bool
}
`;

const IOS_COMBINE_SWIFT = `
import Combine

class UserViewModel: ObservableObject {
    @Published var username: String = ""
    @Published var isLoggedIn: Bool = false

    func login() { /* ... */ }
}
`;

describe('iOS: CoreData detection (Issue 80)', () => {
    it('detects NSFetchRequest as NETWORK', () => {
        const items = detectMobileItems(IOS_COREDATA_SWIFT, 'App/Data/DataManager.swift', 'swift');
        expect(items.some(i => i.method === 'NETWORK' && i.route.includes('CoreData'))).toBe(true);
    });

    it('detects NSFetchedResultsController as NETWORK', () => {
        const items = detectMobileItems(IOS_COREDATA_SWIFT, 'App/Data/DataManager.swift', 'swift');
        expect(items.some(i => i.method === 'NETWORK' && i.handlerName.includes('NSFetchedResultsController'))).toBe(true);
    });
});

describe('iOS: SwiftData detection (Issue 80)', () => {
    it('detects @Model as DI_BINDING', () => {
        const items = detectMobileItems(IOS_SWIFTDATA_SWIFT, 'App/Models/TodoItem.swift', 'swift');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('@Model'))).toBe(true);
    });

    it('@Model captures class name', () => {
        const items = detectMobileItems(IOS_SWIFTDATA_SWIFT, 'App/Models/TodoItem.swift', 'swift');
        expect(items.some(i => i.handlerName === 'TodoItem')).toBe(true);
    });
});

describe('iOS: Combine @Published detection (Issue 80)', () => {
    it('detects @Published as DI_BINDING', () => {
        const items = detectMobileItems(IOS_COMBINE_SWIFT, 'App/ViewModels/UserViewModel.swift', 'swift');
        const published = items.filter(i => i.method === 'DI_BINDING' && i.route.includes('@Published'));
        expect(published.length).toBe(2);
    });

    it('@Published captures property name', () => {
        const items = detectMobileItems(IOS_COMBINE_SWIFT, 'App/ViewModels/UserViewModel.swift', 'swift');
        expect(items.some(i => i.handlerName === 'username')).toBe(true);
        expect(items.some(i => i.handlerName === 'isLoggedIn')).toBe(true);
    });
});

// ─── Expo Router (Issue 78 — Expo Router detection) ─────────────────────────────────────────────────

const EXPO_ROUTER_TSX = `
import { Stack, Tabs, Redirect, useRouter } from 'expo-router';

export default function Layout() {
    const router = useRouter();

    return (
        <Stack>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)/login" />
            <Tabs.Screen name="home" />
            <Redirect href="/onboarding" />
        </Stack>
    );
}

function NavButton() {
    const router = useRouter();
    router.push("/settings");
    router.replace("/home");
}
`;

const EXPO_ROUTER_NO_IMPORT_TSX = `
import { Stack } from '@react-navigation/native-stack';

function Layout() {
    return (
        <Stack>
            <Stack.Screen name="index" />
        </Stack>
    );
}
`;

describe('Expo Router detection (Issue 78)', () => {
    it('detects <Stack.Screen name="..."> as NAV_ROUTE', () => {
        const items = detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === 'index')).toBe(true);
    });

    it('detects <Tabs.Screen name="..."> as NAV_ROUTE', () => {
        const items = detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === 'home')).toBe(true);
    });

    it('detects router.push as NAV_ROUTE', () => {
        const items = detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/settings')).toBe(true);
    });

    it('detects router.replace as NAV_ROUTE', () => {
        const items = detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/home')).toBe(true);
    });

    it('detects <Redirect href="..."> as NAV_ROUTE', () => {
        const items = detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/onboarding')).toBe(true);
    });

    it('does NOT detect Stack.Screen without expo-router import', () => {
        const items = detectMobileItems(EXPO_ROUTER_NO_IMPORT_TSX, 'app/_layout.tsx', 'typescript');
        const expoRoutes = items.filter(i => i.method === 'NAV_ROUTE' && i.handlerName === 'ExpoScreen');
        expect(expoRoutes).toHaveLength(0);
    });
});

describe('Expo Router: inferScreenRoute with (group) segments', () => {
    it('strips (auth) group from route', () => {
        const items = detectMobileItems(
            'export default function LoginPage() { return null; }',
            'app/(auth)/login.tsx',
            'typescript'
        );
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen).toBeDefined();
        expect(screen!.route).toBe('/login');
    });

    it('strips (tabs) group from route', () => {
        const items = detectMobileItems(
            'export default function HomePage() { return null; }',
            'app/(tabs)/home.tsx',
            'typescript'
        );
        const screen = items.find(i => i.method === 'SCREEN');
        expect(screen!.route).toBe('/home');
    });

    it('_layout files are NOT screens (Expo Router special file — BUG-VERIFY-5)', () => {
        const items = detectMobileItems(
            'export default function Layout() { return null; }',
            'app/(tabs)/_layout.tsx',
            'typescript'
        );
        // A layout file is a framework special file, never a navigable
        // screen — the reactPlugin must not emit a SCREEN for it.
        expect(items.find(i => i.method === 'SCREEN')).toBeUndefined();
    });
});

// ─── Android: Room DAO (Issue 74 — Room @Query/@Insert/@Update/@Delete detection) ───────────────────────────────────────────

const ANDROID_ROOM_DAO_KT = `
package com.app.data.db
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Insert
import androidx.room.Update
import androidx.room.Delete

@Dao
interface TodoDao {
    @Query("SELECT * FROM todos WHERE isComplete = 0")
    fun getActiveTodos(): List<Todo>

    @Query("SELECT COUNT(*) FROM todos")
    suspend fun count(): Int

    @Insert
    suspend fun insert(todo: Todo)

    @Update
    fun update(todo: Todo)

    @Delete
    abstract fun delete(todo: Todo)
}
`;

describe('Android: Room DAO detection (Issue 74)', () => {
    it('detects @Query as NETWORK', () => {
        const items = detectMobileItems(ANDROID_ROOM_DAO_KT, 'app/data/db/TodoDao.kt', 'kotlin');
        const queries = items.filter(i => i.method === 'NETWORK' && i.route.startsWith('Room:'));
        expect(queries.length).toBeGreaterThanOrEqual(2);
    });

    it('detects @Insert as NETWORK', () => {
        const items = detectMobileItems(ANDROID_ROOM_DAO_KT, 'app/data/db/TodoDao.kt', 'kotlin');
        expect(items.some(i => i.method === 'NETWORK' && i.route === 'Room: @Insert')).toBe(true);
    });

    it('detects @Update as NETWORK', () => {
        const items = detectMobileItems(ANDROID_ROOM_DAO_KT, 'app/data/db/TodoDao.kt', 'kotlin');
        expect(items.some(i => i.method === 'NETWORK' && i.route === 'Room: @Update')).toBe(true);
    });

    it('detects @Delete as NETWORK', () => {
        const items = detectMobileItems(ANDROID_ROOM_DAO_KT, 'app/data/db/TodoDao.kt', 'kotlin');
        expect(items.some(i => i.method === 'NETWORK' && i.route === 'Room: @Delete')).toBe(true);
    });

    it('captures handler name from method', () => {
        const items = detectMobileItems(ANDROID_ROOM_DAO_KT, 'app/data/db/TodoDao.kt', 'kotlin');
        expect(items.some(i => i.handlerName === 'getActiveTodos')).toBe(true);
        expect(items.some(i => i.handlerName === 'insert')).toBe(true);
    });
});

// ─── React: Zustand/Jotai/TanStack Query (Issue 77 — React state manager detection) ────────────────────────

const REACT_ZUSTAND_TS = `
import { create } from 'zustand';

const useAuthStore = create<AuthState>((set) => ({
    user: null,
    setUser: (user) => set({ user }),
}));
`;

const REACT_JOTAI_TS = `
import { atom } from 'jotai';

const countAtom = atom(0);
const darkModeAtom = atom(false);
`;

const REACT_TANSTACK_TSX = `
import { useMutation, useInfiniteQuery } from '@tanstack/react-query';

function TodoList() {
    const { data } = useInfiniteQuery(["todos"], fetchTodos);
    const mutation = useMutation(createTodo);
}
`;

describe('React: Zustand detection (Issue 77)', () => {
    it('detects create((set) => ...) as DI_BINDING', () => {
        const items = detectMobileItems(REACT_ZUSTAND_TS, 'store/auth.ts', 'typescript');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Zustand'))).toBe(true);
    });

    it('captures store name', () => {
        const items = detectMobileItems(REACT_ZUSTAND_TS, 'store/auth.ts', 'typescript');
        expect(items.some(i => i.handlerName === 'useAuthStore')).toBe(true);
    });
});

describe('React: Jotai detection (Issue 77)', () => {
    it('detects atom() as DI_BINDING', () => {
        const items = detectMobileItems(REACT_JOTAI_TS, 'atoms/index.ts', 'typescript');
        const atoms = items.filter(i => i.method === 'DI_BINDING' && i.route.includes('Atom'));
        expect(atoms.length).toBe(2);
    });

    it('captures atom names', () => {
        const items = detectMobileItems(REACT_JOTAI_TS, 'atoms/index.ts', 'typescript');
        expect(items.some(i => i.handlerName === 'countAtom')).toBe(true);
        expect(items.some(i => i.handlerName === 'darkModeAtom')).toBe(true);
    });
});

describe('React: TanStack Query detection (Issue 77)', () => {
    it('detects useMutation as NETWORK', () => {
        const items = detectMobileItems(REACT_TANSTACK_TSX, 'components/TodoList.tsx', 'typescript');
        expect(items.some(i => i.method === 'NETWORK' && i.handlerName === 'useMutation')).toBe(true);
    });

    it('detects useInfiniteQuery as NETWORK', () => {
        const items = detectMobileItems(REACT_TANSTACK_TSX, 'components/TodoList.tsx', 'typescript');
        expect(items.some(i => i.method === 'NETWORK' && i.handlerName === 'useInfiniteQuery')).toBe(true);
    });
});

// ─── Diff propagation (Issue 82 — Diff propagation tests for mobile items) ────────────────────────────────────────────

describe('Diff propagation: mobile items change between versions', () => {
    const BEFORE_KT = `
package com.app.ui
import androidx.compose.runtime.Composable

@Composable
fun HomeScreen() { }
`;

    const AFTER_KT = `
package com.app.ui
import androidx.compose.runtime.Composable

@Composable
fun HomeScreen() { }

@Composable
fun SettingsScreen() { }

@Composable
fun ProfileScreen() { }
`;

    it('detects more screens in newer version', () => {
        const before = detectMobileItems(BEFORE_KT, 'ui/Home.kt', 'kotlin');
        const after = detectMobileItems(AFTER_KT, 'ui/Home.kt', 'kotlin');
        expect(after.filter(i => i.method === 'SCREEN').length).toBeGreaterThan(
            before.filter(i => i.method === 'SCREEN').length
        );
    });

    it('added screens have distinct apiIds', () => {
        const after = detectMobileItems(AFTER_KT, 'ui/Home.kt', 'kotlin');
        const ids = after.map(i => i.apiId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    const BEFORE_SWIFT = `
import SwiftUI

struct ContentView: View {
    var body: some View { Text("Hello") }
}
`;

    const AFTER_SWIFT = `
import SwiftUI
import Combine

struct ContentView: View {
    @Published var name: String = ""
    var body: some View { Text("Hello") }
}
`;

    it('new @Published items appear in newer iOS version', () => {
        const before = detectMobileItems(BEFORE_SWIFT, 'App/ContentView.swift', 'swift');
        const after = detectMobileItems(AFTER_SWIFT, 'App/ContentView.swift', 'swift');
        const beforeDI = before.filter(i => i.method === 'DI_BINDING');
        const afterDI = after.filter(i => i.method === 'DI_BINDING');
        expect(afterDI.length).toBeGreaterThan(beforeDI.length);
    });
});

// ─── Full pipeline: method categories (Issue 83 — Full pipeline test for mobile items) ────────────────────────────

describe('Full pipeline: all items have valid synthetic methods', () => {
    // Tier 2/3 (Issue 365 — Cascade rebuilds every api-list when one file changes/366) — mobile detector now also emits these
    // synthetic methods for push notifications, background tasks, app
    // lifecycle, widgets, content providers, and deep links.
    const VALID_METHODS = new Set([
        'SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING',
        'PUSH_HANDLER', 'BG_TASK', 'LIFECYCLE',
        'WIDGET', 'CONTENT_PROVIDER', 'DEEP_LINK',
    ]);

    it('Android items have correct mobile methods', () => {
        const all = [
            ...detectMobileItems(ANDROID_COMPOSE_KT, 'a.kt', 'kotlin'),
            ...detectMobileItems(ANDROID_NAV_KT, 'b.kt', 'kotlin'),
            ...detectMobileItems(ANDROID_RETROFIT_KT, 'c.kt', 'kotlin'),
            ...detectMobileItems(ANDROID_HILT_KT, 'd.kt', 'kotlin'),
        ];
        for (const item of all) {
            expect(VALID_METHODS.has(item.method)).toBe(true);
        }
    });

    it('iOS items have correct mobile methods', () => {
        const all = [
            ...detectMobileItems(IOS_UIKIT_SWIFT, 'a.swift', 'swift'),
            ...detectMobileItems(IOS_SWIFTUI_SWIFT, 'b.swift', 'swift'),
            ...detectMobileItems(IOS_NETWORK_SWIFT, 'c.swift', 'swift'),
            ...detectMobileItems(IOS_COREDATA_SWIFT, 'd.swift', 'swift'),
            ...detectMobileItems(IOS_COMBINE_SWIFT, 'e.swift', 'swift'),
        ];
        for (const item of all) {
            expect(VALID_METHODS.has(item.method)).toBe(true);
        }
    });

    it('React items have correct mobile methods', () => {
        const all = [
            ...detectMobileItems(REACT_PAGE_TSX, 'pages/index.tsx', 'typescript'),
            ...detectMobileItems(REACT_ROUTER_TSX, 'app/Nav.tsx', 'typescript'),
            ...detectMobileItems(REACT_DASHBOARD_TSX, 'pages/dash.tsx', 'typescript'),
            ...detectMobileItems(REACT_STORE_TS, 'store/x.ts', 'typescript'),
            ...detectMobileItems(EXPO_ROUTER_TSX, 'app/_layout.tsx', 'typescript'),
        ];
        for (const item of all) {
            expect(VALID_METHODS.has(item.method)).toBe(true);
        }
    });

    it('Flutter items have correct mobile methods', () => {
        const all = [
            ...detectMobileItems(FLUTTER_SCREEN_DART, 'lib/a.dart', 'dart'),
            ...detectMobileItems(FLUTTER_NAV_DART, 'lib/b.dart', 'dart'),
            ...detectMobileItems(FLUTTER_DIO_DART, 'lib/c.dart', 'dart'),
            ...detectMobileItems(FLUTTER_GETIT_DART, 'lib/d.dart', 'dart'),
        ];
        expect(all.length).toBeGreaterThan(0);
        for (const item of all) {
            expect(VALID_METHODS.has(item.method)).toBe(true);
        }
    });

    it('all detected items have anchor with valid span', () => {
        const items = detectMobileItems(ANDROID_COMPOSE_KT, 'a.kt', 'kotlin');
        for (const item of items) {
            expect(item.anchor).toBeDefined();
            expect(item.anchor.span).toBeDefined();
            expect(item.anchor.span!.start).toBeGreaterThanOrEqual(0);
        }
    });
});

// ─── Android: Koin DI ───────────────────────────────────────────────────────

const ANDROID_KOIN_KT = `
package com.app.di
import org.koin.dsl.module
import android.app.Application

val appModule = module {
    single<TodoRepository> { TodoRepositoryImpl(get()) }
    factory<Logger> { AndroidLogger() }
    viewModel { HomeViewModel(get()) }
}
`;

describe('Android: Koin DI detection', () => {
    it('detects single{} as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_KOIN_KT, 'app/di/AppModule.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('koin:single'))).toBe(true);
    });

    it('detects factory{} as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_KOIN_KT, 'app/di/AppModule.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('koin:factory'))).toBe(true);
    });

    it('detects viewModel{} as DI_BINDING', () => {
        const items = detectMobileItems(ANDROID_KOIN_KT, 'app/di/AppModule.kt', 'kotlin');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('koin:viewModel'))).toBe(true);
    });
});

// ─── Flutter/Dart (Issue 73 — Flutter/Dart support) ─────────────────────────────────────────────────

const FLUTTER_SCREEN_DART = `
import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
    @override
    Widget build(BuildContext context) {
        return Scaffold(body: Center(child: Text('Home')));
    }
}

class SettingsPage extends StatefulWidget {
    @override
    _SettingsPageState createState() => _SettingsPageState();
}
`;

const FLUTTER_NAV_DART = `
import 'package:flutter/material.dart';

void navigate(BuildContext context) {
    Navigator.pushNamed(context, '/settings');
    Navigator.push(context, MaterialPageRoute(builder: (_) => DetailScreen()));
}
`;

const FLUTTER_GOROUTER_DART = `
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final router = GoRouter(
    routes: [
        GoRoute(path: '/home', builder: (_, __) => HomeScreen()),
        GoRoute(path: '/profile/:id', builder: (_, __) => ProfileScreen()),
    ],
);

void nav(BuildContext context) {
    context.go('/settings');
    context.push('/details');
}
`;

const FLUTTER_DIO_DART = `
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';

class ApiService {
    final dio = Dio();

    Future<void> fetchTodos() async {
        await dio.get('/api/todos');
        await dio.post('/api/todos', data: {});
    }
}
`;

const FLUTTER_HTTP_DART = `
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

Future<void> fetchData() async {
    await http.get(Uri.parse('https://api.example.com/data'));
}
`;

const FLUTTER_GETIT_DART = `
import 'package:flutter/material.dart';
import 'package:get_it/get_it.dart';

final getIt = GetIt.instance;

void setupDI() {
    getIt.registerSingleton<AuthService>(AuthService());
    getIt.registerFactory<TodoRepository>(TodoRepositoryImpl());
    getIt.registerLazySingleton<Logger>(ConsoleLogger());
}
`;

const FLUTTER_RIVERPOD_DART = `
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = StateProvider<int>((ref) => 0);
final todosProvider = FutureProvider<List<Todo>>((ref) async => []);
`;

const FLUTTER_INJECTABLE_DART = `
import 'package:flutter/material.dart';
import 'package:injectable/injectable.dart';

@injectable
class AuthService {
    void login() {}
}

@singleton
class DatabaseHelper {
    void init() {}
}
`;

describe('Flutter: Screen detection (Issue 73)', () => {
    it('detects StatelessWidget as SCREEN', () => {
        const items = detectMobileItems(FLUTTER_SCREEN_DART, 'lib/screens/home.dart', 'dart');
        expect(items.some(i => i.method === 'SCREEN' && i.handlerName === 'HomeScreen')).toBe(true);
    });

    it('detects StatefulWidget as SCREEN', () => {
        const items = detectMobileItems(FLUTTER_SCREEN_DART, 'lib/screens/settings.dart', 'dart');
        expect(items.some(i => i.method === 'SCREEN' && i.handlerName === 'SettingsPage')).toBe(true);
    });

    it('does not detect without flutter import', () => {
        const noImport = 'class HomeScreen extends StatelessWidget {}';
        const items = detectMobileItems(noImport, 'lib/main.dart', 'dart');
        expect(items).toHaveLength(0);
    });
});

describe('Flutter: Navigation detection (Issue 73)', () => {
    it('detects Navigator.pushNamed as NAV_ROUTE', () => {
        const items = detectMobileItems(FLUTTER_NAV_DART, 'lib/nav.dart', 'dart');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/settings')).toBe(true);
    });

    it('detects GoRoute path as NAV_ROUTE', () => {
        const items = detectMobileItems(FLUTTER_GOROUTER_DART, 'lib/router.dart', 'dart');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/home')).toBe(true);
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/profile/:id')).toBe(true);
    });

    it('detects context.go / context.push as NAV_ROUTE', () => {
        const items = detectMobileItems(FLUTTER_GOROUTER_DART, 'lib/router.dart', 'dart');
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/settings')).toBe(true);
        expect(items.some(i => i.method === 'NAV_ROUTE' && i.route === '/details')).toBe(true);
    });
});

describe('Flutter: Network detection (Issue 73)', () => {
    it('detects Dio.get as NETWORK', () => {
        const items = detectMobileItems(FLUTTER_DIO_DART, 'lib/api.dart', 'dart');
        expect(items.some(i => i.method === 'NETWORK' && i.route === '/api/todos')).toBe(true);
    });

    it('detects Dio.post as NETWORK', () => {
        const items = detectMobileItems(FLUTTER_DIO_DART, 'lib/api.dart', 'dart');
        const posts = items.filter(i => i.method === 'NETWORK' && i.handlerName.includes('post'));
        expect(posts.length).toBeGreaterThanOrEqual(1);
    });

    it('detects http.get as NETWORK', () => {
        const items = detectMobileItems(FLUTTER_HTTP_DART, 'lib/api.dart', 'dart');
        expect(items.some(i => i.method === 'NETWORK')).toBe(true);
    });
});

describe('Flutter: DI detection (Issue 73)', () => {
    it('detects GetIt.registerSingleton as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_GETIT_DART, 'lib/di.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('GetIt:AuthService'))).toBe(true);
    });

    it('detects GetIt.registerFactory as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_GETIT_DART, 'lib/di.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('GetIt:TodoRepository'))).toBe(true);
    });

    it('detects GetIt.registerLazySingleton as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_GETIT_DART, 'lib/di.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('GetIt:Logger'))).toBe(true);
    });

    it('detects Riverpod providers as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_RIVERPOD_DART, 'lib/providers.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Provider:counterProvider'))).toBe(true);
        expect(items.some(i => i.method === 'DI_BINDING' && i.route.includes('Provider:todosProvider'))).toBe(true);
    });

    it('detects @injectable as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_INJECTABLE_DART, 'lib/services.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.handlerName === 'AuthService')).toBe(true);
    });

    it('detects @singleton as DI_BINDING', () => {
        const items = detectMobileItems(FLUTTER_INJECTABLE_DART, 'lib/services.dart', 'dart');
        expect(items.some(i => i.method === 'DI_BINDING' && i.handlerName === 'DatabaseHelper')).toBe(true);
    });
});

describe('Flutter: test file exclusion', () => {
    it('test files are excluded', () => {
        const items = detectMobileItems(FLUTTER_SCREEN_DART, 'test/screens/home_test.dart', 'dart');
        expect(items).toHaveLength(0);
    });
});

// ─── Color coding validation ─────────────────────────────────────────────────

describe('Color coding completeness', () => {
    it('DIFF_SYMBOLS has entries for all diff statuses', () => {
        for (const status of ['added', 'deleted', 'modified', 'unchanged']) {
            expect(DIFF_SYMBOLS[status]).toBeDefined();
        }
    });

    it('DIFF_BORDER_STYLES has entries for all diff statuses', () => {
        for (const status of ['added', 'deleted', 'modified', 'unchanged']) {
            expect(DIFF_BORDER_STYLES[status]).toBeDefined();
        }
    });

    it('NODE_DIFF_COLORS has bg/border/glow/text for all statuses', () => {
        for (const status of ['added', 'deleted', 'modified', 'unchanged']) {
            const entry = NODE_DIFF_COLORS[status];
            expect(entry).toBeDefined();
            expect(entry.bg).toBeDefined();
            expect(entry.border).toBeDefined();
        }
    });
});

describe('iOS: SwiftUI access modifiers + Dart 3.x compat (Issue #357 hand-count closure)', () => {
    it('@Published with private(set) captures the actual var name, not the modifier', () => {
        const src = `
import Combine
class UserViewModel: ObservableObject {
    @Published public private(set) var currentUser: User?
    @Published public internal(set) var subscriptions: [Subscription] = []
}
`;
        const items = detectMobileItems(src, 'App/UserViewModel.swift', 'swift');
        const di = items.filter(i => i.method === 'DI_BINDING');
        expect(di.some(i => i.handlerName === 'currentUser')).toBe(true);
        expect(di.some(i => i.handlerName === 'subscriptions')).toBe(true);
        expect(di.every(i => i.handlerName !== 'private' && i.handlerName !== 'public')).toBe(true);
    });

    it('@State private var captures the var name (not the access modifier)', () => {
        const src = `
import SwiftUI
struct ContentView: View {
    @State private var count = 0
    @State public var name = ''
    @StateObject var vm = ViewModel()
    var body: some View { Text(name) }
}
`;
        const items = detectMobileItems(src, 'App/ContentView.swift', 'swift');
        const di = items.filter(i => i.method === 'DI_BINDING');
        expect(di.some(i => i.handlerName === 'count')).toBe(true);
        expect(di.some(i => i.handlerName === 'name')).toBe(true);
        expect(di.some(i => i.handlerName === 'vm')).toBe(true);
        expect(di.every(i => i.handlerName !== 'private' && i.handlerName !== 'public')).toBe(true);
    });

    it('@Environment keypath form with private modifier captures the var name', () => {
        // NB: `\\.` in the template literal becomes `\.` in the actual source string.
        const src = `
import SwiftUI
struct Foo: View {
    @Environment(\\.dismiss) private var dismiss
    @Environment(\\.colorScheme) var colorScheme
    var body: some View { EmptyView() }
}
`;
        const items = detectMobileItems(src, 'App/Foo.swift', 'swift');
        const di = items.filter(i => i.method === 'DI_BINDING');
        expect(di.some(i => i.handlerName === 'dismiss')).toBe(true);
        expect(di.some(i => i.handlerName === 'colorScheme')).toBe(true);
    });

    it('NavigationLink with closure-form initializer is detected', () => {
        const src = `
import SwiftUI
struct Foo: View {
    var body: some View {
        NavigationLink {
            DestinationView()
        } label: {
            Text("Go")
        }
    }
}
`;
        const items = detectMobileItems(src, 'App/Foo.swift', 'swift');
        expect(items.some(i => i.method === 'NAV_ROUTE')).toBe(true);
    });

    it('public struct Foo<T>: View is detected as a screen', () => {
        const src = `
import SwiftUI
public struct GenericView<T: Identifiable>: View {
    let items: [T]
    public var body: some View { Text("hi") }
}
`;
        const items = detectMobileItems(src, 'App/GenericView.swift', 'swift');
        expect(items.some(i => i.method === 'SCREEN' && i.handlerName === 'GenericView')).toBe(true);
    });
});

