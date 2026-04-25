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
