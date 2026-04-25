import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SymbolKind } from 'vscode-languageserver/node.js';

import { parseSource } from '../src/parser/c3-parser.js';

test('parseSource extracts the module name and top-level function symbols', () => {
  const file = 'testdata/simple/main.c3';
  const uri = pathToFileURL(file).toString();
  const parsed = parseSource(uri, readFileSync(file, 'utf8'));

  assert.equal(parsed.uri, uri);
  assert.equal(parsed.moduleName, 'http_demo');
  assert.deepEqual(
    parsed.symbols.map((symbol) => symbol.name),
    ['main'],
  );
  assert.equal(parsed.symbols[0]?.kind, SymbolKind.Function);
  assert.equal(parsed.symbols[0]?.signature, 'int main(String[] args)');
});

test('parseSource extracts multiple top-level declaration kinds', () => {
  const file = 'testdata/simple/http.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.equal(parsed.moduleName, 'http_demo');
  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
    ]),
    [
      ['HttpResponse', SymbolKind.Struct, 'struct HttpResponse'],
      [
        'read_response',
        SymbolKind.Function,
        'void read_response(HttpResponse* res)',
      ],
    ],
  );
});

test('parseSource extracts import paths', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'import lib::net;', 'fn void use() {}', ''].join('\n'),
  );

  assert.equal(parsed.moduleName, 'app');
  assert.deepEqual(parsed.imports, ['lib::net']);
  assert.deepEqual(
    parsed.symbols.map((symbol) => symbol.name),
    ['use'],
  );
});
