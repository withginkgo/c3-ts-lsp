import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SymbolKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('ProjectIndex groups files from the same module', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();

  index.upsert(
    parseSource(mainUri, readFileSync('testdata/simple/main.c3', 'utf8')),
    false,
  );
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const module = index.getModule('http_demo');

  assert.equal(index.moduleCount(), 1);
  assert.deepEqual(module?.files, [mainUri, httpUri]);
  assert.deepEqual(
    [...(module?.symbols.keys() ?? [])],
    ['main', 'HttpResponse', 'read_response'],
  );
});

test('ProjectIndex indexes module-less current files', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/scratch.c3';

  index.upsert(parseSource(uri, 'fn void scratch() {}\n'));

  assert.equal(index.moduleCount(), 1);
  assert.equal(index.findSymbol(uri, 'scratch')?.signature, 'void scratch()');
});

test('ProjectIndex resolves symbols from files in the same module', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();

  index.upsert(
    parseSource(mainUri, readFileSync('testdata/simple/main.c3', 'utf8')),
    false,
  );
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const symbol = index.findSymbol(mainUri, 'read_response');

  assert.equal(symbol?.name, 'read_response');
  assert.equal(symbol?.uri, httpUri);
});

test('ProjectIndex resolves imported and qualified module symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';

  index.upsert(
    parseSource(
      appUri,
      ['module app;', 'import lib::net;', 'fn void use() {}', ''].join('\n'),
    ),
    false,
  );
  index.upsert(
    parseSource(
      netUri,
      ['module lib::net;', 'fn void connect() {}', ''].join('\n'),
    ),
    false,
  );
  index.rebuild();

  assert.equal(index.findSymbol(appUri, 'connect')?.uri, netUri);
  assert.equal(index.findSymbol(appUri, 'net::connect')?.uri, netUri);
  assert.equal(index.findSymbol(appUri, 'lib::net::connect')?.uri, netUri);
});

test('ProjectIndex resolves symbols from child modules of imported modules', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const channelUri = 'file:///stdlib/std/threads/buffered_channel.c3';
  const source = [
    'module app;',
    'import std::thread;',
    'struct ConsumerContext {',
    '    int id;',
    '    BufferedChannel{int}* ch;',
    '}',
    'fn void use(ConsumerContext context) {',
    '    context.ch.pop();',
    '    channel::create_buffered(mem, 1);',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source), false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/threads/thread.c3',
      ['module std::thread;', ''].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      channelUri,
      [
        'module std::thread::channel <Type>;',
        'typedef BufferedChannel = void;',
        'fn BufferedChannel*? create_buffered(Allocator allocator, sz size = 1) {}',
        'fn Type? BufferedChannel.pop(&self) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  assert.equal(index.findSymbol(appUri, 'BufferedChannel')?.uri, channelUri);
  assert.equal(
    index.resolveTypeName(
      appUri,
      'BufferedChannel{int}',
      doc.positionAt(source.indexOf('BufferedChannel')),
    ).selected?.uri,
    channelUri,
  );
  assert.equal(
    index.resolveSymbol(
      appUri,
      'channel::create_buffered',
      doc.positionAt(source.indexOf('channel::create_buffered')),
    ).selected?.uri,
    channelUri,
  );
  assert.equal(
    index.resolveSymbol(appUri, 'pop', doc.positionAt(source.indexOf('pop()')))
      .selected?.uri,
    channelUri,
  );
});

test('ProjectIndex deduplicates imported candidates by canonical module key', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'import std::collections;',
    'fn void use() {',
    '    result::ok{int, Parse_Error}(1);',
    '}',
    '',
  ].join('\n');
  const app = parseSource(appUri, source);

  index.upsert(app, false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/collections/collections.c3',
      ['module std::collections;', ''].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/collections/result-one.c3',
      [
        'module std::collections::result <OkType, ErrType>;',
        'struct Result {}',
        'fn Result ok(OkType val) { return {}; }',
        'fn OkType? Result.ok(&self);',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/collections/result-two.c3',
      [
        'module std::collections::result <OkType, ErrType>;',
        'struct Result {}',
        'fn Result ok(OkType val) { return {}; }',
        'fn OkType? Result.ok(&self);',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const result = index.resolveCallableSymbol(
    appUri,
    'result::ok',
    TextDocument.create(appUri, 'c3', 1, source).positionAt(
      source.indexOf('result::ok'),
    ),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.candidates.length, 1);
});

test('ProjectIndex resolves implicit std::core child module prefixes', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stringUri = 'file:///stdlib/std/core/string.c3';
  const source = [
    'module app;',
    'fn void use() {',
    '    string::format("task");',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source), false);
  index.upsert(
    parseSource(
      stringUri,
      ['module std::core::string;', 'fn String format(args...) {}', ''].join(
        '\n',
      ),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  assert.equal(
    index.resolveSymbol(
      appUri,
      'string::format',
      doc.positionAt(source.indexOf('string::format')),
    ).selected?.uri,
    stringUri,
  );
});

test('ProjectIndex models builtin any members', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void batch_job(any[] args) {',
    '    int task_id = *(int*)args[0].ptr;',
    '    typeid task_type = args[0].type;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source));

  const ptr = index.resolveSymbol(
    appUri,
    'ptr',
    doc.positionAt(source.indexOf('ptr')),
  );
  const type = index.resolveSymbol(
    appUri,
    'type',
    doc.positionAt(source.lastIndexOf('type')),
  );

  assert.equal(ptr.reason, 'resolved');
  assert.equal(ptr.selected?.returnType, 'void*');
  assert.equal(type.reason, 'resolved');
  assert.equal(type.selected?.returnType, 'typeid');
  assert.deepEqual(
    index
      .memberSymbolsForExpression(
        appUri,
        'args[0]',
        doc.positionAt(source.indexOf('args[0]')),
      )
      .map((symbol) => symbol.name),
    ['ptr', 'type'],
  );
});

test('ProjectIndex infers compile-time type macro slice returns', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Conn {}',
    'fn void use() {',
    '    Conn[] conns = mem::new_array(Conn, 64);',
    '    conns.len;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source), false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/core/mem.c3',
      [
        'module std::core::mem;',
        'macro Type[] new_array($Type type, usz len) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  assert.equal(
    index.typeNameForExpression(
      appUri,
      'mem::new_array(Conn, 64)',
      doc.positionAt(source.indexOf('mem::new_array')),
    ),
    'Conn[]',
  );
  assert.equal(
    index.resolveSymbol(appUri, 'len', doc.positionAt(source.indexOf('len')))
      .selected?.returnType,
    'usz',
  );
});

test('ProjectIndex findSymbol ignores unrelated modules', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const otherUri = 'file:///workspace/other.c3';

  index.upsert(
    parseSource(appUri, ['module app;', 'fn void use() {}', ''].join('\n')),
    false,
  );
  index.upsert(
    parseSource(
      otherUri,
      ['module other;', 'fn void unrelated() {}', ''].join('\n'),
    ),
    false,
  );
  index.rebuild();

  assert.equal(index.findSymbol(appUri, 'unrelated'), undefined);
});

test('ProjectIndex resolves relative imports', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/net.c3';
  const appSource = [
    'module app;',
    'import net;',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module app::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.indexOf('connect();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, netUri);
});

test('ProjectIndex resolves module aliases', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'alias net = module lib::net;',
    'fn void use() {',
    '    net::connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'net::connect',
    doc.positionAt(appSource.indexOf('net::connect')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, netUri);
});

test('ProjectIndex resolves relative module aliases', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/net.c3';
  const appSource = [
    'module app;',
    'alias net = module net;',
    'fn void use() {',
    '    net::connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module app::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'net::connect',
    doc.positionAt(appSource.indexOf('net::connect')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, netUri);
});

test('ProjectIndex resolves implicitly imported std::core symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const builtinUri = 'file:///stdlib/std/core/builtin.c3';
  const appSource = [
    'module app;',
    'fn void use() {',
    '    unreachable("listen failed");',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(
      builtinUri,
      [
        'module std::core::builtin;',
        'macro void unreachable(String string = "Unreachable statement reached.", ...) @builtin @noreturn',
        '{',
        '}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'unreachable',
    doc.positionAt(appSource.indexOf('unreachable')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, builtinUri);
  assert.equal(
    index.importCandidatesForSymbol(index.getParsed(appUri)!, 'unreachable')
      .length,
    0,
  );
});

test('ProjectIndex ignores inactive stdlib module @if branches', () => {
  const index = new ProjectIndex({ activeEnvironment: ['LINUX'] });
  const appUri = 'file:///workspace/app.c3';
  const appSource = [
    'module app;',
    'import std::net;',
    'struct EventLoop {',
    '    NativeSocket socket;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/socket.c3',
      [
        'module std::net;',
        'import std::net::os;',
        'struct Socket {',
        '    NativeSocket sock;',
        '}',
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
        'module std::net::os @if(env::POSIX && SUPPORTS_INET);',
        'typedef NativeSocket = inline Fd;',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/net/os/win32.c3',
      [
        'module std::net::os @if(env::WIN32);',
        'typedef NativeSocket = inline Win32_SOCKET;',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const result = index.resolveTypeName(
    appUri,
    'NativeSocket',
    doc.positionAt(appSource.indexOf('NativeSocket')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, 'file:///stdlib/std/net/os/posix.c3');
});

test('ProjectIndex filters private imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void use() {',
    '    hidden();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void hidden() @private {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'hidden',
    doc.positionAt(appSource.indexOf('hidden();')),
  );

  assert.equal(result.reason, 'not_found');
});

test('ProjectIndex removes closed or deleted documents from the index', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/temp.c3';

  index.upsert(
    parseSource(uri, ['module temp;', 'fn void gone() {}', ''].join('\n')),
  );

  assert.equal(index.findSymbol(uri, 'gone')?.name, 'gone');

  index.remove(uri);

  assert.equal(index.moduleCount(), 0);
  assert.equal(index.findSymbol(uri, 'gone'), undefined);
});

test('ProjectIndex incrementally moves files between modules', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/moved.c3';

  index.upsert(parseSource(uri, 'module old;\nfn void item() {}\n'));
  index.upsert(parseSource(uri, 'module newer;\nfn void item() {}\n'));

  assert.equal(index.getModule('old'), undefined);
  assert.equal(index.getModule('newer')?.files[0], uri);
  assert.equal(index.findSymbol(uri, 'item')?.moduleName, 'newer');
});

test('ProjectIndex resolves nested declaration symbols for hover and definition', () => {
  const index = new ProjectIndex();
  const uri = pathToFileURL('testdata/phase1/syntax.c3').toString();

  index.upsert(
    parseSource(uri, readFileSync('testdata/phase1/syntax.c3', 'utf8')),
  );

  assert.equal(
    index.findSymbol(uri, 'name')?.signature,
    'String name @required;',
  );
  assert.equal(index.findSymbol(uri, 'GREEN')?.signature, 'GREEN = 2');
  assert.equal(index.findSymbol(uri, 'path')?.signature, 'String path');
  assert.equal(index.findSymbol(uri, 'a')?.signature, 'int a');
});

test('ProjectIndex resolves local declarations by cursor position', () => {
  const index = new ProjectIndex();
  const mainUri = pathToFileURL('testdata/simple/main.c3').toString();
  const httpUri = pathToFileURL('testdata/simple/http.c3').toString();
  const mainSource = readFileSync('testdata/simple/main.c3', 'utf8');
  const doc = TextDocument.create(mainUri, 'c3', 1, mainSource);

  index.upsert(parseSource(mainUri, mainSource), false);
  index.upsert(
    parseSource(httpUri, readFileSync('testdata/simple/http.c3', 'utf8')),
    false,
  );
  index.rebuild();

  const symbol = index.findSymbolAt(
    mainUri,
    'res',
    doc.positionAt(mainSource.indexOf('&res') + 1),
  );

  assert.equal(symbol?.uri, mainUri);
  assert.equal(symbol?.signature, 'HttpResponse res;');
});

test('ProjectIndex resolves struct members by receiver type', () => {
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
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'body',
    doc.positionAt(source.lastIndexOf('body')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.signature, 'String body;');
});

test('ProjectIndex resolves promoted fields from anonymous union members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
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
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  assert.deepEqual(
    ['a', 'b', 'ok'].map((name) => {
      const access = `sample.${name}`;
      const result = index.resolveSymbol(
        uri,
        name,
        doc.positionAt(source.indexOf(access) + 'sample.'.length),
      );
      return [name, result.reason, result.selected?.returnType];
    }),
    [
      ['a', 'resolved', 'int'],
      ['b', 'resolved', 'String'],
      ['ok', 'resolved', 'bool'],
    ],
  );
});

test('ProjectIndex substitutes generic parameters for promoted union fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
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
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  assert.deepEqual(
    ['error', 'value', 'is_ok'].map((name) => {
      const result = index.resolveSymbol(
        uri,
        name,
        doc.positionAt(source.lastIndexOf(name)),
      );
      return [name, result.reason, result.selected?.returnType];
    }),
    [
      ['error', 'resolved', 'Parse_Error'],
      ['value', 'resolved', 'int'],
      ['is_ok', 'resolved', 'bool'],
    ],
  );
});

test('ProjectIndex resolves struct members through pointer-like receiver types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use(HttpResponse* res) {',
    '    res.body;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'body',
    doc.positionAt(source.lastIndexOf('body')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.signature, 'String body;');
});

test('ProjectIndex resolves members through parenthesized unary receivers', () => {
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
    'fn void use(Outer* pointer, Outer value) {',
    '    (*pointer).inner.value;',
    '    (&value).inner.value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const derefResult = index.resolveSymbol(
    uri,
    'value',
    doc.positionAt(
      source.indexOf('(*pointer).inner.value') + '(*pointer).inner.'.length,
    ),
  );
  const addressResult = index.resolveSymbol(
    uri,
    'value',
    doc.positionAt(
      source.indexOf('(&value).inner.value') + '(&value).inner.'.length,
    ),
  );

  assert.equal(derefResult.reason, 'resolved');
  assert.equal(derefResult.selected?.signature, 'int value;');
  assert.equal(addressResult.reason, 'resolved');
  assert.equal(addressResult.selected?.signature, 'int value;');
});

test('ProjectIndex resolves chained member expressions', () => {
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
    'fn void use(Outer outer) {',
    '    outer.inner.value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'value',
    doc.positionAt(source.lastIndexOf('value')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.signature, 'int value;');
});

test('ProjectIndex resolves members on call and subscript expression receivers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Inner {',
    '    int value;',
    '}',
    'struct Outer {',
    '    Inner inner;',
    '    Inner[] items;',
    '}',
    'fn Outer make() {}',
    'fn void use(Outer outer) {',
    '    make().inner.value;',
    '    outer.items[0].value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const callResult = index.resolveSymbol(
    uri,
    'value',
    doc.positionAt(source.indexOf('value')),
  );
  const subscriptResult = index.resolveSymbol(
    uri,
    'value',
    doc.positionAt(source.lastIndexOf('value')),
  );

  assert.equal(callResult.reason, 'resolved');
  assert.equal(callResult.selected?.signature, 'int value;');
  assert.equal(subscriptResult.reason, 'resolved');
  assert.equal(subscriptResult.selected?.signature, 'int value;');
});

test('ProjectIndex resolves self members and type methods', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct EventLoop {',
    '    bool running;',
    '}',
    'fn void EventLoop.init(&self) {',
    '    self.running = true;',
    '}',
    'fn void use() {',
    '    EventLoop loop;',
    '    loop.init();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const selfMember = index.resolveSymbol(
    uri,
    'running',
    doc.positionAt(source.indexOf('running = true')),
  );
  const method = index.resolveSymbol(
    uri,
    'init',
    doc.positionAt(source.indexOf('init();')),
  );

  assert.equal(selfMember.reason, 'resolved');
  assert.equal(selfMember.selected?.signature, 'bool running;');
  assert.equal(method.reason, 'resolved');
  assert.equal(method.selected?.kind, SymbolKind.Method);
  assert.equal(method.selected?.signature, 'void EventLoop.init(&self)');
});

test('ProjectIndex lets alias receiver methods shadow target type methods', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const threadUri = 'file:///stdlib/std/threads/thread.c3';
  const osUri = 'file:///stdlib/std/threads/os/thread_posix.c3';
  const appSource = [
    'module app;',
    'import std::thread;',
    'fn void run() {',
    '    Thread producer_thread;',
    '    producer_thread.create();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(
      threadUri,
      [
        'module std::thread;',
        'import std::thread::os;',
        'typedef Thread = inline NativeThread;',
        'macro void Thread.create(&thread) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.upsert(
    parseSource(
      osUri,
      [
        'module std::thread::os;',
        'struct NativeThread {}',
        'fn void NativeThread.create(&thread) {}',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'create',
    doc.positionAt(appSource.indexOf('create();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, threadUri);
  assert.equal(result.selected?.signature, 'macro void Thread.create(&thread)');
});

test('ProjectIndex exposes interface methods on implementing struct types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'interface MyName {',
    '    fn String myname();',
    '}',
    'struct Baz(MyName) {',
    '    int x;',
    '}',
    'fn void use(Baz baz) {',
    '    baz.myname();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'myname',
    doc.positionAt(source.indexOf('myname();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.kind, SymbolKind.Method);
  assert.equal(result.selected?.signature, 'String myname()');
});

test('ProjectIndex prefers concrete methods over implemented interface methods', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'interface MyName {',
    '    fn String myname();',
    '}',
    'struct Baz(MyName) {',
    '}',
    'fn String Baz.myname(Baz* self) @dynamic {',
    '    return "i am baz!";',
    '}',
    'fn void use(Baz baz) {',
    '    baz.myname();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'myname',
    doc.positionAt(source.lastIndexOf('myname();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(
    result.selected?.signature,
    'String Baz.myname(Baz* self) @dynamic',
  );
});

test('ProjectIndex resolves methods through generic field receiver types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct NativeSocket {}',
    'struct Handlers {}',
    'struct Poll {',
    '    int fd;',
    '}',
    'struct HashMap {}',
    'struct List {}',
    'struct EventLoop {',
    '    HashMap{NativeSocket, Handlers} handlers;',
    '    List{Poll} polls;',
    '}',
    'fn void HashMap.init(&self) {}',
    'fn void List.init(&self) {}',
    'fn void use(EventLoop loop) {',
    '    loop.handlers.init();',
    '    loop.polls.init();',
    '    loop.polls[0].fd;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const handlersInit = index.resolveSymbol(
    uri,
    'init',
    doc.positionAt(source.indexOf('init();', source.indexOf('handlers'))),
  );
  const pollsInit = index.resolveSymbol(
    uri,
    'init',
    doc.positionAt(source.indexOf('init();', source.indexOf('polls.init'))),
  );
  const pollField = index.resolveSymbol(
    uri,
    'fd',
    doc.positionAt(source.lastIndexOf('fd;')),
  );

  assert.equal(handlersInit.reason, 'resolved');
  assert.equal(handlersInit.selected?.signature, 'void HashMap.init(&self)');
  assert.equal(pollsInit.reason, 'resolved');
  assert.equal(pollsInit.selected?.signature, 'void List.init(&self)');
  assert.equal(pollField.reason, 'resolved');
  assert.equal(pollField.selected?.signature, 'int fd;');
});

test('ProjectIndex infers foreach value variable types from collection expressions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Poll {',
    '    int fd;',
    '}',
    'struct EventLoop {',
    '    Poll[] polls;',
    '}',
    'fn void EventLoop.run(&self) {',
    '    foreach (&p : self.polls) {',
    '        p.fd;',
    '    }',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'fd',
    doc.positionAt(source.lastIndexOf('fd')),
  );

  assert.equal(
    index.typeNameForExpression(
      uri,
      'p',
      doc.positionAt(source.lastIndexOf('p.fd')),
    ),
    'Poll*',
  );
  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.signature, 'int fd;');
});

test('ProjectIndex reports duplicate callable names as ambiguous', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn int add(int a) { return a; }',
    'fn float add(float a) { return a; }',
    'fn void use() {',
    '    add(1);',
    '    add(1.0);',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'add',
    doc.positionAt(source.indexOf('add(1);')),
  );

  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.signature),
    ['int add(int a)', 'float add(float a)'],
  );
});

test('ProjectIndex infers enum constant expression types', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'enum SocketOption : char {',
    '    REUSEADDR,',
    '}',
    'fn void use() {',
    '    var option @safeinfer = SocketOption.REUSEADDR;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  assert.equal(
    index.typeNameForExpression(
      uri,
      'SocketOption.REUSEADDR',
      doc.positionAt(source.indexOf('SocketOption.REUSEADDR')),
    ),
    'SocketOption',
  );
});

test('ProjectIndex exposes visible scoped symbols at a position', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use(String path) {',
    '    int count;',
    '    count;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const symbols = index.visibleSymbolsAt(
    uri,
    doc.positionAt(source.indexOf('count;')),
  );

  assert.deepEqual(
    symbols.slice(0, 2).map((symbol) => [symbol.name, symbol.signature]),
    [
      ['count', 'int count;'],
      ['path', 'String path'],
    ],
  );
});

test('ProjectIndex includes type usages in references', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct HttpResponse {',
    '    String body;',
    '}',
    'fn void use(HttpResponse response) {',
    '    HttpResponse local;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const symbol = index.resolveSymbol(
    uri,
    'HttpResponse',
    doc.positionAt(source.indexOf('HttpResponse')),
  ).selected;

  assert.deepEqual(
    symbol ? index.referencesTo(symbol).map((location) => location.range) : [],
    [
      {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 19 },
      },
      {
        start: { line: 4, character: 12 },
        end: { line: 4, character: 24 },
      },
      {
        start: { line: 5, character: 4 },
        end: { line: 5, character: 16 },
      },
    ],
  );
});

test('ProjectIndex resolves local references from syntax nodes', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void use() {',
    '    int count;',
    '    count;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const symbol = index.resolveSymbol(
    uri,
    'count',
    doc.positionAt(source.lastIndexOf('count')),
  ).selected;

  assert.deepEqual(
    symbol ? index.referencesTo(symbol).map((location) => location.range) : [],
    [
      {
        start: { line: 2, character: 8 },
        end: { line: 2, character: 13 },
      },
      {
        start: { line: 3, character: 4 },
        end: { line: 3, character: 9 },
      },
    ],
  );
});

test('ProjectIndex resolves member references from syntax nodes', () => {
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
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const symbol = index.resolveSymbol(
    uri,
    'body',
    doc.positionAt(source.lastIndexOf('body')),
  ).selected;

  assert.deepEqual(
    symbol ? index.referencesTo(symbol).map((location) => location.range) : [],
    [
      {
        start: { line: 2, character: 11 },
        end: { line: 2, character: 15 },
      },
      {
        start: { line: 6, character: 8 },
        end: { line: 6, character: 12 },
      },
    ],
  );
});

test('ProjectIndex does not resolve parameters from unrelated scopes by position', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void takes(int value) {}',
    'fn void use() {',
    '    value;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  assert.equal(
    index.findSymbolAt(uri, 'value', doc.positionAt(source.indexOf('value;'))),
    undefined,
  );
});

test('ProjectIndex returns resolve result with selected symbol', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = ['module app;', 'fn void connect() {}', ''].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const result = index.resolveSymbol(
    uri,
    'connect',
    doc.positionAt(source.indexOf('connect')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.name, 'connect');
  assert.equal(result.candidates.length, 1);
});

test('ProjectIndex reports ambiguous imported symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const oneUri = 'file:///workspace/lib/one.c3';
  const twoUri = 'file:///workspace/lib/two.c3';

  const appSource = [
    'module app;',
    'import lib::one;',
    'import lib::two;',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(oneUri, 'module lib::one;\nfn void connect() {}\n'),
    false,
  );
  index.upsert(
    parseSource(twoUri, 'module lib::two;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const doc = TextDocument.create(appUri, 'c3', 1, appSource);
  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.indexOf('connect();')),
  );

  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates.length, 2);
});

test('ProjectIndex prefers current module symbols over imported candidates', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void connect() {}',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.lastIndexOf('connect();')),
  );

  assert.equal(result.reason, 'resolved');
  assert.equal(result.selected?.uri, appUri);
  assert.equal(result.candidates.length, 1);
});

test('ProjectIndex position-aware resolver ignores unrelated global symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'fn void use() {',
    '    connect();',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parseSource(appUri, appSource), false);
  index.upsert(
    parseSource(netUri, 'module lib::net;\nfn void connect() {}\n'),
    false,
  );
  index.rebuild();

  const result = index.resolveSymbol(
    appUri,
    'connect',
    doc.positionAt(appSource.indexOf('connect();')),
  );

  assert.equal(result.reason, 'not_found');
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates.length, 0);
});
