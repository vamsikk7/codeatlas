/**
 * flutter.test.ts — Issue #485-VISUAL Flutter classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyFlutterElement, classifyFlutterSource } from '../flutter';

describe('classifyFlutterElement', () => {
    it('Button variants', () => {
        expect(classifyFlutterElement('ElevatedButton')).toBe('Button');
        expect(classifyFlutterElement('OutlinedButton')).toBe('Button');
        expect(classifyFlutterElement('TextButton')).toBe('Button');
        expect(classifyFlutterElement('CupertinoButton')).toBe('Button');
        expect(classifyFlutterElement('InkWell')).toBe('Button');
    });

    it('Inputs', () => {
        expect(classifyFlutterElement('TextField')).toBe('Input');
        expect(classifyFlutterElement('TextFormField')).toBe('Input');
    });

    it('Layouts', () => {
        expect(classifyFlutterElement('Container')).toBe('Layout');
        expect(classifyFlutterElement('Row')).toBe('Layout');
        expect(classifyFlutterElement('Column')).toBe('Layout');
        expect(classifyFlutterElement('Stack')).toBe('Layout');
        expect(classifyFlutterElement('Scaffold')).toBe('Layout');
    });

    it('Lists / Labels / Images / Indicators', () => {
        expect(classifyFlutterElement('ListView')).toBe('List');
        expect(classifyFlutterElement('Text')).toBe('Label');
        expect(classifyFlutterElement('Image')).toBe('Image');
        expect(classifyFlutterElement('CircularProgressIndicator')).toBe('Indicator');
    });

    it('PascalCase user widget → Custom', () => {
        expect(classifyFlutterElement('LoginScreen')).toBe('Custom');
    });
});

describe('classifyFlutterSource', () => {
    it('counts Flutter widget invocations in a build body', () => {
        const src = `
            class LoginScreen extends StatelessWidget {
                @override
                Widget build(BuildContext context) {
                    return Scaffold(
                        appBar: AppBar(title: Text('Login')),
                        body: Column(
                            children: [
                                TextField(decoration: InputDecoration(labelText: 'Email')),
                                TextField(decoration: InputDecoration(labelText: 'Password')),
                                ElevatedButton(
                                    onPressed: () {},
                                    child: Text('Sign in'),
                                ),
                            ],
                        ),
                    );
                }
            }
        `;
        const out = classifyFlutterSource(src);
        expect(out.get('Layout')).toBeGreaterThanOrEqual(2); // Scaffold + AppBar + Column
        expect(out.get('Label')).toBe(2);
        expect(out.get('Input')).toBe(2);
        expect(out.get('Button')).toBe(1);
        // LoginScreen and BuildContext shouldn't appear.
        expect(out.get('Custom') ?? 0).toBe(0);
    });

    it('ignores helper types like BuildContext / EdgeInsets / Colors', () => {
        const src = `
            Container(
                padding: EdgeInsets.all(8),
                color: Colors.red,
                child: Text('hi'),
            )
        `;
        const out = classifyFlutterSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
        // No Custom for EdgeInsets / Colors / Container.
        expect(out.get('Custom') ?? 0).toBe(0);
    });
});
