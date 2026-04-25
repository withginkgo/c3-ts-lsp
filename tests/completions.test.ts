import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompletionItemKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { completionItems } from '../src/lsp/completions.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('completionItems returns keywords when document context is unavailable', () => {
  const items = completionItems(new ProjectIndex(), undefined, undefined, {
    line: 0,
    character: 0,
  });

  assert.equal(
    items.find((item) => item.label === 'fn')?.kind,
    CompletionItemKind.Keyword,
  );
  assert.equal(
    items.find((item) => item.label === 'module')?.kind,
    CompletionItemKind.Keyword,
  );
});

test('completionItems includes symbols from the current module', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = ['module app;', 'fn void alpha() {}', ''].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.length),
  );

  assert.equal(
    items.find((item) => item.label === 'alpha')?.kind,
    CompletionItemKind.Function,
  );
  assert.equal(
    items.find((item) => item.label === 'alpha')?.detail,
    'void alpha()',
  );
});

test('completionItems includes visible scoped symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use(String path) {',
    '    int count;',
    '    ',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const labels = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(
      source.indexOf(
        '    ',
        source.indexOf('int count;') + 'int count;'.length,
      ) + 4,
    ),
  ).map((item) => item.label);

  assert.equal(labels.includes('path'), true);
  assert.equal(labels.includes('count'), true);
});

test('completionItems returns struct members after member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use() {',
    '    HttpResponse res;',
    '    res.body;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('res.') + 'res.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['body', CompletionItemKind.Field, 'String body;']],
  );
});

test('completionItems returns members for incomplete member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use() {',
    '    HttpResponse res;',
    '    res.',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('res.') + 'res.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['body', CompletionItemKind.Field, 'String body;']],
  );
});

test('completionItems returns members for chained expression receivers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Inner {',
    '    int value;',
    '}',
    'struct Outer {',
    '    Inner inner;',
    '}',
    'fn Outer make() {}',
    'fn void use(Outer outer) {',
    '    outer.inner.value;',
    '    make().inner.value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const localItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('outer.inner.') + 'outer.inner.'.length),
  );
  const callItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('make().inner.') + 'make().inner.'.length),
  );

  assert.deepEqual(
    localItems.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
  );
  assert.deepEqual(
    callItems.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
  );
});

test('completionItems returns members after parenthesized unary receivers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Inner {',
    '    int value;',
    '}',
    'struct Outer {',
    '    Inner inner;',
    '}',
    'fn void use(Outer* pointer) {',
    '    (*pointer).inner.value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('(*pointer).inner.') + '(*pointer).inner.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
  );
});

test('completionItems returns imported module members after a module prefix', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void use() {}',
    '',
  ].join('\n');
  const completionSource = [
    'module app;',
    'import lib::net;',
    'fn void use() {',
    '    net::',
    '}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, completionSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(completionSource.indexOf('net::') + 'net::'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['connect', CompletionItemKind.Function, 'void connect()']],
  );
});

test('completionItems returns module alias members after a module prefix', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'alias net = module lib::net;',
    'fn void use() {}',
    '',
  ].join('\n');
  const completionSource = [
    'module app;',
    'alias net = module lib::net;',
    'fn void use() {',
    '    net::',
    '}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, completionSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(completionSource.indexOf('net::') + 'net::'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['connect', CompletionItemKind.Function, 'void connect()']],
  );
});

test('completionItems includes imported symbols and excludes unrelated modules', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const otherUri = 'file:///workspace/other.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void local() {}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const otherSource = ['module other;', 'fn void unrelated() {}', ''].join(
    '\n',
  );
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.upsert(parseSource(otherUri, otherSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('local'), true);
  assert.equal(labels.includes('connect'), true);
  assert.equal(labels.includes('unrelated'), false);
});

test('completionItems includes relative imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/net.c3';
  const appSource = ['module app;', 'import net;', ''].join('\n');
  const netSource = ['module app::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('connect'), true);
});

test('completionItems excludes private imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = ['module app;', 'import lib::net;', ''].join('\n');
  const netSource = [
    'module lib::net;',
    'fn void hidden() @private {}',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('hidden'), false);
});
