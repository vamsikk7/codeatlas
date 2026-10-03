import * as fs from 'fs';
import * as path from 'path';
import { extractFileSymbolsMultiLang } from '../treeSitterExtractor';
import { setGrammarsDir } from '../treeSitterParser';

async function main() {
    // Set grammars dir to where they actually are when running ts-node locally
    setGrammarsDir(path.resolve(__dirname, '../../../../grammars'));
    
    const filePath = path.resolve(__dirname, 'TodoController.java');
    const source = fs.readFileSync(filePath, 'utf-8');
    
    const analysis = await extractFileSymbolsMultiLang(source, 'TodoController.java', 'java');
    
    console.log("=== Imports ===");
    console.log(analysis.importsByLocal);
    
    console.log("\n=== Injected Deps ===");
    console.log(analysis.injectedDeps);
    
    console.log("\n=== Functions ===");
    for (const [name, func] of analysis.funcs.entries()) {
        console.log(`Function: ${name}`);
        console.log(`  calls:`, Array.from(func.calls || []));
        if (func.memberCalls) {
            console.log(`  memberCalls:`);
            for (const [receiver, methods] of func.memberCalls.entries()) {
                console.log(`    ${receiver} ->`, Array.from(methods));
            }
        }
    }
}

main().catch(console.error);
