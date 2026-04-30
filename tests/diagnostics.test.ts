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

test('semanticDiagnostics reports undefined array size variables', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'const int BUF_SIZE = 1024;',
      'struct Conn {',
      '    char[BUFFER_SIZE] out_buf;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Undefined variable 'BUFFER_SIZE'"],
  );
});

test('semanticDiagnostics resolves local consts in compile-time asserts', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int main(String[] args) {',
      '    const Y=1;',
      '    $assert(Y==1):"int should be 4 bytes";',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
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
    ['module std::io;', '???', 'macro void printn(x = "")', '{', '}', ''].join(
      '\n',
    ),
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
      'fn HttpResponse make_response() { return {}; }',
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

test('semanticDiagnostics reports methods without receiver parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Baz {}',
      'fn String Baz.myname() @dynamic {',
      '    return "i am baz!";',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => [
      diagnostic.message,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [
      [
        "A method must start with an argument of the type it is a method of, e.g. 'fn String Baz.myname(Baz* self)'",
        2,
        14,
      ],
    ],
  );
});

test('semanticDiagnostics validates explicit method receiver parameter types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Baz {}',
      'fn String Baz.valid(Baz* self) { return ""; }',
      'fn String Baz.invalid(String self) { return ""; }',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "A method must start with an argument of the type it is a method of, e.g. 'fn String Baz.invalid(Baz* self)'",
    ],
  );
});

test('semanticDiagnostics reports missing return values even with incomplete syntax', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Baz {}',
      'fn String Baz.myname(&self) @dynamic {',
      '    return',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => [
      diagnostic.message,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [
      [
        "Return statement in 'myname' must return a value of type 'String'",
        3,
        4,
      ],
    ],
  );
});

test('semanticDiagnostics validates return values against callable return types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void log() {',
      '    return 1;',
      '}',
      'fn String name() {',
      '    return 1;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "Void function 'log' should not return a value",
      "Cannot return 'int' from 'name' with return type 'String'",
    ],
  );
});

test('semanticDiagnostics reports non-void functions that can fall through', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int pick(bool ok) {',
      '    if (ok) {',
      '        return 1;',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Function 'pick' must return a value of type 'int' on all paths"],
  );
});

test('semanticDiagnostics accepts complete return paths and void-like returns', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int pick(bool ok) {',
      '    if (ok) {',
      '        return 1;',
      '    } else {',
      '        return 2;',
      '    }',
      '}',
      'fn void visit() {',
      '    return;',
      '}',
      'fn void? try_visit() {',
      '    return;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics reports discarded optional call results', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct TcpServerSocket {}',
      'enum SocketOption : int {',
      '    REUSEADDR,',
      '}',
      'fn void? TcpServerSocket.set_option(&self, SocketOption option, bool enabled);',
      'fn void run(TcpServerSocket listener) {',
      '    listener.set_option(SocketOption.REUSEADDR, true);',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Optional result of 'set_option' must be handled"],
  );
});

test('semanticDiagnostics reports discarded optional calls before later syntax errors', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/poll_demo/src/main.c3',
    [
      'module poll_demo;',
      'import std::net,std::net::tcp;',
      'import std::io,std::os,std::time;',
      'const MAX_CLIENTS=64;',
      'interface MyName{',
      '    fn String myname();',
      '}',
      'struct Baz(MyName){',
      '    int x;',
      '}',
      'fn String Baz.myname(&self) @dynamic {',
      '    return "i am baz";',
      '}',
      'fn void run_reactor(){',
      '    TcpServerSocket listener=tcp::listen("0.0.0.0",7777,10,',
      '        net::SocketOption.REUSEADDR,net::SocketOption.REUSEPORT)',
      '        ?? unreachable("listen failed");',
      '    listener.set_option(net::SocketOption.REUSEADDR, true);',
      '    (void)listener.sock.set_non_blocking(true);',
      '    Poll[MAX_CLIENTS] poll_fds;',
      '}',
      'fn int main(String[] args)',
      '{',
      '    Baz baz;',
      '    baz.x=1;',
      '    const Y=1;',
      '    io::printn(baz.myname());',
      '    $assert(Y==1):"int should br 4 bytes";',
      '    $assert',
      '    defer catch',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );
  const net = parseSource(
    'file:///stdlib/std/net.c3',
    [
      'module std::net;',
      'enum SocketOption : int { REUSEADDR, REUSEPORT }',
      'struct Socket {}',
      'struct Poll {}',
      'fn void? Socket.set_non_blocking(&self, bool value);',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const tcp = parseSource(
    'file:///stdlib/std/net/tcp.c3',
    [
      'module std::net::tcp;',
      'import std::net;',
      'struct TcpServerSocket { Socket sock; }',
      'fn TcpServerSocket? listen(String host, int port, int backlog, SocketOption options...);',
      'fn void? TcpServerSocket.set_option(&self, SocketOption option, bool enabled);',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const io = parseSource(
    'file:///stdlib/std/io.c3',
    ['module std::io;', 'fn void printn(String value);', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const os = parseSource('file:///stdlib/std/os.c3', 'module std::os;\n', {
    sourceKind: 'stdlib',
  });
  const time = parseSource(
    'file:///stdlib/std/time.c3',
    'module std::time;\n',
    { sourceKind: 'stdlib' },
  );
  const core = parseSource(
    'file:///stdlib/std/core/builtin.c3',
    [
      'module std::core;',
      'macro void unreachable(String message = "failed", ...) @noreturn {',
      '}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  for (const parsed of [app, net, tcp, io, os, time, core]) {
    index.upsert(parsed, false);
  }

  index.rebuild();

  assert.equal(app.diagnostics.length, 1);
  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ["Optional result of 'set_option' must be handled"],
  );
});

test('semanticDiagnostics accepts handled optional call results and may-discard calls', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void? may_fail();',
      'fn void? may_ignore() @maydiscard;',
      'macro void unreachable(String message = "failed", ...) @noreturn {',
      '}',
      'fn void run() {',
      '    may_fail()!;',
      '    may_fail()!!;',
      '    may_fail() ?? unreachable("failed");',
      '    if (catch err = may_fail()) {',
      '    }',
      '    may_ignore();',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics validates optional type flow', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int? maybe_int();',
      'fn void consume(int value) {}',
      'fn int unwrap_bad() {',
      '    return maybe_int();',
      '}',
      'fn void run() {',
      '    int plain = maybe_int();',
      '    int forced = maybe_int()!;',
      '    int fallback = maybe_int() ?? 0;',
      '    int? optional = 1;',
      '    void? stored = consume(1);',
      '    consume(maybe_int());',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "Cannot declare 'stored' with type 'void?'",
      "Cannot return 'int?' from 'unwrap_bad' with return type 'int'",
      "Cannot initialize 'plain' of type 'int' with 'int?'",
      "Optional result of 'consume' must be handled",
    ],
  );
});

test('semanticDiagnostics reports discarded nodiscard call results', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int must_use() @nodiscard;',
      'fn void run() {',
      '    must_use();',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Result of 'must_use' is annotated @nodiscard and must be used"],
  );
});

test('semanticDiagnostics accepts implemented interface method calls with arguments', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'interface Renamable {',
      '    fn void rename(String name);',
      '}',
      'struct Baz(Renamable) {',
      '}',
      'fn void Baz.rename(&self, String new_name) @dynamic {',
      '}',
      'fn void use(Baz baz) {',
      '    baz.rename("ok");',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts optional interface methods without implementations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'interface Renamable {',
      '    fn void rename(String name) @optional;',
      '}',
      'struct Baz(Renamable) {',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics reports unresolved types and duplicate declarations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Box {',
      '    int value;',
      '    int value;',
      '}',
      'struct Box {}',
      'fn void use(Missing value) {',
      '    int local;',
      '    int local;',
      '}',
      'fn void take(int value, String value) {}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed)
      .map((diagnostic) => diagnostic.message)
      .sort(),
    [
      "Duplicate declaration 'Box'",
      "Duplicate declaration 'Box'",
      "Duplicate local declaration 'local'",
      "Duplicate local declaration 'local'",
      "Duplicate member 'value' in 'Box'",
      "Duplicate member 'value' in 'Box'",
      "Duplicate parameter 'value' in 'take'",
      "Duplicate parameter 'value' in 'take'",
      "Unresolved type 'Missing'",
    ].sort(),
  );
});

test('semanticDiagnostics validates call arguments, initializers, assignments, and conditions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void connect(String host, int port) {}',
      'fn void use(int count) {',
      '    String name = 1;',
      '    int number = "bad";',
      '    if (count) {',
      '    }',
      '    name = 2;',
      '    count = "bad";',
      '    connect(1, "bad");',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "Cannot pass 'int' to parameter 'host' of 'connect' with type 'String'",
      "Cannot pass 'String' to parameter 'port' of 'connect' with type 'int'",
      "Cannot initialize 'name' of type 'String' with 'int'",
      "Cannot initialize 'number' of type 'int' with 'String'",
      "Condition expression should be 'bool', got 'int'",
      "Cannot assign 'int' to 'name' of type 'String'",
      "Cannot assign 'String' to 'count' of type 'int'",
    ],
  );
});

test('semanticDiagnostics reports missing interface method implementations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'interface Renamable {',
      '    fn void rename(String name);',
      '}',
      'struct Baz(Renamable) {',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Type 'Baz' does not implement interface method 'Renamable.rename'"],
  );
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
      'fn HashMap* HashMap.init(&self, Allocator allocator = ...) {}',
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
      'fn List* List.init(&self, Allocator allocator = ...) {}',
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

test('semanticDiagnostics ignores inactive stdlib platform type candidates', () => {
  const index = new ProjectIndex({ activeEnvironment: ['LINUX'] });
  const app = parseSource(
    'file:///workspace/event_loop.c3',
    [
      'module poll_demo;',
      'import std::net;',
      'import std::collections::map;',
      'struct Handlers {}',
      'struct EventLoop {',
      '    HashMap{NativeSocket, Handlers} handlers;',
      '}',
      '',
    ].join('\n'),
  );
  const map = parseSource(
    'file:///stdlib/std/collections/hashmap.c3',
    ['module std::collections::map;', 'struct HashMap {}', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const net = parseSource(
    'file:///stdlib/std/net/socket.c3',
    ['module std::net;', 'import std::net::os;', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const posix = parseSource(
    'file:///stdlib/std/net/os/posix.c3',
    [
      'module std::net::os @if(env::POSIX && SUPPORTS_INET);',
      'typedef NativeSocket = inline Fd;',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const win32 = parseSource(
    'file:///stdlib/std/net/os/win32.c3',
    [
      'module std::net::os @if(env::WIN32);',
      'typedef NativeSocket = inline Win32_SOCKET;',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  for (const parsed of [app, map, net, posix, win32]) {
    index.upsert(parsed, false);
  }
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics accepts default, named, and variadic call arguments', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void connect(String host, int port = 80, String[] ...tags) {}',
      'fn void use() {',
      '    connect("example");',
      '    connect(port: 443, host: "example", "debug");',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics reports call argument shape errors', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int add(int left, int right) { return left; }',
      'fn void connect(String host, int port = 80) {}',
      'fn void use() {',
      '    add(1);',
      '    add(1, 2, 3);',
      '    connect(port: 443);',
      '    connect(host: "example", missing: 1);',
      '    connect("example", host: "duplicate");',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "Missing required argument 'right' for 'add'",
      "'add' expects 2 arguments, got 3",
      "Missing required argument 'host' for 'connect'",
      "Unknown named argument 'missing' for 'connect'",
      "Argument 'host' is already supplied for 'connect'",
    ],
  );
});

test('semanticDiagnostics validates nested call expressions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int id(int value) { return value; }',
      'fn int add(int left, int right) { return left; }',
      'fn void use() {',
      '    id(add(1));',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Missing required argument 'right' for 'add'"],
  );
});

test('semanticDiagnostics reports duplicate function declarations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int add(int a) { return a; }',
      'fn int add(int a, int b = 0) { return a; }',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Duplicate function 'add'", "Duplicate function 'add'"],
  );
});

test('semanticDiagnostics reports duplicate method declarations across module files', () => {
  const index = new ProjectIndex();
  const first = parseSource(
    'file:///workspace/one.c3',
    [
      'module app;',
      'struct Box {}',
      'fn void Box.take(&self, int value) {}',
      '',
    ].join('\n'),
  );
  const second = parseSource(
    'file:///workspace/two.c3',
    ['module app;', 'fn void Box.take(&self, float value) {}', ''].join('\n'),
  );

  index.upsert(first, false);
  index.upsert(second, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, first).map((diagnostic) => diagnostic.message),
    ["Duplicate method 'Box.take'"],
  );
  assert.deepEqual(
    semanticDiagnostics(index, second).map((diagnostic) => diagnostic.message),
    ["Duplicate method 'Box.take'"],
  );
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
      "Duplicate function 'add'",
      "Duplicate function 'add'",
      "Ambiguous symbol 'add' (2 candidates)",
      "Ambiguous symbol 'add' (2 candidates)",
    ],
  );
});
