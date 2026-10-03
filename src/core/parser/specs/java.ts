/**
 * specs/java.ts — Java language spec.
 *
 * Mature contract: includes class-hierarchy + Spring-style field-injection
 * extractors. The latter looks at every `field_declaration` in a class
 * body, skips JDK / collection / Spring-wrapper types, and maps the
 * field's *variable name* (e.g. `todoService`) → import source so the
 * BFS receiver resolver can chase `todoService.listFavorites()` even
 * when the dependency is `@Autowired` field-injected rather than passed
 * via constructor.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const JAVA_SPEC: LanguageSpec = {
    functionTypes: ['method_declaration', 'constructor_declaration'],
    classTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    importTypes: ['import_declaration'],
    variableTypes: ['field_declaration'],
    getFunctionName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getClassName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChildByField(node, 'parameters');
        const paramText = params ? nodeText(params, source) : '()';
        const typeNode = findChildByField(node, 'type');
        const returnType = typeNode ? nodeText(typeNode, source) + ' ' : '';
        return `${returnType}${name}${paramText}`;
    },
    getImports(node, source) {
        const text = nodeText(node, source);
        const match = text.match(/import\s+(?:static\s+)?([^\s;]+)/);
        if (match) {
            const fullPath = match[1];
            const parts = fullPath.split('.');
            const localName = parts[parts.length - 1];
            return [{ local: localName, source: fullPath }];
        }
        return [];
    },
    getVariableName(node) {
        const declarator = findChild(node, 'variable_declarator');
        if (declarator) {
            const nameNode = findChildByField(declarator, 'name');
            return nameNode?.text ?? null;
        }
        return null;
    },
    getDecorators(node, source) {
        const decorators: string[] = [];
        // Java annotations (marker_annotation, annotation)
        let prev = node.previousSibling;
        while (prev && (prev.type === 'marker_annotation' || prev.type === 'annotation')) {
            decorators.push(nodeText(prev, source));
            prev = prev.previousSibling;
        }
        // Also check modifiers node which may contain annotations
        const modifiers = findChild(node, 'modifiers');
        if (modifiers) {
            for (const child of modifiers.children) {
                if (child.type === 'marker_annotation' || child.type === 'annotation') {
                    decorators.push(nodeText(child, source));
                }
            }
        }
        return decorators;
    },
    getClassHierarchy(classNode, source) {
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // Java: class Foo extends Bar implements Baz, Qux
        const superclass = findChildByField(classNode, 'superclass');
        if (superclass) {
            // superclass node wraps a type_identifier or generic_type
            const typeId = findChild(superclass, 'type_identifier') ?? findChild(superclass, 'generic_type');
            if (typeId) {
                extendsClass = typeId.type === 'generic_type'
                    ? (findChild(typeId, 'type_identifier')?.text ?? typeId.text)
                    : typeId.text;
            } else {
                extendsClass = superclass.text;
            }
        }
        const interfaces = findChildByField(classNode, 'interfaces');
        if (interfaces) {
            // super_interfaces / interfaces node contains type_list with type_identifiers
            const typeIds = interfaces.descendantsOfType('type_identifier');
            for (const t of typeIds) implementsInterfaces.push(t.text);
        }
        // Strip generic params from extends (e.g. 'Repository<Todo>' → 'Repository')
        if (extendsClass) extendsClass = extendsClass.replace(/<.*>$/, '');
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
    getFieldDependencies(classBodyNode, existingImports) {
        // Java built-in and commonly-used stdlib types that should not appear as participants
        const JAVA_BUILTIN_TYPES = new Set([
            'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short', 'Character',
            'Object', 'Number', 'Void', 'Class', 'Enum', 'Record',
            'List', 'Map', 'Set', 'Collection', 'Queue', 'Deque', 'ArrayList', 'HashMap', 'HashSet',
            'Optional', 'Stream', 'Iterator', 'Iterable', 'Comparable', 'Comparator',
            'StringBuilder', 'StringBuffer', 'Arrays', 'Collections', 'Objects',
            'Exception', 'RuntimeException', 'Error', 'Throwable',
            'Thread', 'Runnable', 'Callable', 'Future', 'CompletableFuture',
            'Math', 'System', 'Runtime',
            // Spring response/request wrappers commonly used as field types
            'ResponseEntity', 'RequestMapping', 'HttpStatus',
        ]);
        const result: Array<{ local: string; source: string }> = [];
        for (const child of classBodyNode.children) {
            if (child.type !== 'field_declaration') continue;
            // type_identifier for simple class names, generic_type for List<Foo> etc.
            const typeNode = findChildByField(child, 'type') ?? findChild(child, 'type_identifier');
            if (!typeNode) continue;
            const typeName = typeNode.type === 'generic_type'
                ? (findChild(typeNode, 'type_identifier')?.text ?? null)
                : typeNode.text;
            if (!typeName) continue;
            // Only class references (uppercase first letter, simple identifier)
            if (!/^[A-Z][A-Za-z0-9_]*$/.test(typeName)) continue;
            // Skip Java built-ins and wrappers
            if (JAVA_BUILTIN_TYPES.has(typeName)) continue;
            // Use the field variable name (e.g. 'todoService') as local key so the BFS
            // can resolve receiver calls like `todoService.listFavorites()`.
            // Fall back to typeName if no declarator found.
            const declarator = findChild(child, 'variable_declarator');
            const fieldName = declarator ? (findChildByField(declarator, 'name')?.text ?? typeName) : typeName;
            // If the type is already in imports, map field name → full source path
            // so BFS can resolve calls exactly (e.g. userRepository → com.example.UserRepository)
            if (existingImports.has(typeName)) {
                result.push({ local: fieldName, source: existingImports.get(typeName)! });
                continue;
            }
            result.push({ local: fieldName, source: typeName });
        }
        return result;
    },
};
