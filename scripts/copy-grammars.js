const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out');
const destDir = path.join(__dirname, '..', 'grammars');

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// Ensure the source directory exists
if (!fs.existsSync(srcDir)) {
    console.error('Source directory not found. Please run "npm install" first.');
    process.exit(1);
}

// List of required grammars
const requiredGrammars = [
    'tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-java.wasm',
    'tree-sitter-kotlin.wasm',
    'tree-sitter-go.wasm',
    'tree-sitter-rust.wasm',
    'tree-sitter-c.wasm',
    'tree-sitter-cpp.wasm',
    'tree-sitter-c_sharp.wasm',
    'tree-sitter-php.wasm',
    'tree-sitter-ruby.wasm',
    'tree-sitter-swift.wasm',
    'tree-sitter-dart.wasm'
];

let successCount = 0;

for (const grammar of requiredGrammars) {
    const srcPath = path.join(srcDir, grammar);
    const destPath = path.join(destDir, grammar);

    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied ${grammar}`);
        successCount++;
    } else {
        console.warn(`WARNING: Grammar not found: ${grammar}`);
    }
}

console.log(`Successfully copied ${successCount}/${requiredGrammars.length} grammars to ${destDir}`);
