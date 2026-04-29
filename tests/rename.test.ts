import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { prepareRename, renameSymbol } from '../src/lsp/rename.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('renameSymbol edits declarations and qualified references across files', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void use() {',
    '    net::connect();',
    '}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);
  const app = parseSource(appUri, appSource);

  index.upsert(app, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const edit = renameSymbol(
    index,
    doc,
    app,
    doc.positionAt(appSource.indexOf('connect();')),
    'dial',
  );

  assert.deepEqual(edit?.changes?.[netUri], [
    {
      range: {
        start: { line: 1, character: 8 },
        end: { line: 1, character: 15 },
      },
      newText: 'dial',
    },
  ]);
  assert.deepEqual(edit?.changes?.[appUri], [
    {
      range: {
        start: { line: 3, character: 9 },
        end: { line: 3, character: 16 },
      },
      newText: 'dial',
    },
  ]);

  assert.deepEqual(
    prepareRename(
      index,
      doc,
      app,
      doc.positionAt(appSource.indexOf('connect();')),
    )?.range,
    {
      start: { line: 3, character: 9 },
      end: { line: 3, character: 16 },
    },
  );
});

test('prepareRename rejects stdlib symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stdlibUri = 'file:///stdlib/std/io.c3';
  const appSource = [
    'module app;',
    'import std::io;',
    'fn void use() {',
    '    print("hello");',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);
  const app = parseSource(appUri, appSource);

  index.upsert(app, false);
  index.upsert(
    parseSource(
      stdlibUri,
      'module std::io;\nfn void print(String value) {}\n',
      {
        sourceKind: 'stdlib',
      },
    ),
    false,
  );
  index.rebuild();

  assert.equal(
    prepareRename(index, doc, app, doc.positionAt(appSource.indexOf('print'))),
    null,
  );
});
