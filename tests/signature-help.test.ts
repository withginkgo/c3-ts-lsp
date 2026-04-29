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

test('signatureHelp works while editing incomplete function calls', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void connect(String host, int port = 80, String[] ...tags) {}',
    'fn void use() {',
    '    connect("example", ',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const position = doc.positionAt(
    source.indexOf('connect("example", ') + 'connect("example", '.length,
  );
  const help = signatureHelp(index, doc, parsed, position);

  assert.equal(help?.activeParameter, 1);
  assert.deepEqual(
    help?.signatures[0]?.parameters?.map((parameter) => parameter.label),
    ['String host', 'int port = 80', 'String[] ...tags'],
  );
});

test('signatureHelp maps incomplete named arguments to their parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void connect(String host, int port = 80, String[] ...tags) {}',
    'fn void use() {',
    '    connect(port: ',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const position = doc.positionAt(
    source.indexOf('connect(port: ') + 'connect(port: '.length,
  );
  const help = signatureHelp(index, doc, parsed, position);

  assert.equal(help?.activeParameter, 1);
  assert.equal(
    help?.signatures[0]?.label,
    'void connect(String host, int port = 80, String[] ...tags)',
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

test('signatureHelp maps named arguments to their declared parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void connect(String host, int port = 80, String[] ...tags) {}',
    'fn void use() {',
    '    connect(port: 443, host: "example", "debug");',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const namedHelp = signatureHelp(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('"example"')),
  );
  const variadicHelp = signatureHelp(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('"debug"')),
  );

  assert.equal(namedHelp?.activeParameter, 0);
  assert.equal(variadicHelp?.activeParameter, 2);
  assert.deepEqual(
    namedHelp?.signatures[0]?.parameters?.map((parameter) => parameter.label),
    ['String host', 'int port = 80', 'String[] ...tags'],
  );
});

test('signatureHelp resolves method-style calls and skips receiver parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct EventLoop {}',
    'fn void EventLoop.init(&self, int count) {}',
    'fn void use(EventLoop loop) {',
    '    loop.init(1);',
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
    doc.positionAt(source.indexOf('1);')),
  );

  assert.equal(help?.activeParameter, 0);
  assert.deepEqual(
    help?.signatures.map((signature) => [
      signature.label,
      signature.parameters?.map((parameter) => parameter.label),
    ]),
    [['void EventLoop.init(&self, int count)', ['int count']]],
  );
});

test('signatureHelp resolves incomplete method-style calls and skips receiver parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct EventLoop {}',
    'fn void EventLoop.init(&self, int count) {}',
    'fn void use(EventLoop loop) {',
    '    loop.init(',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const position = doc.positionAt(
    source.indexOf('loop.init(') + 'loop.init('.length,
  );
  const help = signatureHelp(index, doc, parsed, position);

  assert.equal(help?.activeParameter, 0);
  assert.deepEqual(
    help?.signatures.map((signature) => [
      signature.label,
      signature.parameters?.map((parameter) => parameter.label),
    ]),
    [['void EventLoop.init(&self, int count)', ['int count']]],
  );
});
