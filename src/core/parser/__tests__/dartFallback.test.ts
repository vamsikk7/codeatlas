/**
 * dartFallback.test.ts
 *
 * Coverage for the Dart regex fallback in `treeSitterExtractor` (#346 + #359).
 * The fallback runs when tree-sitter-wasms@0.1.13's Dart grammar can't parse
 * 3.x syntax cleanly. Each test asserts a specific 3.x construct is surfaced
 * as a class entity by the regex pass.
 */

import { describe, it, expect } from 'vitest';
import { extractFileSymbolsMultiLang } from '../treeSitterExtractor';

async function extract(source: string, fileName = 'test.dart') {
    return extractFileSymbolsMultiLang(source, fileName, 'dart');
}

describe('Dart regex fallback — 3.x declarations', () => {
    it('detects a vanilla Dart 3.x sealed class', async () => {
        const src = `
sealed class Result<T> {}
class Ok<T> extends Result<T> { Ok(this.value); final T value; }
class Err<T> extends Result<T> { Err(this.error); final Object error; }
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toContain('Result');
        expect(names).toContain('Ok');
        expect(names).toContain('Err');
    });

    it('detects abstract final / interface / base class modifiers', async () => {
        const src = `
abstract final class Shape {}
interface class Drawable {}
base class Mutable {}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toEqual(expect.arrayContaining(['Shape', 'Drawable', 'Mutable']));
    });

    it('detects Dart 3.3 extension types', async () => {
        const src = `
extension type Money(int amount) {
    Money operator +(Money other) => Money(amount + other.amount);
    bool get isZero => amount == 0;
}
extension type const Distance(double meters) {
    bool get isZero => meters == 0;
}
extension type Email._(String _value) {
    Email(String value) : _value = value;
}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toContain('Money');
        expect(names).toContain('Distance');
    });

    it('detects mixin declarations including base + on Bar form', async () => {
        const src = `
mixin Logger {
    void log(String msg) { print(msg); }
}
mixin Foo on Bar {
    void hello() {}
}
base mixin Sealed {}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toEqual(expect.arrayContaining(['Logger', 'Foo', 'Sealed']));
    });

    it('detects enum-with-methods (Dart 2.17+ enhanced enums)', async () => {
        const src = `
enum Status {
    active,
    inactive,
    archived;

    bool get isActive => this == Status.active;
    void describe() { print('status: $name'); }
}
enum Priority<T> implements Comparable<Priority<T>> {
    low(1),
    medium(2),
    high(3);

    const Priority(this.value);
    final int value;
    @override
    int compareTo(Priority<T> other) => value - other.value;
}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toContain('Status');
        expect(names).toContain('Priority');
    });

    it('detects top-level functions with Dart 3.x return types and async modifiers', async () => {
        const src = `
Future<List<int>> fetchAll() async {
    return [];
}
Stream<String> watch() async* {
    yield "hello";
}
void main() {}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toEqual(expect.arrayContaining(['fetchAll', 'watch', 'main']));
    });

    it('imports are captured into importsByLocal map', async () => {
        const src = `
import 'package:flutter/material.dart';
import 'package:foo/bar.dart' as bar;
import 'src/utils.dart';

class App extends StatelessWidget {}
`;
        const a = await extract(src);
        // Either the package name or the alias should be the local key.
        const localKeys = Array.from(a.importsByLocal.keys());
        expect(localKeys).toEqual(expect.arrayContaining(['material', 'bar', 'utils']));
    });
});

describe('Dart regex fallback — robustness', () => {
    it('does not surface keywords as method names', async () => {
        const src = `
class Foo {
    void process() {
        if (true) {
            return;
        }
        for (var i = 0; i < 10; i++) {}
        switch (state) { case 'a': break; }
    }
}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toContain('Foo');
        expect(names).toContain('process');
        // Reserved words must not be misread as methods.
        expect(names).not.toContain('if');
        expect(names).not.toContain('for');
        expect(names).not.toContain('switch');
        expect(names).not.toContain('return');
        expect(names).not.toContain('case');
    });

    it('skips identifiers inside comments and strings', async () => {
        const src = `
// class Fake {}
/* class AlsoFake {} */
class Real {
    String comment = "class StringClass {}";
    String single = 'class SingleClass {}';
}
`;
        const a = await extract(src);
        const names = a.entities.map((e: any) => e.name);
        expect(names).toContain('Real');
        expect(names).not.toContain('Fake');
        expect(names).not.toContain('AlsoFake');
        expect(names).not.toContain('StringClass');
        expect(names).not.toContain('SingleClass');
    });
});
