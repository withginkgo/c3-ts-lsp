import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hover } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { contractDefinition, contractHover } from '../src/lsp/contracts.js';
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

test('hover shows builtin any details', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use(any value) {',
    '    value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const typeHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, 'any', doc.positionAt(source.indexOf('any'))),
  );
  const valueHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'value',
      doc.positionAt(source.lastIndexOf('value')),
    ),
  );

  assert.match(
    hoverValue(typeHover),
    /struct any \{\n    void\* ptr;\n    typeid type;\n\}/,
  );
  assert.match(hoverValue(valueHover), /type:/);
  assert.match(
    hoverValue(valueHover),
    /struct any \{\n    void\* ptr;\n    typeid type;\n\}/,
  );
});

test('hover distinguishes builtin scalar types and fault values', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'faultdef MY_ERROR;',
    'fn void use(int count, fault err) {',
    '    MY_ERROR;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const intHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, 'int', doc.positionAt(source.indexOf('int'))),
  );
  const faultHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'fault',
      doc.positionAt(source.indexOf('fault err')),
    ),
  );
  const faultValueHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'MY_ERROR',
      doc.positionAt(source.lastIndexOf('MY_ERROR')),
    ),
  );

  assert.match(hoverValue(intHover), /Builtin integer type/);
  assert.match(hoverValue(faultHover), /Builtin fault type/);
  assert.match(hoverValue(faultValueHover), /fault value MY_ERROR/);
  assert.doesNotMatch(hoverValue(faultValueHover), /Builtin fault type/);
});

test('contract hover and definition resolve parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    '<*',
    ' @require value > 0',
    ' @ensure return == value',
    '*>',
    'fn int checked(int value) {',
    '    return value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const valuePosition = doc.positionAt(source.indexOf('value >'));
  const returnPosition = doc.positionAt(source.indexOf('return =='));
  const parameter = parsed.symbols[0]?.children.find(
    (symbol) => symbol.name === 'value',
  );

  index.upsert(parsed);

  assert.match(
    hoverValue(contractHover(index, doc, parsed, valuePosition)),
    /int value/,
  );
  assert.match(
    hoverValue(contractHover(index, doc, parsed, returnPosition)),
    /return: int/,
  );
  assert.deepEqual(contractDefinition(index, doc, parsed, valuePosition), {
    uri,
    range: parameter?.selectionRange,
  });
});

function hoverValue(hover: Hover | null): string {
  const contents = hover?.contents;

  if (!contents || typeof contents === 'string' || Array.isArray(contents)) {
    return '';
  }

  return 'value' in contents ? contents.value : '';
}
