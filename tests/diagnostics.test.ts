import assert from 'node:assert/strict';
import { test } from 'node:test';

import { semanticDiagnostics } from '../src/analysis/diagnostics.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('semanticDiagnostics reports unresolved imports', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'import missing::net;', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved import 'missing::net'"],
  );
});

test('semanticDiagnostics reports unresolved imports even when syntax is incomplete', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'import std::net::poll;',
      'fn void use() {',
      '    if (p.) {}',
      '}',
      '',
    ].join('\n'),
  );
  const net = parseSource(
    'file:///stdlib/std/net/socket.c3',
    ['module std::net;', 'fn void poll() {}', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(parsed, false);
  index.upsert(net, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved import 'std::net::poll'"],
  );
});

test('semanticDiagnostics accepts relative imports', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'import net;', ''].join('\n'),
  );
  const net = parseSource(
    'file:///workspace/net.c3',
    ['module app::net;', 'fn void connect() {}', ''].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(net, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports unresolved module alias targets', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'alias net = module missing::net;', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved module alias target 'missing::net'"],
  );
});

test('semanticDiagnostics reports unresolved expression symbols', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'fn void use() {', '    missing();', '}', ''].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved symbol 'missing'"],
  );
});

test('semanticDiagnostics accepts implicitly imported std::core symbols', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    unreachable("listen failed");',
      '}',
      '',
    ].join('\n'),
  );
  const builtin = parseSource(
    'file:///stdlib/std/core/builtin.c3',
    [
      'module std::core::builtin;',
      'macro void unreachable(String string = "Unreachable statement reached.", ...) @builtin @noreturn',
      '{',
      '}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(builtin, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics resolves qualified imported macros recovered from stdlib parse errors', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stdlibUri = 'file:///stdlib/std/io.c3';
  const app = parseSource(
    appUri,
    [
      'module app;',
      'import std::io;',
      'fn void use() {',
      '    io::printn("hello");',
      '}',
      '',
    ].join('\n'),
  );
  const stdlib = parseSource(
    stdlibUri,
    [
      'module std::io;',
      '???',
      'macro void printn(x = "")',
      '{',
      '}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(stdlib, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports unresolved members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct HttpResponse {',
      '    String body;',
      '}',
      'fn void use() {',
      '    HttpResponse res;',
      '    res.missing;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Unresolved symbol 'missing'"],
  );
});

test('semanticDiagnostics accepts resolved members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct HttpResponse {',
      '    String body;',
      '}',
      'fn void use() {',
      '    HttpResponse res;',
      '    res.body;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts type-qualified enum and constdef constants', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module poll_demo;',
      'import std::net;',
      'fn void use() {',
      '    net::SocketOption.REUSEADDR;',
      '    PollSubscribe.READ;',
      '}',
      '',
    ].join('\n'),
  );
  const net = parseSource(
    'file:///stdlib/std/net/socket.c3',
    [
      'module std::net;',
      'enum SocketOption : char (CInt value)',
      '{',
      '    REUSEADDR { 1 },',
      '}',
      'constdef PollSubscribe : ushort { READ }',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(net, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics accepts var declarations inferred from initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct HttpResponse {',
      '    String body;',
      '}',
      'fn HttpResponse make_response() {}',
      'fn void use() {',
      '    var response @safeinfer = make_response();',
      '    response.body;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts for initializer declaration references', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void use() {',
      '    bool[] in_use;',
      '    for (int i = 0; i < 4; i++) {',
      '        if (!in_use[i]) {',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts self members inside type methods', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct EventLoop {',
      '    bool running;',
      '}',
      'fn void EventLoop.init(&self) {',
      '    self.running = true;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts generic receiver methods on self fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct NativeSocket {}',
      'struct Handlers {}',
      'struct Poll {}',
      'struct HashMap {}',
      'struct List {}',
      'struct EventLoop {',
      '    HashMap{NativeSocket, Handlers} handlers;',
      '    List{Poll} polls;',
      '    bool running;',
      '}',
      'fn void HashMap.init(&self) {}',
      'fn void List.init(&self) {}',
      'fn void EventLoop.init(&self) {',
      '    self.handlers.init();',
      '    self.polls.init();',
      '    self.running = true;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts recovered stdlib receiver methods on generic self fields', () => {
  const index = new ProjectIndex();
  const registry = parseSource(
    'file:///workspace/event_loop.c3',
    [
      'module poll_demo;',
      'import std::net;',
      'import std::collections::map;',
      'import std::collections::list;',
      'struct Handlers {}',
      'struct Poll {',
      '    NativeSocket socket;',
      '    PollSubscribe events;',
      '    PollEvent revents;',
      '}',
      'struct EventLoop {',
      '    HashMap{NativeSocket, Handlers} handlers;',
      '    List{Poll} polls;',
      '    bool running;',
      '}',
      '',
    ].join('\n'),
  );
  const app = parseSource(
    'file:///workspace/init_and_register.c3',
    [
      'module poll_demo;',
      'import std::net;',
      'fn void EventLoop.init(&self) {',
      '    self.handlers.init();',
      '    self.polls.init();',
      '    self.running = true;',
      '}',
      'fn void? EventLoop.register(&self, Socket* sock, Handlers h, PollSubscribe interest) {',
      '    sock.sock.set_non_blocking(true)!;',
      '    self.handlers.set(sock.sock, h);',
      '    self.polls.push(Poll{ sock.sock, interest, (PollEvent)0 });',
      '}',
      '',
    ].join('\n'),
  );
  const map = parseSource(
    'file:///stdlib/std/collections/hashmap.c3',
    [
      'module std::collections::map <Key, Value>;',
      '???',
      'fn HashMap* HashMap.init(&self, Allocator allocator) {}',
      'fn bool HashMap.set(&map, Key key, Value value) @operator([]=) {}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const list = parseSource(
    'file:///stdlib/std/collections/list.c3',
    [
      'module std::collections::list <Type>;',
      '???',
      'fn List* List.init(&self, Allocator allocator) {}',
      'fn void List.push(&self, Type element) {}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const net = parseSource(
    'file:///stdlib/std/net/socket.c3',
    [
      'module std::net;',
      'import std::net::os;',
      'struct Socket {',
      '    NativeSocket sock;',
      '}',
      'constdef PollSubscribe : ushort { READ }',
      'constdef PollEvent : ushort { READ }',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const netOs = parseSource(
    'file:///stdlib/std/net/os/posix.c3',
    [
      'module std::net::os;',
      'typedef NativeSocket = inline Fd;',
      'macro void? NativeSocket.set_non_blocking(self, bool non_blocking) {}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  for (const parsed of [registry, app, map, list, net, netOs]) {
    index.upsert(parsed, false);
  }
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports ambiguous expression symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const app = parseSource(
    appUri,
    [
      'module app;',
      'import lib::one;',
      'import lib::two;',
      'fn void use() {',
      '    connect();',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(
    parseSource(
      'file:///workspace/lib/one.c3',
      'module lib::one;\nfn void connect() {}\n',
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///workspace/lib/two.c3',
      'module lib::two;\nfn void connect() {}\n',
    ),
    false,
  );
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ["Ambiguous symbol 'connect' (2 candidates)"],
  );
});

test('semanticDiagnostics reports duplicate callable names as ambiguous', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int add(int a) { return a; }',
      'fn float add(float a) { return a; }',
      'fn void use() {',
      '    add(1);',
      '    add(1.0);',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "Ambiguous symbol 'add' (2 candidates)",
      "Ambiguous symbol 'add' (2 candidates)",
    ],
  );
});
