/**
 * compose.test.ts — Issue #485-VISUAL Jetpack Compose classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyComposeElement, classifyComposeSource } from '../compose';

describe('classifyComposeElement', () => {
    it('Button variants', () => {
        expect(classifyComposeElement('Button')).toBe('Button');
        expect(classifyComposeElement('IconButton')).toBe('Button');
        expect(classifyComposeElement('OutlinedButton')).toBe('Button');
        expect(classifyComposeElement('FloatingActionButton')).toBe('Button');
    });
    it('TextField variants', () => {
        expect(classifyComposeElement('TextField')).toBe('Input');
        expect(classifyComposeElement('OutlinedTextField')).toBe('Input');
    });
    it('Switch / Checkbox / RadioButton', () => {
        expect(classifyComposeElement('Switch')).toBe('Toggle');
        expect(classifyComposeElement('Checkbox')).toBe('Toggle');
        expect(classifyComposeElement('RadioButton')).toBe('Toggle');
    });
    it('LazyColumn / LazyRow → List', () => {
        expect(classifyComposeElement('LazyColumn')).toBe('List');
        expect(classifyComposeElement('LazyRow')).toBe('List');
    });
    it('Column / Row / Box → Layout', () => {
        expect(classifyComposeElement('Column')).toBe('Layout');
        expect(classifyComposeElement('Row')).toBe('Layout');
        expect(classifyComposeElement('Box')).toBe('Layout');
        expect(classifyComposeElement('Scaffold')).toBe('Layout');
    });
    it('PascalCase user composable → Custom', () => {
        expect(classifyComposeElement('LoginScreen')).toBe('Custom');
    });
});

describe('classifyComposeSource', () => {
    it('counts Compose invocations in a composable body', () => {
        const src = `
            @Composable
            fun LoginScreen() {
                Column {
                    Text("Welcome")
                    TextField(value = email, onValueChange = { email = it })
                    Button(onClick = { login() }) {
                        Text("Sign in")
                    }
                }
            }
        `;
        const out = classifyComposeSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(2);
        expect(out.get('Input')).toBe(1);
        expect(out.get('Button')).toBe(1);
    });

    it('ignores `class Foo` / `fun bar` style declarations', () => {
        const src = `
            class MyViewModel { val state = 0 }
            fun privateHelper() = 42
        `;
        const out = classifyComposeSource(src);
        expect(out.size).toBe(0);
    });

    it('does not count Modifier as a visual element', () => {
        const src = `
            @Composable
            fun Foo() {
                Box(modifier = Modifier.padding(8.dp)) {
                    Text("x")
                }
            }
        `;
        const out = classifyComposeSource(src);
        expect(out.get('Layout')).toBe(1); // Box
        expect(out.get('Label')).toBe(1);  // Text
        // Modifier should NOT be counted as Layout/Custom.
        expect(out.get('Custom') ?? 0).toBe(0);
    });
});
