import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';

const file = process.argv[2] ?? 'testdata/simple/main.c3';
const source = fs.readFileSync(file, 'utf8');
const parsed = parseSource(pathToFileURL(file).toString(), source);
const root = parsed.tree.rootNode;

console.log(root.toString());

console.log('\n=== top level nodes ===');

for (let i = 0; i < root.namedChildCount; i++) {
  const node = root.namedChild(i);
  if (!node) continue;

  console.log(`${i}: ${node.type} => ${node.text.split('\n')[0]}`);
}
