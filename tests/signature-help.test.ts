import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { signatureHelp } from '../src/lsp/signature-help.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('signatureHelp returns active function parameter in a single file', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn int add(int left, int right) { return left; }',
    'fn void use() {',
    '    add(1, 2);',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const help = signatureHelp(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('2);')),
  );

  assert.equal(help?.activeParameter, 1);
  assert.deepEqual(
    help?.signatures.map((signature) => [
      signature.label,
      signature.parameters?.map((parameter) => parameter.label),
    ]),
    [['int add(int left, int right)', ['int left', 'int right']]],
  );
});

test('signatureHelp resolves imported macro calls across files', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const traceUri = 'file:///workspace/log/trace.c3';
  const appSource = [
    'module app;',
    'import log::trace;',
    'fn void use() {',
    '    trace::debug("connected", 1);',
    '}',
    '',
  ].join('\n');
  const traceSource = [
    'module log::trace;',
    'macro void debug(String message, int count) {}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);
  const app = parseSource(appUri, appSource);

  index.upsert(app, false);
  index.upsert(parseSource(traceUri, traceSource), false);
  index.rebuild();

  const help = signatureHelp(
    index,
    doc,
    app,
    doc.positionAt(appSource.indexOf('1);')),
  );

  assert.equal(help?.activeParameter, 1);
  assert.equal(
    help?.signatures[0]?.label,
    'macro void debug(String message, int count)',
  );
});
