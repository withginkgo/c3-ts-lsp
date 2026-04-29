import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  formatEdits,
  resolveFormatterCommand,
} from '../src/toolchain/formatter.js';

test('resolveFormatterCommand accepts initialization option arrays', () => {
  assert.deepEqual(
    resolveFormatterCommand(
      { formatterCommand: ['c3fmt', '--stdin'] },
      { PATH: '' },
    ),
    { command: 'c3fmt', args: ['--stdin'] },
  );
});

test('formatEdits returns a full document edit for formatted text', () => {
  const doc = TextDocument.create(
    'file:///workspace/app.c3',
    'c3',
    1,
    'module app;\n',
  );
  const edits = formatEdits(doc, 'MODULE APP;\n');

  assert.deepEqual(edits, [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
      newText: 'MODULE APP;\n',
    },
  ]);
});
