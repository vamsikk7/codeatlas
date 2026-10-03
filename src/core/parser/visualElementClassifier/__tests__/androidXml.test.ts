/**
 * androidXml.test.ts — Issue #485-VISUAL Android XML layout classifier.
 */

import { describe, it, expect } from 'vitest';
import { canParseAndroidXml, classifyAndroidXmlElement, classifyAndroidXmlSource } from '../androidXml';

describe('canParseAndroidXml', () => {
    it('matches res/layout XML paths', () => {
        expect(canParseAndroidXml('app/src/main/res/layout/activity_main.xml')).toBe(true);
        expect(canParseAndroidXml('app/src/main/res/layout/fragment_login.xml')).toBe(true);
    });
    it('rejects non-layout XML', () => {
        expect(canParseAndroidXml('AndroidManifest.xml')).toBe(false);
        expect(canParseAndroidXml('build.xml')).toBe(false);
    });
});

describe('classifyAndroidXmlElement', () => {
    it('Button + ImageButton', () => {
        expect(classifyAndroidXmlElement('Button')).toBe('Button');
        expect(classifyAndroidXmlElement('ImageButton')).toBe('Button');
        expect(classifyAndroidXmlElement('MaterialButton')).toBe('Button');
    });

    it('EditText + variants → Input', () => {
        expect(classifyAndroidXmlElement('EditText')).toBe('Input');
        expect(classifyAndroidXmlElement('TextInputEditText')).toBe('Input');
    });

    it('Switch / CheckBox / RadioButton → Toggle', () => {
        expect(classifyAndroidXmlElement('Switch')).toBe('Toggle');
        expect(classifyAndroidXmlElement('CheckBox')).toBe('Toggle');
        expect(classifyAndroidXmlElement('RadioButton')).toBe('Toggle');
    });

    it('Spinner / NumberPicker → Picker', () => {
        expect(classifyAndroidXmlElement('Spinner')).toBe('Picker');
        expect(classifyAndroidXmlElement('NumberPicker')).toBe('Picker');
    });

    it('RecyclerView / ListView → List', () => {
        expect(classifyAndroidXmlElement('RecyclerView')).toBe('List');
        expect(classifyAndroidXmlElement('ListView')).toBe('List');
    });

    it('TextView → Label, ImageView → Image', () => {
        expect(classifyAndroidXmlElement('TextView')).toBe('Label');
        expect(classifyAndroidXmlElement('ImageView')).toBe('Image');
    });

    it('LinearLayout / ConstraintLayout → Layout', () => {
        expect(classifyAndroidXmlElement('LinearLayout')).toBe('Layout');
        expect(classifyAndroidXmlElement('ConstraintLayout')).toBe('Layout');
        expect(classifyAndroidXmlElement('FrameLayout')).toBe('Layout');
    });

    it('handles fully-qualified package names', () => {
        expect(classifyAndroidXmlElement('androidx.constraintlayout.widget.ConstraintLayout')).toBe('Layout');
        expect(classifyAndroidXmlElement('com.google.android.material.button.MaterialButton')).toBe('Button');
    });
});

describe('classifyAndroidXmlSource', () => {
    it('counts elements in a real-shape layout', () => {
        const src = `
            <?xml version="1.0" encoding="utf-8"?>
            <LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
                android:orientation="vertical">

                <TextView
                    android:id="@+id/title"
                    android:text="Sign in" />

                <EditText
                    android:id="@+id/email"
                    android:inputType="textEmailAddress" />

                <EditText
                    android:id="@+id/password"
                    android:inputType="textPassword" />

                <Button
                    android:id="@+id/sign_in"
                    android:text="Sign in" />

            </LinearLayout>
        `;
        const out = classifyAndroidXmlSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
        expect(out.get('Input')).toBe(2);
        expect(out.get('Button')).toBe(1);
    });

    it('strips XML comments', () => {
        const src = `
            <LinearLayout>
                <!-- <Button android:text="commented out" /> -->
                <Button android:text="real" />
            </LinearLayout>
        `;
        const out = classifyAndroidXmlSource(src);
        expect(out.get('Button')).toBe(1);
    });

    it('does not double-count closing tags', () => {
        const src = `<LinearLayout><TextView>hi</TextView></LinearLayout>`;
        const out = classifyAndroidXmlSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
    });
});
