import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SymbolKind } from 'vscode-languageserver/node.js';

import { documentSymbols } from '../src/lsp/document-symbols.js';
import { parseSource } from '../src/parser/c3-parser.js';

test('documentSymbols includes nested declaration children', () => {
  const file = 'testdata/phase1/syntax.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );
  const symbols = documentSymbols(parsed);
  const user = symbols.find((symbol) => symbol.name === 'User');
  const reader = symbols.find((symbol) => symbol.name === 'Reader');
  const add = symbols.find((symbol) => symbol.name === 'add');

  assert.deepEqual(
    user?.children?.map((symbol) => [symbol.name, symbol.kind]),
    [
      ['name', SymbolKind.Field],
      ['age', SymbolKind.Field],
    ],
  );
  assert.deepEqual(
    reader?.children?.map((symbol) => [symbol.name, symbol.kind]),
    [['read', SymbolKind.Method]],
  );
  assert.deepEqual(
    add?.children?.map((symbol) => [symbol.name, symbol.kind]),
    [
      ['a', SymbolKind.Variable],
      ['b', SymbolKind.Variable],
    ],
  );
});
