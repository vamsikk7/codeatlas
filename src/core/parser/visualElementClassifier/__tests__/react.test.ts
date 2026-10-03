/**
 * react.test.ts — Issue #485-VISUAL React + React Native classifier.
 */

import { describe, it, expect } from 'vitest';
import {
    classifyReactElement,
    classifyReactSource,
    classifyComponentReturn,
} from '../react';

describe('classifyReactElement — HTML primitives', () => {
    it('button → Button', () => expect(classifyReactElement('button')).toBe('Button'));
    it('input → Input', () => expect(classifyReactElement('input')).toBe('Input'));
    it('select → Picker', () => expect(classifyReactElement('select')).toBe('Picker'));
    it('ul → List', () => expect(classifyReactElement('ul')).toBe('List'));
    it('img → Image', () => expect(classifyReactElement('img')).toBe('Image'));
    it('form → Form', () => expect(classifyReactElement('form')).toBe('Form'));
    it('div → Layout', () => expect(classifyReactElement('div')).toBe('Layout'));
    it('hr → Divider', () => expect(classifyReactElement('hr')).toBe('Divider'));
});

describe('classifyReactElement — React Native primitives', () => {
    it('TouchableOpacity → Button', () => expect(classifyReactElement('TouchableOpacity')).toBe('Button'));
    it('Pressable → Button', () => expect(classifyReactElement('Pressable')).toBe('Button'));
    it('TextInput → Input', () => expect(classifyReactElement('TextInput')).toBe('Input'));
    it('Switch → Toggle', () => expect(classifyReactElement('Switch')).toBe('Toggle'));
    it('FlatList → List', () => expect(classifyReactElement('FlatList')).toBe('List'));
    it('SectionList → List', () => expect(classifyReactElement('SectionList')).toBe('List'));
    it('Text → Label', () => expect(classifyReactElement('Text')).toBe('Label'));
    it('Image → Image', () => expect(classifyReactElement('Image')).toBe('Image'));
    it('View → Layout', () => expect(classifyReactElement('View')).toBe('Layout'));
    it('ScrollView → Layout', () => expect(classifyReactElement('ScrollView')).toBe('Layout'));
    it('ActivityIndicator → Indicator', () => expect(classifyReactElement('ActivityIndicator')).toBe('Indicator'));
    it('Modal → Modal', () => expect(classifyReactElement('Modal')).toBe('Modal'));
});

describe('classifyReactElement — Custom + unknown', () => {
    it('PascalCase user component → Custom', () => {
        expect(classifyReactElement('LoginForm')).toBe('Custom');
        expect(classifyReactElement('UserCard')).toBe('Custom');
    });
    it('lowercase non-primitive → undefined', () => {
        expect(classifyReactElement('foobar')).toBeUndefined();
    });
    it('empty / null → undefined', () => {
        expect(classifyReactElement('')).toBeUndefined();
    });
});

describe('classifyReactSource — JSX scan', () => {
    it('counts button / input / div from a small JSX snippet', () => {
        const src = `
            export default function Form() {
                return (
                    <form>
                        <div>
                            <label>Name</label>
                            <input type="text" />
                        </div>
                        <button>Submit</button>
                    </form>
                );
            }
        `;
        const out = classifyReactSource(src);
        expect(out.get('Form')).toBe(1);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
        expect(out.get('Input')).toBe(1);
        expect(out.get('Button')).toBe(1);
    });

    it('counts React Native elements in a screen', () => {
        const src = `
            export function HomeScreen() {
                return (
                    <View style={styles.container}>
                        <Text style={styles.title}>Welcome</Text>
                        <FlatList data={items} renderItem={renderItem} />
                        <TouchableOpacity onPress={onAdd}>
                            <Text>Add</Text>
                        </TouchableOpacity>
                    </View>
                );
            }
        `;
        const out = classifyReactSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(2); // two <Text> blocks
        expect(out.get('List')).toBe(1);
        expect(out.get('Button')).toBe(1);
    });

    it('treats <Foo.Bar> dotted-namespace tags by their leaf name', () => {
        const src = `
            export default () => (
                <Stack.Navigator>
                    <Stack.Screen name="Home" component={Home} />
                </Stack.Navigator>
            );
        `;
        const out = classifyReactSource(src);
        // `Navigator` + `Screen` are unrecognised → PascalCase → Custom.
        expect(out.get('Custom')).toBe(2);
    });

    it('ignores JSX-looking content inside string literals', () => {
        const src = `
            const note = "<input> is a tag";
            export default () => <div>{note}</div>;
        `;
        const out = classifyReactSource(src);
        expect(out.get('Layout')).toBe(1);
        // The <input> in the string should NOT bump the count.
        expect(out.get('Input')).toBeUndefined();
    });

    it('does not double-count closing tags', () => {
        const src = `<View><Text>hello</Text></View>`;
        const out = classifyReactSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
    });
});

describe('classifyComponentReturn — bottom-up summary', () => {
    it('summarises immediate children inside a component return', () => {
        const src = `
            export function LoginForm() {
                return (
                    <form>
                        <input type="email" />
                        <input type="password" />
                        <button>Sign in</button>
                    </form>
                );
            }
        `;
        const summary = classifyComponentReturn(src, 'LoginForm');
        expect(summary?.kind).toBe('Custom');
        expect(summary?.originalName).toBe('LoginForm');
        expect(summary?.nestedCounts?.Form).toBe(1);
        expect(summary?.nestedCounts?.Input).toBe(2);
        expect(summary?.nestedCounts?.Button).toBe(1);
    });

    it('returns undefined for missing components', () => {
        expect(classifyComponentReturn('export const x = 1;', 'Missing')).toBeUndefined();
    });
});
