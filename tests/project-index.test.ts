import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

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
