import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiagnosticSeverity } from 'vscode-languageserver/node.js';

import { semanticDiagnostics } from '../src/analysis/diagnostics.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

function addResultStdlib(index: ProjectIndex): void {
  index.upsert(
    parseSource(
      'file:///stdlib/std/collections/result.c3',
      [
        'module std::collections::result <OkType, ErrType>;',
        'struct Result (Printable)',
        '{',
        '    union',
        '    {',
        '        OkType value;',
        '        ErrType error;',
        '    }',
        '    bool is_ok;',
        '}',
        'fn Result ok(OkType value) { return {}; }',
        'fn Result err(ErrType err) { return {}; }',
        'interface Printable {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
}

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
    ["Unresolved function 'missing'"],
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

test('semanticDiagnostics evaluates simple compile-time assertions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'const int N = 2;',
      'fn void use() {',
      '    $assert(N == 2): "ok";',
      '    $assert(N == 3): "bad";',
      '    $if N: int x; $endif',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      'Compile-time assertion is always false: "bad"',
      "compile-time condition should be 'bool', got 'int'",
    ],
  );
});

test('semanticDiagnostics handles contracts without treating them as ordinary references', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      '<*',
      ' @ensure return == value',
      ' @require value > 0 : "value positive"',
      ' @param [in] out',
      '*>',
      'fn int checked(int value, int* out) {',
      '    return value;',
      '}',
      'fn void use() {',
      '    int out;',
      '    checked(0, &out);',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Call to 'checked' violates @require: value positive"],
  );
});

test('semanticDiagnostics validates contract references and side effects', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct User {',
      '    bool active;',
      '}',
      '<*',
      ' @require missing > 0',
      ' @require return > 0',
      ' @require value = 1',
      ' @require user.missing',
      ' @ensure value',
      '*>',
      'fn int checked(int value, User user) {',
      '    return value;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  const diagnostics = semanticDiagnostics(index, parsed);
  const messages = diagnostics.map((diagnostic) => diagnostic.message);

  assert.equal(
    messages.includes("Unresolved symbol 'missing' in contract"),
    true,
  );
  assert.equal(
    messages.includes("'return' is only valid in @ensure contracts"),
    true,
  );
  assert.equal(
    messages.includes(
      'Contracts should not contain side-effecting assignments',
    ),
    true,
  );
  assert.equal(messages.includes("Type 'User' has no member 'missing'"), true);
  assert.equal(
    messages.includes(
      "Contract '@ensure' expression should be 'bool', got 'int'",
    ),
    true,
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

test('semanticDiagnostics accepts promoted anonymous union fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Sample {',
      '    union',
      '    {',
      '        int a;',
      '        String b;',
      '    }',
      '    bool ok;',
      '}',
      'fn void use() {',
      '    Sample sample;',
      '    sample.a;',
      '    sample.b;',
      '    sample.ok;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts generic promoted anonymous union fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Parse_Error {',
      '    int line;',
      '    String message;',
      '}',
      'struct Result <OkType, ErrType> {',
      '    union',
      '    {',
      '        OkType value;',
      '        ErrType error;',
      '    }',
      '    bool is_ok;',
      '}',
      'fn void use() {',
      '    Result{int, Parse_Error} x;',
      '    x.error;',
      '    x.value;',
      '    x.is_ok;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics resolves stdlib-style result promoted field access', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Student {',
      '    String age;',
      '    String name;',
      '}',
      'fn void use() {',
      '    Result{int, Student} x = result::err({.age = "18", .name = "xiaoming"});',
      '    x.error;',
      '    x.value;',
      '    x.is_ok;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  addResultStdlib(index);
  index.rebuild();

  const diagnostics = semanticDiagnostics(index, app);
  const messages = diagnostics.map((diagnostic) => diagnostic.message);

  assert.equal(
    messages.some((message) => message.includes("Unresolved symbol 'value'")),
    false,
  );
  assert.equal(
    messages.some((message) => message.includes("Unresolved symbol 'error'")),
    false,
  );
  assert.equal(
    messages.some((message) => message.includes("Unresolved symbol 'is_ok'")),
    false,
  );
  assert.deepEqual(messages, [
    'Possible invalid Result branch access: `x` was initialized with `result::err`, but `.value` is being read.',
  ]);
  assert.equal(diagnostics[0]?.severity, DiagnosticSeverity.Warning);
});

test('semanticDiagnostics warns on obvious invalid result branch reads', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Student {',
      '    String age;',
      '    String name;',
      '}',
      'fn void use() {',
      '    Result{int, Student} from_err = result::err({.age = "18", .name = "xiaoming"});',
      '    from_err.value;',
      '    Result{int, Student} from_ok = result::ok(123);',
      '    from_ok.error;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  addResultStdlib(index);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => [
      diagnostic.severity,
      diagnostic.message,
    ]),
    [
      [
        DiagnosticSeverity.Warning,
        'Possible invalid Result branch access: `from_err` was initialized with `result::err`, but `.value` is being read.',
      ],
      [
        DiagnosticSeverity.Warning,
        'Possible invalid Result branch access: `from_ok` was initialized with `result::ok`, but `.error` is being read.',
      ],
    ],
  );
});

test('semanticDiagnostics does not warn on unknown or invalidated result branch state', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Student {',
      '    String age;',
      '    String name;',
      '}',
      'fn void use() {',
      '    Result{int, Student} unknown;',
      '    unknown.value;',
      '    Result{int, Student} reassigned = result::err({.age = "18", .name = "xiaoming"});',
      '    reassigned = result::ok(123);',
      '    reassigned.value;',
      '    Result{int, Student} escaped = result::err({.age = "18", .name = "xiaoming"});',
      '    &escaped;',
      '    escaped.value;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  addResultStdlib(index);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics warns on suspicious struct field initializer types', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Student {',
      '    String age;',
      '    String name;',
      '}',
      'fn void use() {',
      '    Result{int, Student} x = result::err({.age = 1, .name = "xiaoming"});',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  addResultStdlib(index);
  index.rebuild();

  const diagnostics = semanticDiagnostics(index, app);
  assert.equal(
    diagnostics.some(
      (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
    ),
    false,
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.message]),
    [
      [
        DiagnosticSeverity.Warning,
        'Suspicious initializer: field `age` has type `String`, but initializer has type `int`.',
      ],
    ],
  );
});

test('semanticDiagnostics accepts string struct field initializers', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Student {',
      '    String age;',
      '    String name;',
      '}',
      'fn void use() {',
      '    Result{int, Student} x = result::err({.age = "18", .name = "xiaoming"});',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  addResultStdlib(index);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics accepts builtin any ptr and type fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn void batch_job(any[] args) {',
      '    int task_id = *(int*)args[0].ptr;',
      '    typeid task_type = args[0].type;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics resolves string functions from implicit std::core child modules', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    string::format("task");',
      '}',
      '',
    ].join('\n'),
  );
  const string = parseSource(
    'file:///stdlib/std/core/string.c3',
    ['module std::core::string;', 'fn String format(args...) {}', ''].join(
      '\n',
    ),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(string, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics resolves alias receiver methods without target ambiguity', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::thread;',
      'fn void run() {',
      '    Thread producer_thread;',
      '    producer_thread.create();',
      '}',
      '',
    ].join('\n'),
  );
  const thread = parseSource(
    'file:///stdlib/std/threads/thread.c3',
    [
      'module std::thread;',
      'import std::thread::os;',
      'typedef Thread = inline NativeThread;',
      'macro void Thread.create(&thread) {}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const os = parseSource(
    'file:///stdlib/std/threads/os/thread_posix.c3',
    [
      'module std::thread::os;',
      'struct NativeThread {}',
      'fn void NativeThread.create(&thread) {}',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(thread, false);
  index.upsert(os, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
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

test('semanticDiagnostics validates macro trailing body arguments', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'macro void @with(int x; @body(int y)) {',
      '    @body(x);',
      '}',
      'fn void use() {',
      '    @with(1; int y) {',
      '        y;',
      '    };',
      '    @with(1) {',
      '    };',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ['Not enough parameters for the macro body, expected 1'],
  );
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

test('semanticDiagnostics accepts infinite loops in non-void functions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int run() {',
      '    while (true) {',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics still reports loops that can break and fall through', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int run(bool done) {',
      '    while (true) {',
      '        if (done) {',
      '            break;',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Function 'run' must return a value of type 'int' on all paths"],
  );
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
      'fn void? run() {',
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

test('semanticDiagnostics resolves catch unwrap variables in their body scope', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'const int CHANNEL_CLOSED = 1;',
      'fn int? pop();',
      'fn void run() {',
      '    int? result = pop();',
      '    if (catch err = result) {',
      '        if (err == CHANNEL_CLOSED) {}',
      '    }',
      '    err;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Undefined variable 'err'"],
  );
});

test('semanticDiagnostics narrows optional values after terminating catch unwrap', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Order {}',
      'fn Order? next_order();',
      'fn int barista_task() {',
      '    while (true) {',
      '        Order? maybe_order = next_order();',
      '        if (catch err = maybe_order) {',
      '            return 0;',
      '        }',
      '        Order order = maybe_order;',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics keeps optional values optional after non-terminating catch unwrap', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int? next_value();',
      'fn void run() {',
      '    int? maybe = next_value();',
      '    if (catch err = maybe) {',
      '    }',
      '    int value = maybe;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Cannot initialize 'value' of type 'int' with 'int?'"],
  );
});

test('semanticDiagnostics validates rethrow propagation context', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'fn int? may_fail();',
      'fn void cleanup() {}',
      'fn int main(String[] args) {',
      '    int value = may_fail()!;',
      '    int? optional = may_fail()!;',
      '    int plain = 1;',
      '    plain!;',
      '    plain!!;',
      '    defer may_fail()!;',
      '    may_fail()!!;',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      "This expression is doing a rethrow, but 'main' returns 'int', which isn't an optional type. Did you intend to use '!!' instead?",
      "This expression is doing a rethrow, but 'main' returns 'int', which isn't an optional type. Since you are assigning to an optional, maybe you added '!' by mistake?",
      "No optional to rethrow before '!' in the expression, please remove '!'.",
      "No optional to rethrow before '!!' in the expression, please remove '!!'.",
      'Rethrows are not allowed inside of defers.',
    ],
  );
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
      'fn void? run() {',
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

test('semanticDiagnostics reports conflicts with promoted anonymous union fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Bad {',
      '    union',
      '    {',
      '        int x;',
      '    }',
      '    String x;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ["Duplicate member 'x' in 'Bad'", "Duplicate member 'x' in 'Bad'"],
  );
});

test('semanticDiagnostics reports generic type references without parameters', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Result <Type> {',
      '    Type value;',
      '}',
      'struct Foo <Type> {}',
      'struct List <Type> {}',
      'fn void use() {',
      '    Result res;',
      '    Result{int} ok;',
      '    Foo* ptr;',
      '    List list;',
      '    int x;',
      '    fault err;',
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
      diagnostic.range.end.character,
    ]),
    [
      [
        "'Result' is a generic struct, did you forget the parameters '{ ... }'?",
        7,
        4,
        10,
      ],
      [
        "'Foo' is a generic struct, did you forget the parameters '{ ... }'?",
        9,
        4,
        7,
      ],
      [
        "'List' is a generic struct, did you forget the parameters '{ ... }'?",
        10,
        4,
        8,
      ],
    ],
  );
});

test('semanticDiagnostics accepts generic type references and generic calls with brace arguments', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module app;',
      'struct Parse_Error {}',
      'struct List <Type> {}',
      'struct Result <Type, Error> {}',
      'struct Foo <Left, Right> {}',
      'fn Result{Type, Error} ok(Type value) <Type, Error> { return {}; }',
      'fn void use() {',
      '    List{int} a;',
      '    Result{int, Parse_Error} test = ok{int, Parse_Error}(1);',
      '    Foo{int, double} g;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics resolves module-qualified generic function calls in call context', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import result;',
      'struct Foo <Left, Right> {}',
      'fn void use() {',
      '    Result{int, Parse_Error} test = result::ok{int, Parse_Error}(1);',
      '    Result{int, Parse_Error} test2 = ok{int, Parse_Error}(1);',
      '    List{int} a;',
      '    Foo{int, double} g;',
      '    foo_test::test{int, double}(1.0, &g);',
      '}',
      '',
    ].join('\n'),
  );
  const resultOne = parseSource(
    'file:///workspace/result/one.c3',
    [
      'module result;',
      'struct Parse_Error {}',
      'struct List <Type> {}',
      'struct Result <Type, Error> {}',
      'fn Result{Type, Error} ok(Type value) <Type, Error> { return {}; }',
      '',
    ].join('\n'),
  );
  const resultTwo = parseSource(
    'file:///workspace/result/two.c3',
    [
      'module result;',
      'fn Result{Type, Error} ok(Type value, Error err) <Type, Error> { return {}; }',
      '',
    ].join('\n'),
  );
  const fooTest = parseSource(
    'file:///workspace/foo_test.c3',
    [
      'module foo_test;',
      'fn void test(double value, Foo{int, double}* g) <Type, Error> {}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(resultOne, false);
  index.upsert(resultTwo, false);
  index.upsert(fooTest, false);
  index.rebuild();

  assert.deepEqual(app.diagnostics, []);
  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports generic function reference and call shape errors', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import result;',
      'fn void use() {',
      '    result::ok;',
      '    result::ok{int, Parse_Error};',
      '    result::ok{int, Parse_Error}(1, 2);',
      '    result::ok{int}(1);',
      '}',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///workspace/result.c3',
    [
      'module result;',
      'struct Parse_Error {}',
      'struct Result <Type, Error> {}',
      'fn Result{Type, Error} ok(Type value) <Type, Error> { return {}; }',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => [
      diagnostic.message,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    ]),
    [
      ["Function 'result::ok' used as value", 3, 4, 3, 14],
      [
        "Generic function reference 'result::ok{int, Parse_Error}' requires call",
        4,
        14,
        4,
        32,
      ],
      ["'ok' expects 1 argument, got 2", 5, 32, 5, 38],
      [
        "Generic function 'result::ok' expects 2 generic arguments, got 1",
        6,
        14,
        6,
        19,
      ],
    ],
  );
});

test('semanticDiagnostics reports generic types inherited from generic modules', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::list;',
      'fn void use() {',
      '    List list;',
      '}',
      '',
    ].join('\n'),
  );
  const list = parseSource(
    'file:///stdlib/std/collections/list.c3',
    ['module std::collections::list <Type>;', 'struct List {}', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(list, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ["'List' is a generic struct, did you forget the parameters '{ ... }'?"],
  );
  assert.deepEqual(semanticDiagnostics(index, list), []);
});

test('semanticDiagnostics accepts generic module instantiation on result types and calls', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Parse_Error {}',
      'fn void use() {',
      '    Result res;',
      '    Result{int, Parse_Error} test = result::ok{int, Parse_Error}(1);',
      '    Result{int, Parse_Error} inferred = result::ok(1);',
      '    result::Result{int, Parse_Error} qualified;',
      '}',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///stdlib/std/collections/result.c3',
    [
      'module std::collections::result <OkType, ErrType>;',
      'struct Result {}',
      'fn Result ok(OkType val) { return {}; }',
      'fn OkType? Result.ok(&self);',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  assert.deepEqual(index.getModule('std::collections::result')?.genericParams, [
    'OkType',
    'ErrType',
  ]);
  assert.deepEqual(
    result.symbols.find((symbol) => symbol.name === 'Result')
      ?.effectiveGenericParams,
    ['OkType', 'ErrType'],
  );
  assert.deepEqual(
    result.symbols.find((symbol) => symbol.name === 'ok')
      ?.effectiveGenericParams,
    ['OkType', 'ErrType'],
  );
  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ["'Result' is a generic struct, did you forget the parameters '{ ... }'?"],
  );
  assert.deepEqual(semanticDiagnostics(index, result), []);
});

test('semanticDiagnostics uses expected result types to validate generic module call arguments', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'import std::collections::result;',
      'struct Parse_Error {',
      '    int line;',
      '    String message;',
      '}',
      'fn Result{int, Parse_Error} ok_return(String s) {',
      '    return result::err({.line = 1, .message = "bad"});',
      '}',
      'fn Result{int, Parse_Error} ok_initializer(String s) {',
      '    Result{int, Parse_Error} x = result::err({.line = 1, .message = "bad"});',
      '    return x;',
      '}',
      'fn Result{int, Parse_Error} ok_value(String s) {',
      '    int v = 123;',
      '    return result::ok(v);',
      '}',
      'fn Result{int, Parse_Error} bad_initializer(String s) {',
      '    Result{int, Parse_Error} x = result::err(1);',
      '    return x;',
      '}',
      'fn Result{int, Parse_Error} bad_return(String s) {',
      '    return result::err(1);',
      '}',
      'fn Result{int, Parse_Error} bad_ok(String s) {',
      '    return result::ok({.line = 1, .message = "bad"});',
      '}',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///stdlib/std/collections/result.c3',
    [
      'module std::collections::result <OkType, ErrType>;',
      'struct Result {}',
      'fn Result ok(OkType val) { return {}; }',
      'fn Result err(ErrType err) { return {}; }',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    [
      "Cannot pass 'int' to parameter 'err' of 'err' with type 'Parse_Error'",
      "Cannot pass 'int' to parameter 'err' of 'err' with type 'Parse_Error'",
      "Cannot pass 'Parse_Error' to parameter 'val' of 'ok' with type 'int'",
    ],
  );
});

test('semanticDiagnostics reports function calls in global initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module test;', 'fn int foo() { return 1; }', 'int a = foo();', ''].join(
      '\n',
    ),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ['The expression must be a constant value.'],
  );
});

test('semanticDiagnostics reports generic module calls in global initializers as non-constant', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/mem_exercise/src/main.c3',
    [
      'module mem_exercise;',
      'import std::collections::result;',
      'struct Parse_Error {',
      '    int line;',
      '    String message;',
      '}',
      'Result{int, Parse_Error} test = result::ok(1);',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///stdlib/std/collections/result.c3',
    [
      'module std::collections::result <OkType, ErrType>;',
      'struct Result {}',
      'fn Result ok(OkType val) { return {}; }',
      'fn OkType? Result.ok(&self);',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  assert.deepEqual(
    semanticDiagnostics(index, app).map((diagnostic) => diagnostic.message),
    ['The expression must be a constant value.'],
  );
});

test('semanticDiagnostics accepts runtime local initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'fn int foo() { return 1; }',
      'fn int main(String[] args) {',
      '    int a = foo();',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts constant global initializers and zero initialization', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'const int C = 4;',
      'int a = 1 + 2 * 3;',
      'int b;',
      'int c = C;',
      'int d = (int)(1 + 2);',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts typed aggregate global initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'struct Foo { int x; bool y; }',
      'Foo f = (Foo){ .x = 1, .y = true };',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts untyped and nested aggregate global initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'struct Inner { int x; }',
      'struct Foo { Inner a; int b; }',
      'Foo f = { .a = { .x = 1 }, .b = 2 };',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(semanticDiagnostics(index, parsed), []);
});

test('semanticDiagnostics accepts generic module typed aggregate global initializers', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/mem_exercise/src/main.c3',
    [
      'module mem_exercise;',
      'import std::collections::result;',
      'struct Parse_Error {',
      '    int line;',
      '    String message;',
      '}',
      'Result{int, Parse_Error} test =',
      '    (Result{int, Parse_Error}){ .is_ok = true, .value = 1 };',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///stdlib/std/collections/result.c3',
    [
      'module std::collections::result <OkType, ErrType>;',
      'struct Result {',
      '    bool is_ok;',
      '    OkType value;',
      '}',
      'fn Result ok(OkType val) { return {}; }',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  assert.deepEqual(semanticDiagnostics(index, app), []);
});

test('semanticDiagnostics reports non-constant aggregate global initializer fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'struct Foo { int x; }',
      'fn int foo() { return 1; }',
      'Foo f = (Foo){ .x = foo() };',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    ['The expression must be a constant value.'],
  );
});

test('semanticDiagnostics reports non-constant static and tlocal initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'fn int foo() { return 1; }',
      'struct Foo { int x; }',
      'fn int main(String[] args) {',
      '    static int a = foo();',
      '    tlocal int b = foo();',
      '    static Foo f = (Foo){ .x = 1 };',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      'The expression must be a constant value.',
      'The expression must be a constant value.',
    ],
  );
});

test('semanticDiagnostics reports extern and multiple declaration initializers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    [
      'module test;',
      'extern int a = 1;',
      'int b, c = 2;',
      'fn int main(String[] args) {',
      '    int x, y = 1;',
      '    return 0;',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(parsed);

  assert.deepEqual(
    semanticDiagnostics(index, parsed).map((diagnostic) => diagnostic.message),
    [
      'Extern globals may not have initializers.',
      'Initialization is not allowed with multiple declarations.',
      'Initialization is not allowed with multiple declarations.',
    ],
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

test('semanticDiagnostics accepts generic types from child modules of imported stdlib modules', () => {
  const index = new ProjectIndex();
  const app = parseSource(
    'file:///workspace/comprehensive.c3',
    [
      'module conditional_variable;',
      'import std::thread;',
      'struct ConsumerContext',
      '{',
      '    int id;',
      '    BufferedChannel{int}* ch;',
      '}',
      '',
    ].join('\n'),
  );
  const thread = parseSource(
    'file:///stdlib/std/threads/thread.c3',
    ['module std::thread;', ''].join('\n'),
    { sourceKind: 'stdlib' },
  );
  const channel = parseSource(
    'file:///stdlib/std/threads/buffered_channel.c3',
    [
      'module std::thread::channel <Type>;',
      'typedef BufferedChannel = void;',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  for (const parsed of [app, thread, channel]) {
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
    ["Ambiguous function call 'connect' (2 candidates)"],
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
      "Ambiguous function call 'add' (2 candidates)",
      "Ambiguous function call 'add' (2 candidates)",
    ],
  );
});
