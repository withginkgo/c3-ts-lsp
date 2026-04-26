import assert from 'node:assert/strict';
import { test } from 'node:test';

import { semanticDiagnostics } from '../src/analysis/diagnostics.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('semanticDiagnostics reports unresolved imports', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'import missing::net;', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved import 'missing::net'"],
  );
});

test('semanticDiagnostics accepts relative imports', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'import net;', ''].join('\n'),
  );
  const net = parseSource(
    'file:///workspace/net.c3',
    ['module app::net;', 'fn void connect() {}', ''].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(net, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports unresolved module alias targets', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'alias net = module missing::net;', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved module alias target 'missing::net'"],
  );
});

test('semanticDiagnostics reports unresolved expression symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'fn void use() {', '    missing();', '}', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved symbol 'missing'"],
  );
});

test('semanticDiagnostics resolves qualified imported macros recovered from stdlib parse errors', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stdlibUri = 'file:///stdlib/std/io.c3';
  const app = parseSource(
    appUri,
    [
      'module app;',
      'import std::io;',
      'fn void use() {',
      '    io::printn("hello");',
      '}',
      '',
    ].join('\n'),
  );
  const stdlib = parseSource(
    stdlibUri,
    [
      'module std::io;',
      '???',
      'macro void printn(x = "")',
      '{',
      '}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(stdlib, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports unresolved members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct HttpResponse {',
      '    String body;',
      '}',
      'fn void use() {',
      '    HttpResponse res;',
      '    res.missing;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved symbol 'missing'"],
  );
});

test('semanticDiagnostics accepts resolved members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct HttpResponse {',
      '    String body;',
      '}',
      'fn void use() {',
      '    HttpResponse res;',
      '    res.body;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics reports ambiguous expression symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const app = parseSource(
    appUri,
    [
      'module app;',
      'import lib::one;',
      'import lib::two;',
      'fn void use() {',
      '    connect();',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(
    parseSource(
      'file:///workspace/lib/one.c3',
      'module lib::one;\nfn void connect() {}\n',
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///workspace/lib/two.c3',
      'module lib::two;\nfn void connect() {}\n',
    ),
    false,
  );
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ["Ambiguous symbol 'connect' (2 candidates)"],
  );
});

test('semanticDiagnostics accepts overloads resolved by literal argument types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int add(int a) { return a; }',
      'fn float add(float a) { return a; }',
      'fn void use() {',
      '    add(1);',
      '    add(1.0);',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});
