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

test('completionItems includes visible scoped symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use(String path) {',
    '    int count;',
    '    ',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const labels = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(
      source.indexOf(
        '    ',
        source.indexOf('int count;') + 'int count;'.length,
      ) + 4,
    ),
  ).map((item) => item.label);

  assert.equal(labels.includes('path'), true);
  assert.equal(labels.includes('count'), true);
});

test('completionItems returns struct members after member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use() {',
    '    HttpResponse res;',
    '    res.body;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('res.') + 'res.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['body', CompletionItemKind.Field, 'String body;']],
  );
});

test('completionItems returns members for incomplete member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use() {',
    '    HttpResponse res;',
    '    res.',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('res.') + 'res.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['body', CompletionItemKind.Field, 'String body;']],
  );
});

test('completionItems infers foreach by-reference variables for incomplete member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Poll {',
    '    PollEvent revents;',
    '}',
    'struct EventLoop {',
    '    Poll[] polls;',
    '}',
    'fn void EventLoop.run(&self) {',
    '    foreach (&p : self.polls) {',
    '        p.',
    '    }',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.lastIndexOf('p.') + 'p.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['revents', CompletionItemKind.Field, 'PollEvent revents;']],
  );
});

test('completionItems returns members for chained expression receivers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Inner {',
    '    int value;',
    '}',
    'struct Outer {',
    '    Inner inner;',
    '}',
    'fn Outer make() {}',
    'fn void use(Outer outer) {',
    '    outer.inner.value;',
    '    make().inner.value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const localItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('outer.inner.') + 'outer.inner.'.length),
  );
  const callItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('make().inner.') + 'make().inner.'.length),
  );

  assert.deepEqual(
    localItems.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
  );
  assert.deepEqual(
    callItems.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
  );
});

test('completionItems infers var declarations from initializer expressions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn HttpResponse make_response() {}',
    'fn void use() {',
    '    var response @safeinfer = make_response();',
    '    response.',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('response.') + 'response.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['body', CompletionItemKind.Field, 'String body;']],
  );
});

test('completionItems returns members after parenthesized unary receivers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Inner {',
    '    int value;',
    '}',
    'struct Outer {',
    '    Inner inner;',
    '}',
    'fn void use(Outer* pointer) {',
    '    (*pointer).inner.value;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('(*pointer).inner.') + '(*pointer).inner.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['value', CompletionItemKind.Field, 'int value;']],
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

test('completionItems returns module alias members after a module prefix', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'alias net = module lib::net;',
    'fn void use() {}',
    '',
  ].join('\n');
  const completionSource = [
    'module app;',
    'alias net = module lib::net;',
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

test('completionItems returns child modules after a module namespace prefix', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = ['module app;', 'import std::', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource('file:///stdlib/std/net.c3', 'module std::net;\n', {
      sourceKind: 'stdlib',
    }),
    false,
  );
  index.upsert(
    parseSource('file:///stdlib/std/io.c3', 'module std::io;\n', {
      sourceKind: 'stdlib',
    }),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('std::') + 'std::'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['io', CompletionItemKind.Module, 'module std::io'],
      ['net', CompletionItemKind.Module, 'module std::net'],
    ],
  );
});

test('completionItems returns stdlib enum constants and inline typedef members', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = [
    'module poll_demo;',
    'import std::net,std::net::tcp;',
    'fn void run_reactor() {',
    '    TcpServerSocket listener;',
    '    net::SocketOption.',
    '    listener.',
    '    listener.sock.',
    '}',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/socket.c3',
      [
        'module std::net;',
        'import std::net::os;',
        'struct Socket {',
        '    NativeSocket sock;',
        '}',
        'enum SocketOption : char (CInt value)',
        '{',
        '    REUSEADDR { os::SO_REUSEADDR },',
        '    REUSEPORT { os::SO_REUSEPORT },',
        '}',
        'fn void? Socket.set_option(&self, SocketOption option, bool value) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/tcp.c3',
      [
        'module std::net::tcp;',
        'import std::net;',
        'typedef TcpServerSocket = inline Socket;',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/os/posix.c3',
      [
        'module std::net::os;',
        'typedef NativeSocket = inline Fd;',
        'macro void? NativeSocket.set_non_blocking(self, bool non_blocking) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const enumItems = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(
      appSource.indexOf('net::SocketOption.') + 'net::SocketOption.'.length,
    ),
  );
  const listenerItems = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('listener.') + 'listener.'.length),
  );
  const sockItems = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('listener.sock.') + 'listener.sock.'.length),
  );

  assert.equal(
    enumItems.find((item) => item.label === 'REUSEADDR')?.kind,
    CompletionItemKind.Constant,
  );
  assert.equal(
    enumItems.find((item) => item.label === 'REUSEPORT')?.kind,
    CompletionItemKind.Constant,
  );
  assert.equal(
    listenerItems.find((item) => item.label === 'set_option')?.kind,
    CompletionItemKind.Method,
  );
  assert.equal(
    listenerItems.find((item) => item.label === 'sock')?.kind,
    CompletionItemKind.Field,
  );
  assert.equal(
    sockItems.find((item) => item.label === 'set_non_blocking')?.kind,
    CompletionItemKind.Method,
  );
});

test('completionItems returns constdef constants for partial member access', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = [
    'module poll_demo;',
    'import std::net;',
    'fn void read() {}',
    'fn void use() {',
    '    PollSubscribe.R',
    '}',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/socket.c3',
      [
        'module std::net;',
        'import std::net::os;',
        'constdef PollSubscribe : ushort',
        '{',
        '    ANY_READ     = os::POLLIN,',
        '    PRIO_READ    = os::POLLPRI,',
        '    OOB_READ     = os::POLLRDBAND,',
        '    READ         = os::POLLRDNORM,',
        '    ANY_WRITE    = os::POLLOUT,',
        '    OOB_WRITE    = os::POLLWRBAND,',
        '    WRITE        = os::POLLWRNORM,',
        '}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('PollSubscribe.R') + 'PollSubscribe.R'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind]),
    [
      ['ANY_READ', CompletionItemKind.Constant],
      ['ANY_WRITE', CompletionItemKind.Constant],
      ['OOB_READ', CompletionItemKind.Constant],
      ['OOB_WRITE', CompletionItemKind.Constant],
      ['PRIO_READ', CompletionItemKind.Constant],
      ['READ', CompletionItemKind.Constant],
      ['WRITE', CompletionItemKind.Constant],
    ],
  );
  assert.equal(items.some((item) => item.label === 'read'), false);
});

test('completionItems includes imported symbols and excludes unrelated modules', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const otherUri = 'file:///workspace/other.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void local() {}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const otherSource = ['module other;', 'fn void unrelated() {}', ''].join(
    '\n',
  );
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.upsert(parseSource(otherUri, otherSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('local'), true);
  assert.equal(labels.includes('connect'), true);
  assert.equal(labels.includes('unrelated'), false);
});

test('completionItems includes relative imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/net.c3';
  const appSource = ['module app;', 'import net;', ''].join('\n');
  const netSource = ['module app::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('connect'), true);
});

test('completionItems excludes private imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = ['module app;', 'import lib::net;', ''].join('\n');
  const netSource = [
    'module lib::net;',
    'fn void hidden() @private {}',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const labels = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('hidden'), false);
});
