/**
 * swiftui.test.ts — Issue #485-VISUAL SwiftUI classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifySwiftUIElement, classifySwiftUISource } from '../swiftui';

describe('classifySwiftUIElement', () => {
    it('Button / NavigationLink', () => {
        expect(classifySwiftUIElement('Button')).toBe('Button');
        expect(classifySwiftUIElement('NavigationLink')).toBe('Button');
    });
    it('TextField / SecureField', () => {
        expect(classifySwiftUIElement('TextField')).toBe('Input');
        expect(classifySwiftUIElement('SecureField')).toBe('Input');
    });
    it('Toggle / Picker / List / Text / Image', () => {
        expect(classifySwiftUIElement('Toggle')).toBe('Toggle');
        expect(classifySwiftUIElement('Picker')).toBe('Picker');
        expect(classifySwiftUIElement('List')).toBe('List');
        expect(classifySwiftUIElement('Text')).toBe('Label');
        expect(classifySwiftUIElement('Image')).toBe('Image');
    });
    it('VStack / HStack / ZStack → Layout', () => {
        expect(classifySwiftUIElement('VStack')).toBe('Layout');
        expect(classifySwiftUIElement('HStack')).toBe('Layout');
        expect(classifySwiftUIElement('ZStack')).toBe('Layout');
    });
    it('Custom user types fall to Custom', () => {
        expect(classifySwiftUIElement('LoginView')).toBe('Custom');
    });
});

describe('classifySwiftUISource', () => {
    it('counts SwiftUI invocations in a screen body', () => {
        const src = `
            struct LoginView: View {
                @State private var email = ""
                @State private var pwd = ""

                var body: some View {
                    VStack {
                        Text("Sign in")
                        TextField("Email", text: $email)
                        SecureField("Password", text: $pwd)
                        Button("Sign in") {
                            login()
                        }
                    }
                }
            }
        `;
        const out = classifySwiftUISource(src);
        expect(out.get('Layout')).toBe(1);   // VStack
        expect(out.get('Label')).toBe(1);    // Text
        expect(out.get('Input')).toBe(2);    // TextField + SecureField
        expect(out.get('Button')).toBe(1);
        // The `struct LoginView` declaration is suppressed by the
        // lookback guard, so 'Custom' shouldn't include it.
        expect(out.get('Custom') ?? 0).toBe(0);
    });

    it('ignores `class Foo` / `struct Foo` declarations', () => {
        const src = `
            class MyService { let bar = 0 }
            struct AnotherView { var x = 1 }
        `;
        const out = classifySwiftUISource(src);
        // Neither MyService nor AnotherView count as visual elements.
        expect(out.size).toBe(0);
    });

    it('ignores string literals', () => {
        const src = `Text("Button(\\"sneaky\\")")`;
        const out = classifySwiftUISource(src);
        expect(out.get('Label')).toBe(1);
        expect(out.get('Button') ?? 0).toBe(0);
    });
});
