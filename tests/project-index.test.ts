import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('ProjectIndex groups files from the same module', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();

  index.upsert(
    parseSource(mainUri, readFileSync('testdata/simple/main.c3', 'utf8')),
    false,
  );
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const module = index.getModule('http_demo');

  assert.equal(index.moduleCount(), 1);
  assert.deepEqual(module?.files, [mainUri, httpUri]);
  assert.deepEqual(
    [...(module?.symbols.keys() ?? [])],
    ['main', 'HttpResponse', 'read_response'],
  );
});

test('ProjectIndex resolves symbols from files in the same module', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();

  index.upsert(
    parseSource(mainUri, readFileSync('testdata/simple/main.c3', 'utf8')),
    false,
  );
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const symbol = index.findSymbol(mainUri, 'read_response');

  assert.equal(symbol?.name, 'read_response');
  assert.equal(symbol?.uri, httpUri);
});

test('ProjectIndex resolves imported and qualified module symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';

  index.upsert(
    parseSource(
      appUri,
      ['module app;', 'import lib::net;', 'fn void use() {}', ''].join('\n'),
    ),
    false,
  );
  index.upsert(
    parseSource(
      netUri,
      ['module lib::net;', 'fn void connect() {}', ''].join('\n'),
    ),
    false,
  );
  index.rebuild();

  assert.equal(index.findSymbol(appUri, 'connect')?.uri, netUri);
  assert.equal(index.findSymbol(appUri, 'net::connect')?.uri, netUri);
  assert.equal(index.findSymbol(appUri, 'lib::net::connect')?.uri, netUri);
});

test('ProjectIndex removes closed or deleted documents from the index', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/temp.c3';

  index.upsert(
    parseSource(uri, ['module temp;', 'fn void gone() {}', ''].join('\n')),
  );

  assert.equal(index.findSymbol(uri, 'gone')?.name, 'gone');

  index.remove(uri);

  assert.equal(index.moduleCount(), 0);
  assert.equal(index.findSymbol(uri, 'gone'), undefined);
});

test('ProjectIndex resolves nested declaration symbols for hover and definition', () => {
  const index = new ProjectIndex();
  const uri = pathToFileURL('testdata/phase1/syntax.c3').toString();

  index.upsert(
    parseSource(uri, readFileSync('testdata/phase1/syntax.c3', 'utf8')),
  );

  assert.equal(
    index.findSymbol(uri, 'name')?.signature,
    'String name @required;',
  );
  assert.equal(index.findSymbol(uri, 'GREEN')?.signature, 'GREEN = 2');
  assert.equal(index.findSymbol(uri, 'path')?.signature, 'String path');
  assert.equal(index.findSymbol(uri, 'a')?.signature, 'int a');
});

test('ProjectIndex resolves local declarations by cursor position', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();
  const mainSource = readFileSync('testdata/simple/main.c3', 'utf8');
  const doc = TextDocument.create(mainUri, 'c3', 1, mainSource);

  index.upsert(parseSource(mainUri, mainSource), false);
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const symbol = index.findSymbolAt(
    mainUri,
    'res',
    doc.positionAt(mainSource.indexOf('&res') + 1),
  );

  assert.equal(symbol?.uri, mainUri);
  assert.equal(symbol?.signature, 'HttpResponse res;');
});

test('ProjectIndex does not resolve parameters from unrelated scopes by position', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void takes(int value) {}',
    'fn void use() {',
    '    value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  assert.equal(
    index.findSymbolAt(uri, 'value', doc.positionAt(source.indexOf('value;'))),
    undefined,
  );
});

test('ProjectIndex returns resolve result with selected symbol', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = ['module app;', 'fn void connect() {}', ''].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'connect',
    doc.positionAt(source.indexOf('connect')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.name, 'connect');
  assert.equal(result.candidates.length, 1);
});

test('ProjectIndex reports ambiguous imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const oneUri = 'file:///workspace/lib/one.c3';
  const twoUri = 'file:///workspace/lib/two.c3';

  const appSource = [
    'module app;',
    'import lib::one;',
    'import lib::two;',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(oneUri, 'module lib::one;\nfn void connect() {}\n'),
    false,
  );
  index.upsert(
    parseSource(twoUri, 'module lib::two;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const doc = TextDocument.create(appUri, 'c3', 1, appSource);
  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.indexOf('connect();')),
  );

  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates.length, 2);
});

test('ProjectIndex prefers current module symbols over imported candidates', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void connect() {}',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.lastIndexOf('connect();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, appUri);
  assert.equal(result.candidates.length, 1);
});

test('ProjectIndex position-aware resolver ignores unrelated global symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.indexOf('connect();')),
  );

  assert.equal(result.reason, 'not_found');
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates.length, 0);
});
