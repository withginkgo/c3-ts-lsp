import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hover } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { hoverFromResolveResult } from '../src/lsp/hover.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('hover shows full aggregate details for struct symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '    int status;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'HttpResponse',
      doc.positionAt(source.indexOf('HttpResponse')),
    ),
  );

  assert.match(
    hoverValue(hover),
    /struct HttpResponse \{\n    String body;\n    int status;\n\}/,
  );
});

test('hover shows owning struct for member symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use(HttpResponse response) {',
    '    response.body;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'body',
      doc.positionAt(source.lastIndexOf('body')),
    ),
  );
  const value = hoverValue(hover);

  assert.match(value, /String body;/);
  assert.match(value, /member of:/);
  assert.match(value, /struct HttpResponse \{\n    String body;\n\}/);
});

test('hover shows resolved struct type for variables', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use() {',
    '    HttpResponse response;',
    '    response;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'response',
      doc.positionAt(source.lastIndexOf('response')),
    ),
  );
  const value = hoverValue(hover);

  assert.match(value, /HttpResponse response;/);
  assert.match(value, /type:/);
  assert.match(value, /struct HttpResponse \{\n    String body;\n\}/);
});

function hoverValue(hover: Hover | null): string {
  const contents = hover?.contents;

  if (!contents || typeof contents === 'string' || Array.isArray(contents)) {
    return '';
  }

  return 'value' in contents ? contents.value : '';
}
