import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SymbolKind } from 'vscode-languageserver/node.js';

import { parseSource } from '../src/parser/c3-parser.js';

test('parseSource extracts the module name and top-level function symbols', () => {
  const file = 'testdata/simple/main.c3';
  const uri = pathToFileURL(file).toString();
  const parsed = parseSource(uri, readFileSync(file, 'utf8'));

  assert.equal(parsed.uri, uri);
  assert.equal(parsed.moduleName, 'http_demo');
  assert.deepEqual(
    parsed.symbols.map((symbol) => symbol.name),
    ['main'],
  );
  assert.equal(parsed.symbols[0]?.kind, SymbolKind.Function);
  assert.equal(parsed.symbols[0]?.signature, 'int main(String[] args)');
});

test('parseSource extracts multiple top-level declaration kinds', () => {
  const file = 'testdata/simple/http.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.equal(parsed.moduleName, 'http_demo');
  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
    ]),
    [
      ['HttpResponse', SymbolKind.Struct, 'struct HttpResponse'],
      [
        'read_response',
        SymbolKind.Function,
        'void read_response(HttpResponse* res)',
      ],
    ],
  );
});

test('parseSource extracts scoped parameters and local declarations', () => {
  const file = 'testdata/simple/main.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.deepEqual(
    parsed.scopedSymbols.map((symbol) => [
      symbol.name,
      symbol.signature,
      symbol.returnType,
    ]),
    [
      ['args', 'String[] args', 'String[]'],
      ['res', 'HttpResponse res;', 'HttpResponse'],
    ],
  );
});

test('parseSource extracts import paths', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'import lib::net;', 'fn void use() {}', ''].join('\n'),
  );

  assert.equal(parsed.moduleName, 'app');
  assert.deepEqual(parsed.imports, ['lib::net']);
  assert.equal(parsed.importSpecs[0]?.path, 'lib::net');
  assert.deepEqual(
    parsed.symbols.map((symbol) => symbol.name),
    ['use'],
  );
});

test('parseSource extracts module aliases', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'alias net = module lib::net;',
      'fn void use() {}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(parsed.moduleAliases, [
    {
      name: 'net',
      target: 'lib::net',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 28 },
      },
      selectionRange: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 9 },
      },
      targetRange: {
        start: { line: 1, character: 19 },
        end: { line: 1, character: 27 },
      },
    },
  ]);
});

test('parseSource extracts type alias targets', () => {
  const parsed = parseSource(
    'file:///workspace/types.c3',
    [
      'module app;',
      'typedef TcpServerSocket = inline Socket;',
      'alias UserName = String;',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.signature,
      symbol.returnType,
    ]),
    [
      ['TcpServerSocket', 'typedef TcpServerSocket = inline Socket;', 'Socket'],
      ['UserName', 'alias UserName = String;', 'String'],
    ],
  );
});

test('parseSource extracts Phase 1 top-level declaration coverage', () => {
  const file = 'testdata/phase1/syntax.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );

  assert.equal(parsed.moduleName, 'phase1');
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
    ]),
    [
      ['User', SymbolKind.Struct, 'struct User @packed'],
      ['Value', SymbolKind.Struct, 'union Value'],
      ['Flags', SymbolKind.Struct, 'bitstruct Flags : uint'],
      ['Color', SymbolKind.Enum, 'enum Color : int'],
      ['ErrorCode', SymbolKind.Constant, 'constdef ErrorCode : int'],
      ['Reader', SymbolKind.Interface, 'interface Reader'],
      ['NOT_FOUND', SymbolKind.Constant, 'faultdef NOT_FOUND, DENIED;'],
      ['DENIED', SymbolKind.Constant, 'faultdef NOT_FOUND, DENIED;'],
      ['Name', SymbolKind.TypeParameter, 'typedef Name = String;'],
      ['UserName', SymbolKind.TypeParameter, 'alias UserName = String;'],
      ['@Route', SymbolKind.Property, 'attrdef @Route(String path);'],
      ['global_count', SymbolKind.Variable, 'int global_count;'],
      ['imported', SymbolKind.Function, 'void imported()'],
      ['trace', SymbolKind.Function, 'macro void trace(String msg)'],
      ['add', SymbolKind.Function, 'int add(int a, int b)'],
    ],
  );
});

test('parseSource extracts nested members, parameters, docs, attrs, and body ranges', () => {
  const file = 'testdata/phase1/syntax.c3';
  const parsed = parseSource(
    pathToFileURL(file).toString(),
    readFileSync(file, 'utf8'),
  );
  const user = parsed.symbols.find((symbol) => symbol.name === 'User');
  const name = user?.children.find((symbol) => symbol.name === 'name');
  const color = parsed.symbols.find((symbol) => symbol.name === 'Color');
  const errorCode = parsed.symbols.find(
    (symbol) => symbol.name === 'ErrorCode',
  );
  const reader = parsed.symbols.find((symbol) => symbol.name === 'Reader');
  const trace = parsed.symbols.find((symbol) => symbol.name === 'trace');
  const add = parsed.symbols.find((symbol) => symbol.name === 'add');

  assert.equal(user?.documentation, '"User docs"');
  assert.deepEqual(user?.attributes, ['@packed']);
  assert.equal(user?.bodyRange?.start.line, 4);
  assert.deepEqual(
    user?.children.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.returnType,
    ]),
    [
      ['name', SymbolKind.Field, 'String'],
      ['age', SymbolKind.Field, 'int'],
    ],
  );
  assert.equal(name?.documentation, '"Field docs"');
  assert.deepEqual(name?.attributes, ['@required']);
  assert.deepEqual(
    color?.children.map((symbol) => [symbol.name, symbol.returnType]),
    [
      ['RED', 'Color'],
      ['GREEN', 'Color'],
      ['BLUE', 'Color'],
    ],
  );
  assert.deepEqual(
    errorCode?.children.map((symbol) => [symbol.name, symbol.returnType]),
    [
      ['OK', 'ErrorCode'],
      ['FAIL', 'ErrorCode'],
    ],
  );
  assert.deepEqual(
    reader?.children.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.children.map((child) => child.name),
    ]),
    [['read', SymbolKind.Method, ['path']]],
  );
  assert.deepEqual(trace?.parameters, ['String msg']);
  assert.deepEqual(add?.parameters, ['int a', 'int b']);
});

test('parseSource extracts type methods and gives self the receiver type', () => {
  const source = [
    'module app;',
    'struct EventLoop {',
    '    bool running;',
    '}',
    'fn void EventLoop.init(&self)',
    '{',
    '    self.running = true;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource('file:///workspace/app.c3', source);
  const method = parsed.symbols.find((symbol) => symbol.name === 'init');
  const self = parsed.scopedSymbols.find((symbol) => symbol.name === 'self');

  assert.equal(method?.kind, SymbolKind.Method);
  assert.equal(method?.receiverType, 'EventLoop');
  assert.equal(method?.signature, 'void EventLoop.init(&self)');
  assert.equal(self?.returnType, 'EventLoop');
});

test('parseSource extracts implemented interfaces from aggregate declarations', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'interface MyName {',
      '    fn String myname();',
      '}',
      'struct Baz(MyName) {',
      '    int x;',
      '}',
      '',
    ].join('\n'),
  );

  const baz = parsed.symbols.find((symbol) => symbol.name === 'Baz');

  assert.deepEqual(baz?.implementedInterfaces, ['MyName']);
  assert.equal(baz?.signature, 'struct Baz(MyName)');
});

test('parseSource extracts callable parameter metadata', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void connect(String host, int port = 80, String[] ...tags) {}',
      'fn void EventLoop.init(&self, int count = 1) {}',
      '',
    ].join('\n'),
  );
  const connect = parsed.symbols.find((symbol) => symbol.name === 'connect');
  const init = parsed.symbols.find((symbol) => symbol.name === 'init');

  assert.deepEqual(connect?.parameterDetails, [
    {
      label: 'String host',
      name: 'host',
      type: 'String',
      optional: false,
      variadic: false,
      defaultValue: undefined,
      receiver: false,
    },
    {
      label: 'int port = 80',
      name: 'port',
      type: 'int',
      optional: true,
      variadic: false,
      defaultValue: '80',
      receiver: false,
    },
    {
      label: 'String[] ...tags',
      name: 'tags',
      type: 'String[]',
      optional: false,
      variadic: true,
      defaultValue: undefined,
      receiver: false,
    },
  ]);
  assert.deepEqual(
    init?.parameterDetails?.map((parameter) => [
      parameter.label,
      parameter.name,
      parameter.type,
      parameter.optional,
      parameter.receiver,
    ]),
    [
      ['&self', 'self', 'EventLoop', false, true],
      ['int count = 1', 'count', 'int', true, false],
    ],
  );
});

test('parseSource reports tree-sitter syntax diagnostics', () => {
  const parsed = parseSource(
    'file:///workspace/broken.c3',
    ['module broken;', 'fn void nope( {', ''].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.severity,
      diagnostic.message,
      diagnostic.source,
    ]),
    [
      [1, "Missing '}'", 'c3-lsp'],
      [1, "Missing ')'", 'c3-lsp'],
    ],
  );
});

test('parseSource reports a clear missing comma diagnostic in call arguments', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    listen("0.0.0.0", 7777, 10',
      '        SocketOption.REUSEADDR, SocketOption.REUSEPORT);',
      '}',
      '',
    ].join('\n'),
  );

  assert.equal(
    parsed.diagnostics[0]?.message,
    'Syntax error: missing comma between call arguments',
  );
  assert.deepEqual(parsed.diagnostics[0]?.range, {
    start: { line: 2, character: 28 },
    end: { line: 2, character: 30 },
  });
});

test('parseSource reports invalid bare typed initializer syntax precisely', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use(Poll[] polls, usz poll_count) {',
      '    polls[poll_count]=Poll{',
      '        .socket=server.sock,',
      '        .events=PollSubscribe.READ,',
      '    }',
      '    poll_count++;',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.message,
      diagnostic.source,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.character,
    ]),
    [
      [
        "Invalid initializer syntax for 'Poll': use '(Poll){ ... }' or infer the type with '{ ... }'.",
        'c3-lsp',
        2,
        22,
        26,
      ],
    ],
  );
});

test('parseSource accepts generic field types at the start of struct bodies', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
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
      '',
    ].join('\n'),
  );

  assert.deepEqual(parsed.diagnostics, []);
});

test('parseSource reports missing semicolon after typed initializer', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use(Poll[] polls, usz poll_count) {',
      '    polls[poll_count]=(Poll){',
      '        .socket=server.sock,',
      '        .events=PollSubscribe.READ,',
      '    }',
      '    poll_count++;',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.message,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [["Missing ';'", 5, 5]],
  );
});

test('parseSource recovers top-level callables after parser errors', () => {
  const parsed = parseSource(
    'file:///workspace/std/io.c3',
    [
      'module std::io;',
      '???',
      'macro void printn(x = "")',
      '{',
      '}',
      'fn sz? printfn(String format, args...) @format(0) @maydiscard',
      '{',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
      symbol.returnType,
      symbol.parameters,
    ]),
    [
      [
        'printn',
        SymbolKind.Function,
        'macro void printn(x = "")',
        'void',
        ['x = ""'],
      ],
      [
        'printfn',
        SymbolKind.Function,
        'fn sz? printfn(String format, args...) @format(0) @maydiscard',
        'sz?',
        ['String format', 'args...'],
      ],
    ],
  );
  assert.deepEqual(
    parsed.symbols
      .find((symbol) => symbol.name === 'printfn')
      ?.parameterDetails?.map((parameter) => [
        parameter.label,
        parameter.name,
        parameter.variadic,
      ]),
    [
      ['String format', 'format', false],
      ['args...', 'args', true],
    ],
  );
});

test('parseSource recovers enum declarations after parser errors', () => {
  const parsed = parseSource(
    'file:///workspace/std/net/socket.c3',
    [
      'module std::net;',
      '???',
      'enum SocketOption : char (CInt value)',
      '{',
      '    REUSEADDR                  { os::SO_REUSEADDR },',
      '    REUSEPORT @if(!env::WIN32) { os::SO_REUSEPORT },',
      '}',
      '',
    ].join('\n'),
  );
  const socketOption = parsed.symbols.find(
    (symbol) => symbol.name === 'SocketOption',
  );

  assert.equal(socketOption?.kind, SymbolKind.Enum);
  assert.equal(
    socketOption?.signature,
    'enum SocketOption : char (CInt value)',
  );
  assert.deepEqual(
    socketOption?.children.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.signature,
    ]),
    [
      [
        'REUSEADDR',
        SymbolKind.Constant,
        'REUSEADDR                  { os::SO_REUSEADDR }',
      ],
      [
        'REUSEPORT',
        SymbolKind.Constant,
        'REUSEPORT @if(!env::WIN32) { os::SO_REUSEPORT }',
      ],
    ],
  );
});

test('parseSource recovers type methods after parser errors', () => {
  const parsed = parseSource(
    'file:///workspace/std/collections/map.c3',
    [
      'module std::collections::map <Key, Value>;',
      '???',
      'fn HashMap* HashMap.init(&self, Allocator allocator)',
      '{',
      '}',
      'fn bool HashMap.set(&map, Key key, Value value) @operator([]=)',
      '{',
      '}',
      '',
    ].join('\n'),
  );

  assert.deepEqual(
    parsed.symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.receiverType,
      symbol.children.map((child) => [child.name, child.returnType]),
    ]),
    [
      [
        'init',
        SymbolKind.Method,
        'HashMap',
        [
          ['self', 'HashMap'],
          ['allocator', 'Allocator'],
        ],
      ],
      [
        'set',
        SymbolKind.Method,
        'HashMap',
        [
          ['map', 'HashMap'],
          ['key', 'Key'],
          ['value', 'Value'],
        ],
      ],
    ],
  );
});

test('parseSource does not merge an incomplete method declaration with the next function', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'interface MyName{',
      '    fn String myname();',
      '}',
      '',
      'struct Baz(MyName){',
      '    int x;',
      '}',
      '',
      'fn String Baz.',
      '',
      'fn void run_reactor(){',
      '    TcpServerSocket listener=tcp::listen("0.0.0.0",7777,10,',
      '        net::SocketOption.REUSEADDR,net::SocketOption.REUSEPORT)',
      '        ?? unreachable("listen failed");',
      '',
      '    Poll[MAX_CLIENTS] poll_fds;',
      '}',
    ].join('\n'),
  );

  const runReactor = parsed.symbols.find(
    (symbol) => symbol.name === 'run_reactor',
  );

  assert.equal(runReactor?.kind, SymbolKind.Function);
  assert.equal(runReactor?.receiverType, undefined);
  assert.equal(runReactor?.signature, 'fn void run_reactor()');
});

test('parseSource extracts var declarations as scoped symbols', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    var name @safeinfer = "C3";',
      '    name;',
      '}',
      '',
    ].join('\n'),
  );

  assert.equal(
    parsed.scopedSymbols.find((symbol) => symbol.name === 'name')?.signature,
    'var name @safeinfer = "C3";',
  );
  assert.deepEqual(
    parsed.scopedSymbols.find((symbol) => symbol.name === 'name')?.attributes,
    ['@safeinfer'],
  );
});

test('parseSource extracts local const declarations as scoped symbols', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    const Y=1;',
      '    $assert(Y==1):"ok";',
      '}',
      '',
    ].join('\n'),
  );

  assert.equal(
    parsed.scopedSymbols.find((symbol) => symbol.name === 'Y')?.signature,
    'const Y=1;',
  );
});

test('parseSource extracts for initializer declarations as scoped symbols', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    for (int i = 0; i < 4; i++) {',
      '        i;',
      '    }',
      '}',
      '',
    ].join('\n'),
  );

  const symbol = parsed.scopedSymbols.find((symbol) => symbol.name === 'i');

  assert.equal(symbol?.signature, 'int i = 0');
  assert.equal(symbol?.returnType, 'int');
  assert.equal(symbol?.scopeRange?.start.line, 2);
  assert.equal(symbol?.scopeRange?.end.line, 4);
});

test('parseSource skips unsafe var declarations in normal functions', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    [
      'module app;',
      'fn void use() {',
      '    var name = "C3";',
      '    name;',
      '}',
      '',
    ].join('\n'),
  );

  assert.equal(
    parsed.scopedSymbols.some((symbol) => symbol.name === 'name'),
    false,
  );
});

test('parseSource reports missing closing delimiters with focused syntax diagnostics', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'fn void use() {', '    connect(1, 2;', '}', ''].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.message,
      diagnostic.source,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [["Missing ')' before '}'", 'c3-lsp', 3, 0]],
  );
});

test('parseSource reports unterminated blocks with syntax diagnostics', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'fn void use() {', '    int x;', ''].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.message,
      diagnostic.source,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [["Missing '}'", 'c3-lsp', 1, 14]],
  );
});

test('parseSource reports missing semicolons in top-level directives', () => {
  const parsed = parseSource(
    'file:///workspace/app.c3',
    ['module app;', 'import std::io', 'fn void use() {}', ''].join('\n'),
  );

  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => [
      diagnostic.message,
      diagnostic.source,
      diagnostic.range.start.line,
      diagnostic.range.start.character,
    ]),
    [["Missing ';'", 'c3-lsp', 1, 14]],
  );
});
