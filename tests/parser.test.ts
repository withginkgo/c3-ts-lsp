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

test('parseSource extracts scoped parameters and local declarations', () => {
  const file = 'testdata/simple/main.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.deepEqual(
    parsed.scopedSymbols.map((symbol) => [
      symbol.name,
      symbol.signature,
      symbol.returnType,
    ]),
    [
      ['args', 'String[] args', 'String[]'],
      ['res', 'HttpResponse res;', 'HttpResponse'],
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
  assert.equal(parsed.importSpecs[0]?.path, 'lib::net');
  assert.deepEqual(
    parsed.symbols.map((symbol) => symbol.name),
    ['use'],
  );
});

test('parseSource extracts module aliases', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'alias net = module lib::net;',
      'fn void use() {}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(parsed.moduleAliases, [
    {
      name: 'net',
      target: 'lib::net',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 28 },
      },
      selectionRange: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 9 },
      },
      targetRange: {
        start: { line: 1, character: 19 },
        end: { line: 1, character: 27 },
      },
    },
  ]);
});

test('parseSource extracts Phase 1 top-level declaration coverage', () => {
  const file = 'testdata/phase1/syntax.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.equal(parsed.moduleName, 'phase1');
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
    ]),
    [
      ['User', SymbolKind.Struct, 'struct User @packed'],
      ['Value', SymbolKind.Struct, 'union Value'],
      ['Flags', SymbolKind.Struct, 'bitstruct Flags : uint'],
      ['Color', SymbolKind.Enum, 'enum Color : int'],
      ['ErrorCode', SymbolKind.Constant, 'constdef ErrorCode : int'],
      ['Reader', SymbolKind.Interface, 'interface Reader'],
      ['NOT_FOUND', SymbolKind.Constant, 'faultdef NOT_FOUND, DENIED;'],
      ['DENIED', SymbolKind.Constant, 'faultdef NOT_FOUND, DENIED;'],
      ['Name', SymbolKind.TypeParameter, 'typedef Name = String;'],
      ['UserName', SymbolKind.TypeParameter, 'alias UserName = String;'],
      ['@Route', SymbolKind.Property, 'attrdef @Route(String path);'],
      ['global_count', SymbolKind.Variable, 'int global_count;'],
      ['imported', SymbolKind.Function, 'void imported()'],
      ['trace', SymbolKind.Function, 'macro void trace(String msg)'],
      ['add', SymbolKind.Function, 'int add(int a, int b)'],
    ],
  );
});

test('parseSource extracts nested members, parameters, docs, attrs, and body ranges', () => {
  const file = 'testdata/phase1/syntax.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );
  const user = parsed.symbols.find((symbol) => symbol.name === 'User');
  const name = user?.children.find((symbol) => symbol.name === 'name');
  const color = parsed.symbols.find((symbol) => symbol.name === 'Color');
  const reader = parsed.symbols.find((symbol) => symbol.name === 'Reader');
  const trace = parsed.symbols.find((symbol) => symbol.name === 'trace');
  const add = parsed.symbols.find((symbol) => symbol.name === 'add');

  assert.equal(user?.documentation, '"User docs"');
  assert.deepEqual(user?.attributes, ['@packed']);
  assert.equal(user?.bodyRange?.start.line, 4);
  assert.deepEqual(
    user?.children.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.returnType,
    ]),
    [
      ['name', SymbolKind.Field, 'String'],
      ['age', SymbolKind.Field, 'int'],
    ],
  );
  assert.equal(name?.documentation, '"Field docs"');
  assert.deepEqual(name?.attributes, ['@required']);
  assert.deepEqual(
    color?.children.map((symbol) => symbol.name),
    ['RED', 'GREEN', 'BLUE'],
  );
  assert.deepEqual(
    reader?.children.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.children.map((child) => child.name),
    ]),
    [['read', SymbolKind.Method, ['path']]],
  );
  assert.deepEqual(trace?.parameters, ['String msg']);
  assert.deepEqual(add?.parameters, ['int a', 'int b']);
});

test('parseSource extracts type methods and gives self the receiver type', () => {
  const source = [
    'module app;',
    'struct EventLoop {',
    '    bool running;',
    '}',
    'fn void EventLoop.init(&self)',
    '{',
    '    self.running = true;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource('file:///workspace/app.c3', source);
  const method = parsed.symbols.find((symbol) => symbol.name === 'init');
  const self = parsed.scopedSymbols.find((symbol) => symbol.name === 'self');

  assert.equal(method?.kind, SymbolKind.Method);
  assert.equal(method?.receiverType, 'EventLoop');
  assert.equal(method?.signature, 'void EventLoop.init(&self)');
  assert.equal(self?.returnType, 'EventLoop');
});

test('parseSource reports tree-sitter syntax diagnostics', () => {
  const parsed = parseSource(
    'file:///workspace/broken.c3',
    ['module broken;', 'fn void nope( {', ''].join('\n'),
  );

  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0]?.severity, 1);
  assert.equal(
    parsed.diagnostics[0]?.message,
    'Syntax error: unable to parse this C3 syntax',
  );
  assert.equal(parsed.diagnostics[0]?.source, 'tree-sitter-c3');
});

test('parseSource recovers top-level callables after parser errors', () => {
  const parsed = parseSource(
    'file:///workspace/std/io.c3',
    [
      'module std::io;',
      '???',
      'macro void printn(x = "")',
      '{',
      '}',
      'fn sz? printfn(String format, args...) @format(0) @maydiscard',
      '{',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
      symbol.returnType,
      symbol.parameters,
    ]),
    [
      [
        'printn',
        SymbolKind.Function,
        'macro void printn(x = "")',
        'void',
        ['x = ""'],
      ],
      [
        'printfn',
        SymbolKind.Function,
        'fn sz? printfn(String format, args...) @format(0) @maydiscard',
        'sz?',
        ['String format', 'args...'],
      ],
    ],
  );
});

test('parseSource recovers type methods after parser errors', () => {
  const parsed = parseSource(
    'file:///workspace/std/collections/map.c3',
    [
      'module std::collections::map <Key, Value>;',
      '???',
      'fn HashMap* HashMap.init(&self, Allocator allocator)',
      '{',
      '}',
      'fn bool HashMap.set(&map, Key key, Value value) @operator([]=)',
      '{',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.receiverType,
      symbol.children.map((child) => [child.name, child.returnType]),
    ]),
    [
      [
        'init',
        SymbolKind.Method,
        'HashMap',
        [
          ['self', 'HashMap'],
          ['allocator', 'Allocator'],
        ],
      ],
      [
        'set',
        SymbolKind.Method,
        'HashMap',
        [
          ['map', 'HashMap'],
          ['key', 'Key'],
          ['value', 'Value'],
        ],
      ],
    ],
  );
});
