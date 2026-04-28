import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Range } from 'vscode-languageserver/node.js';

import { inlayHints } from '../src/lsp/inlay-hints.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('inlayHints shows inferred types for var declarations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn int make() { return 1; }',
    'fn void use() {',
    '    var value @safeinfer = make();',
    '    var count @safeinfer = 1;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const hints = inlayHints(
    index,
    parsed,
    Range.create(0, 0, 6, 0),
  );

  assert.deepEqual(
    hints.map((hint) => [hint.position, hint.label, hint.kind]),
    [
      [{ line: 3, character: 13 }, ': int', 1],
      [{ line: 4, character: 13 }, ': int', 1],
    ],
  );
});

test('inlayHints shows inferred enum constant types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'enum SocketOption : char {',
    '    REUSEADDR,',
    '}',
    'fn void use() {',
    '    var option @safeinfer = SocketOption.REUSEADDR;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const hints = inlayHints(index, parsed, Range.create(0, 0, 8, 0));

  assert.deepEqual(
    hints.map((hint) => [hint.position, hint.label, hint.kind]),
    [[{ line: 5, character: 14 }, ': SocketOption', 1]],
  );
});

test('inlayHints skips unsafe var declarations in normal functions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use() {',
    '    var count = 1;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  assert.deepEqual(
    inlayHints(index, parsed, Range.create(0, 0, 5, 0)),
    [],
  );
});
