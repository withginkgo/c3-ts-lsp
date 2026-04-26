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
    '    var value = make();',
    '    var count = 1;',
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
