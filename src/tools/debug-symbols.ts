import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';

const file = process.argv[2] ?? 'testdata/simple/main.c3';
const source = fs.readFileSync(file, 'utf8');
const parsed = parseSource(pathToFileURL(file).toString(), source);

console.log('module:', parsed.moduleName);
console.log('symbols:');

for (const symbol of parsed.symbols) {
  console.log(`  ${symbol.name} => ${symbol.signature}`);
}
