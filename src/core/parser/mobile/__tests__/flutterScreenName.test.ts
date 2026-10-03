import { describe, it, expect } from 'vitest';
import { isFlutterScreenName } from '../flutter';

// BUG-EXPLORE-10: Flutter detected EVERY StatelessWidget/StatefulWidget as a
// SCREEN, so ~35% of "screens" on the Material 3 demo were actually widgets
// (buttons / sections / examples). isFlutterScreenName() gates that.
describe('isFlutterScreenName (BUG-EXPLORE-10)', () => {
    it('keeps real screens (explicit suffix)', () => {
        for (const n of ['HomeScreen', 'FilterScreen', 'PlayerScreen', 'LibraryScreen', 'SettingsPage', 'ProfileView', 'OnboardingFlow']) {
            expect(isFlutterScreenName(n), n).toBe(true);
        }
    });
    it('keeps ambiguous top-level names (no component suffix)', () => {
        for (const n of ['Feed', 'Profile', 'Home', 'Dashboard']) {
            expect(isFlutterScreenName(n), n).toBe(true);
        }
    });
    it('rejects Flutter WIDGETS mis-detected as screens', () => {
        for (const n of [
            '_ClearButton', '_ImageButton', 'BrightnessButton', 'Buttons', 'ButtonsWithIcon', 'ButtonsWithoutIcon',
            'BottomAppBars', 'BottomSheetSection', 'BarTransition', 'ButtonAnchorExample', 'Actions', 'App',
            'NavigationBar', 'ListItem', 'ProductCard', 'FilterChip', 'SettingTile',
        ]) {
            expect(isFlutterScreenName(n), n).toBe(false);
        }
    });
});
