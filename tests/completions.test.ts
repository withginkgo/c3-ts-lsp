import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CompletionItemKind,
  CompletionTriggerKind,
  InsertTextFormat,
  type CompletionItem,
  type CompletionContext,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { completionItems } from '../src/lsp/completions.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

function completionFixture(uri: string, markedLines: string[]) {
  const markedSource = markedLines.join('\n');
  const cursorOffset = markedSource.indexOf('|');
  assert.notEqual(cursorOffset, -1);

  const source = markedSource.replace('|', '');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  return {
    source,
    doc,
    parsed,
    position: doc.positionAt(cursorOffset),
  };
}

function addResultStdlib(index: ProjectIndex): void {
  index.upsert(
    parseSource(
      'file:///stdlib/std/collections/result.c3',
      [
        'module std::collections::result <OkType, ErrType>;',
        'struct Result {}',
        'fn Result err(ErrType err) { return {}; }',
        '',
      ].join('\n'),
      { sourceKind: 'stdlib' },
    ),
  );
}

function dotTriggerContext(): CompletionContext {
  return {
    triggerKind: CompletionTriggerKind.TriggerCharacter,
    triggerCharacter: '.',
  };
}

function applyCompletionTextEdit(
  source: string,
  doc: TextDocument,
  item: CompletionItem,
): string {
  const edit = item.textEdit;
  if (!edit || !('range' in edit)) {
    throw new Error('completion item does not provide a text edit range');
  }

  const start = doc.offsetAt(edit.range.start);
  const end = doc.offsetAt(edit.range.end);

  return `${source.slice(0, start)}${edit.newText}${source.slice(end)}`;
}

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

test('completionItems suggests named arguments inside function calls', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void connect(String host, int port = 80, String[] ...tags) {}',
    'fn void use() {',
    '    connect(host: "example", p',
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
    doc.positionAt(source.lastIndexOf(' p') + 2),
  ).filter((item) => item.insertText?.endsWith(': '));

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail, item.insertText]),
    [
      ['port', CompletionItemKind.Variable, 'int port = 80', 'port: '],
      ['tags', CompletionItemKind.Variable, 'String[] ...tags', 'tags: '],
    ],
  );
});

test('completionItems suggests method arguments without the receiver', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct EventLoop {}',
    'fn void EventLoop.init(&self, int count = 1) {}',
    'fn void use(EventLoop loop) {',
    '    loop.init(c',
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
    doc.positionAt(source.indexOf('loop.init(c') + 'loop.init(c'.length),
  ).filter((item) => item.insertText?.endsWith(': '));

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail, item.insertText]),
    [['count', CompletionItemKind.Variable, 'int count = 1', 'count: ']],
  );
});

test('completionItems only suggests attributes after @', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'attrdef @Route(String path);',
    'struct DynamicArenaAllocator {}',
    'fn void use() @',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.lastIndexOf('@') + '@'.length),
  );

  assert.equal(
    items.every((item) => item.label.startsWith('@')),
    true,
  );
  assert.equal(
    items.find((item) => item.label === '@dynamic')?.kind,
    CompletionItemKind.Property,
  );
  assert.equal(
    items.find((item) => item.label === '@Route')?.kind,
    CompletionItemKind.Property,
  );
  assert.equal(
    items.some((item) => item.label === 'DynamicArenaAllocator'),
    false,
  );
});

test('completionItems filters attributes after a typed @ prefix', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'attrdef @Route(String path);',
    'fn void use() @dyna',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const position = doc.positionAt(source.indexOf('@dyna') + '@dyna'.length);
  const items = completionItems(index, doc, parsed, position);

  assert.deepEqual(
    items.map((item) => item.label),
    ['@dynamic'],
  );
  assert.deepEqual(items[0]?.textEdit, {
    range: {
      start: doc.positionAt(source.indexOf('@dyna') + '@'.length),
      end: position,
    },
    newText: 'dynamic',
  });
});

test('completionItems suggests contract directives inside doc comments', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    '<*',
    ' @r',
    '*>',
    'fn void use() {}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const item = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('@r') + '@r'.length),
  ).find((candidate) => candidate.label === '@require');

  assert.equal(item?.kind, CompletionItemKind.Snippet);
  assert.equal(item?.insertTextFormat, InsertTextFormat.Snippet);
  assert.deepEqual(item?.textEdit, {
    range: {
      start: { line: 2, character: 1 },
      end: { line: 2, character: 3 },
    },
    newText: '@require(${1:condition})',
  });
});

test('completionItems suggests contract scope symbols and ensure return', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'const bool GLOBAL_READY = true;',
    '<*',
    ' @require li',
    ' @require lo',
    ' @ensure r',
    '*>',
    'fn bool checked(int limit) {',
    '    bool local_ready;',
    '    return limit > 0;',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const requireItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('li') + 'li'.length),
  );
  const localItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('lo') + 'lo'.length),
  );
  const ensureItems = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('@ensure r') + '@ensure r'.length),
  );

  assert.deepEqual(
    requireItems.map((item) => [item.label, item.kind, item.detail]),
    [['limit', CompletionItemKind.Variable, 'int']],
  );
  assert.deepEqual(
    localItems.map((item) => [item.label, item.kind, item.detail]),
    [['local_ready', CompletionItemKind.Variable, 'bool']],
  );
  assert.equal(
    ensureItems.find((item) => item.label === 'return')?.detail,
    'bool',
  );
});

test('completionItems suggests parameters after an incomplete contract call form', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    '<*',
    ' @require(',
    '*>',
    'fn void checked(int value) {}',
    '',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('@require(') + '@require('.length),
  );

  assert.equal(
    items.some(
      (item) =>
        item.label === 'value' &&
        item.kind === CompletionItemKind.Variable &&
        item.detail === 'int',
    ),
    true,
  );
});

test('completionItems returns members in contract expressions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct User {',
    '    bool active;',
    '}',
    'fn bool User.ready(&self) { return self.active; }',
    '<*',
    ' @require user.',
    '*>',
    'fn bool checked(User user) {',
    '    return user.active;',
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
    doc.positionAt(source.indexOf('user.') + 'user.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['active', CompletionItemKind.Field, 'bool active;'],
      ['ready', CompletionItemKind.Method, 'bool User.ready(&self)'],
    ],
  );
});

test('completionItems replaces the $ trigger for compile-time completions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = ['module app;', 'fn void use() {', '    $', '}', ''].join(
    '\n',
  );
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const dollarOffset = source.indexOf('$');
  const position = doc.positionAt(dollarOffset + '$'.length);

  index.upsert(parsed);

  const item = completionItems(index, doc, parsed, position).find(
    (candidate) => candidate.label === '$defined',
  );

  assert.deepEqual(item?.textEdit, {
    range: {
      start: doc.positionAt(dollarOffset),
      end: position,
    },
    newText: '$defined',
  });
});

test('completionItems suggests reflected member descriptor members', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/reflection.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'macro print_json_fields($Type){',
    '    $foreach $field : $Type::members:',
    '        $field.|',
    '    $endforeach',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const labels = completionItems(index, doc, parsed, position).map(
    (item) => item.label,
  );

  for (const label of [
    'name',
    'type',
    'offset',
    'alignment',
    'has_tag',
    'get_tag',
  ]) {
    assert.equal(labels.includes(label), true, `${label} should be suggested`);
  }
});

test('completionItems suggests reflected members in serialization macro', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/encode.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'macro void @encode_json($Type, $Type* obj)',
    '{',
    '    $foreach $member : $Type::members:',
    '        $member.|',
    '    $endforeach',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const labels = completionItems(index, doc, parsed, position).map(
    (item) => item.label,
  );

  for (const label of [
    'name',
    'type',
    'offset',
    'alignment',
    'has_tag',
    'get_tag',
  ]) {
    assert.equal(labels.includes(label), true, `${label} should be suggested`);
  }
});

test('completionItems suggests partial reflected member descriptor methods', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/reflection.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'macro print_json_fields($Type){',
    '    $foreach $field : $Type::members:',
    '        $field.has_|',
    '    $endforeach',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const labels = completionItems(index, doc, parsed, position).map(
    (item) => item.label,
  );

  assert.equal(labels.includes('has_tag'), true);
});

test('completionItems suggests reflected type access members', () => {
  for (const lines of [
    ['macro print_json_fields($Type){', '    $Type::|', '}', ''],
    [
      'macro print_json_fields($Type){',
      '    $foreach $field : $Type::|',
      '}',
      '',
    ],
  ]) {
    const index = new ProjectIndex();
    const uri = 'file:///workspace/reflection.c3';
    const { doc, parsed, position } = completionFixture(uri, lines);

    index.upsert(parsed);

    const labels = completionItems(index, doc, parsed, position).map(
      (item) => item.label,
    );

    assert.equal(labels.includes('members'), true);
  }
});

test('completionItems suggests implemented interface methods in type method declarations', () => {
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
    'fn String Baz.',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['myname', CompletionItemKind.Method, 'String myname()']],
  );
});

test('completionItems suggests interface methods in module-less type method declarations', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
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
    '    (void)listener.set_option(net::SocketOption.REUSEADDR,true);',
    '    (void)listener.sock.set_non_blocking(true);',
    '',
    '    Poll[MAX_CLIENTS] poll_fds;',
    '',
    '}',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.indexOf('fn String Baz.') + 'fn String Baz.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['myname', CompletionItemKind.Method, 'String myname()']],
  );
});

test('completionItems treats return-type method declarations as method declarations', () => {
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
    'fn void run_reactor() {}',
    'String Baz.',
  ].join('\n');
  const parsed = parseSource(uri, source);
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(source.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['myname', CompletionItemKind.Method, 'String myname()']],
  );
});

test('completionItems does not mix globals into type method declarations while editing an existing method', () => {
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
    'fn void run_reactor() {}',
    'fn String Baz.myname() @dynamic {',
    '    return "i am baz!";',
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
    doc.positionAt(source.indexOf('Baz.') + 'Baz.'.length),
  );

  assert.equal(
    items.some((item) => item.label === 'myname'),
    true,
  );
  assert.equal(
    items.some((item) => item.label === 'run_reactor'),
    false,
  );
});

test('completionItems suppresses global symbols after unmatched dot access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void run_reactor() {}',
    'fn void use() {',
    '    value. ',
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
    doc.positionAt(source.indexOf('value. ') + 'value. '.length),
  );

  assert.equal(
    items.some((item) => item.label === 'run_reactor'),
    false,
  );
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

test('completionItems returns promoted anonymous union fields after member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Student {',
    '    String age;',
    '    String name;',
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
    '    Result{int, Student} x;',
    '    x.|',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const items = completionItems(index, doc, parsed, position);
  const byLabel = new Map(items.map((item) => [item.label, item]));

  assert.equal(byLabel.get('value')?.kind, CompletionItemKind.Field);
  assert.equal(byLabel.get('value')?.detail, 'int value;');
  assert.equal(byLabel.get('error')?.kind, CompletionItemKind.Field);
  assert.equal(byLabel.get('error')?.detail, 'Student error;');
  assert.equal(byLabel.get('is_ok')?.kind, CompletionItemKind.Field);
  assert.equal(byLabel.get('is_ok')?.detail, 'bool is_ok;');
});

test('completionItems returns builtin any members after member access', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'fn void batch_job(any[] args) {',
    '    args[0].',
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
    doc.positionAt(source.indexOf('args[0].') + 'args[0].'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['ptr', CompletionItemKind.Field, 'void* ptr;'],
      ['type', CompletionItemKind.Field, 'typeid type;'],
    ],
  );
});

test('completionItems inserts parens for method call completions', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct EventLoop {}',
    'fn void EventLoop.init(&self) {}',
    'fn void use(EventLoop loop) {',
    '    loop.',
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
    doc.positionAt(source.indexOf('loop.') + 'loop.'.length),
  );

  assert.deepEqual(
    items.map((item) => [
      item.label,
      item.kind,
      item.detail,
      item.insertText,
      item.insertTextFormat,
      item.command,
    ]),
    [
      [
        'init',
        CompletionItemKind.Method,
        'void EventLoop.init(&self)',
        'init($0)',
        InsertTextFormat.Snippet,
        {
          title: 'Trigger Parameter Hints',
          command: 'editor.action.triggerParameterHints',
        },
      ],
    ],
  );
});

test('completionItems lets alias receiver methods shadow target type methods', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = [
    'module app;',
    'import std::thread;',
    'fn void run() {',
    '    Thread producer_thread;',
    '    producer_thread.',
    '}',
    '',
  ].join('\n');
  const parsed = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsed, false);
  index.upsert(
    parseSource(
      'file:///stdlib/std/threads/thread.c3',
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
      'file:///stdlib/std/threads/os/thread_posix.c3',
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

  const items = completionItems(
    index,
    doc,
    parsed,
    doc.positionAt(
      appSource.indexOf('producer_thread.') + 'producer_thread.'.length,
    ),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      [
        'create',
        CompletionItemKind.Method,
        'macro void Thread.create(&thread)',
      ],
    ],
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

test('completionItems returns struct initializer fields after designator dot', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Poll {',
    '    Socket socket;',
    '    int events;',
    '}',
    'fn void socket_factory() {}',
    'fn void use(Poll[] polls, usz poll_count) {',
    '    polls[poll_count] = (Poll){',
    '        .so',
    '    };',
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
    doc.positionAt(source.indexOf('.so') + '.so'.length),
  );

  assert.deepEqual(
    items.map((item) => [
      item.label,
      item.kind,
      item.detail,
      item.textEdit && 'newText' in item.textEdit
        ? item.textEdit.newText
        : undefined,
    ]),
    [['socket', CompletionItemKind.Field, 'Socket socket;', 'socket']],
  );
  const edit = items[0]?.textEdit;
  assert.equal(
    edit && 'range' in edit ? doc.getText(edit.range) : undefined,
    'so',
  );
  assert.equal(
    items.some((item) => item.label === 'socket_factory'),
    false,
  );
});

test('completionItems returns struct initializer fields immediately after dot trigger', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Poll {',
    '    Socket socket;',
    '    int events;',
    '}',
    'fn void socket_factory() {}',
    'fn void use(Poll[] polls, usz poll_count) {',
    '    polls[poll_count] = (Poll){',
    '        .',
    '    };',
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
    doc.positionAt(source.indexOf('        .') + '        .'.length),
    dotTriggerContext(),
  );
  const labels = items.map((item) => item.label);

  assert.equal(labels.includes('socket'), true);
  assert.equal(labels.includes('events'), true);
  assert.equal(labels.includes('socket_factory'), false);
});

test('completionItems infers struct initializer fields from assignment target', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Poll {',
    '    Socket socket;',
    '    int events;',
    '}',
    'fn void socket_factory() {}',
    'fn void use(Poll[] polls, usz poll_count) {',
    '    polls[poll_count] = {',
    '        .so',
    '    };',
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
    doc.positionAt(source.indexOf('.so') + '.so'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['socket', CompletionItemKind.Field, 'Socket socket;']],
  );
  assert.equal(
    items.some((item) => item.label === 'socket_factory'),
    false,
  );
});

test('completionItems uses explicit initializer type for struct field designators', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
    'module app;',
    'struct Parse_Error {',
    '    int line;',
    '    String message;',
    '}',
    'fn void main() {',
    '    Parse_Error err = {.',
    '    };',
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
    doc.positionAt(source.indexOf('{.') + '{.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems uses return context to infer generic call argument initializer fields', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const appSource = [
    'module app;',
    'import std::collections::result;',
    'struct Parse_Error {',
    '    int line;',
    '    String message;',
    '}',
    'fn Result{int, Parse_Error} parse_number(String s) {',
    '    return result::err({.',
    '    });',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result {}',
    'fn Result err(ErrType err) { return {}; }',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const parsedResult = parseSource(resultUri, resultSource, {
    sourceKind: 'stdlib',
  });
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedResult);
  index.upsert(parsedApp);

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('{.') + '{.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems uses variable initializer context to infer generic call argument fields', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const appSource = [
    'module app;',
    'import std::collections::result;',
    'struct Parse_Error {',
    '    int line;',
    '    String message;',
    '}',
    'fn Result{int, Parse_Error} parse_number(String s) {',
    '    Result{int, Parse_Error} x = result::err({.',
    '    });',
    '    return x;',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result {}',
    'fn Result err(ErrType err) { return {}; }',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const parsedResult = parseSource(resultUri, resultSource, {
    sourceKind: 'stdlib',
  });
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedResult);
  index.upsert(parsedApp);

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('{.') + '{.'.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems returns fields for an incomplete assignment struct literal', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn int main()',
    '{',
    '    Parse_Error err = {.|};',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    position,
    dotTriggerContext(),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems infers return generic argument fields in incomplete struct literal', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn Result{int, Parse_Error} parse_number(String s)',
    '{',
    '    return result::err({.|});',
    '}',
    '',
  ]);

  addResultStdlib(index);
  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    position,
    dotTriggerContext(),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems infers variable generic argument fields in incomplete struct literal', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn int main(String[] args)',
    '{',
    '    Result{int, Parse_Error} x = result::err({.|});',
    '}',
    '',
  ]);

  addResultStdlib(index);
  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    position,
    dotTriggerContext(),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems handles dot-triggered result error initializer fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { source, doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    '',
    'Result{int, Parse_Error} test = {.is_ok = true, .value = 1};',
    '',
    'fn Result{int, Parse_Error} parse_number(String s)',
    '{',
    '    int? v = s.to_int();',
    '    if (catch v) return result::err({.line = 1, .message = string::tformat("not a number: %s", s)});',
    '    return result::ok(v);',
    '}',
    '',
    'fn int main(String[] args)',
    '{',
    '    Result{int, Parse_Error} x = result::err({.|});',
    '}',
    '',
  ]);

  addResultStdlib(index);
  index.upsert(parsed);

  const items = completionItems(
    index,
    doc,
    parsed,
    position,
    dotTriggerContext(),
  );
  const message = items.find((item) => item.label === 'message');

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
  assert.equal(message?.insertText, 'message');
  assert.equal(message?.filterText, 'message');
  assert.equal(
    message?.textEdit && 'range' in message.textEdit
      ? doc.getText(message.textEdit.range)
      : undefined,
    '',
  );
  assert.ok(message);
  assert.equal(
    applyCompletionTextEdit(source, doc, message),
    source.replace('result::err({.});', 'result::err({.message});'),
  );
});

test('completionItems uses open document text for triggered incomplete struct literal', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const markedSource = [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn int main(String[] args)',
    '{',
    '    Result{int, Parse_Error} x=result::err({.|});',
    '}',
    '',
  ].join('\n');
  const source = markedSource.replace('|', '');
  const staleSource = source.replace('{.}', '{}');
  const doc = TextDocument.create(uri, 'c3', 2, source);
  const staleParsed = parseSource(uri, staleSource);

  addResultStdlib(index);
  index.upsert(staleParsed);

  const items = completionItems(
    index,
    doc,
    staleParsed,
    doc.positionAt(markedSource.indexOf('|')),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems applies incomplete struct field completion edits', () => {
  const cases = [
    {
      markedLine: '    Parse_Error err = {.|};',
      completedLine: '    Parse_Error err = {.line};',
      label: 'line',
      stdlib: false,
    },
    {
      markedLine: '    Parse_Error err = {.l|};',
      completedLine: '    Parse_Error err = {.line};',
      label: 'line',
      stdlib: false,
    },
    {
      markedLine: '    Result{int, Parse_Error} x = result::err({.|});',
      completedLine:
        '    Result{int, Parse_Error} x = result::err({.message});',
      label: 'message',
      stdlib: true,
    },
  ];

  for (const testCase of cases) {
    const index = new ProjectIndex();
    const uri = `file:///workspace/${testCase.label}-${testCase.stdlib}.c3`;
    const { source, doc, parsed, position } = completionFixture(uri, [
      'module app;',
      'struct Parse_Error',
      '{',
      '    int line;',
      '    String message;',
      '}',
      'fn int main(String[] args)',
      '{',
      testCase.markedLine,
      '}',
      '',
    ]);

    if (testCase.stdlib) addResultStdlib(index);
    index.upsert(parsed);

    const items = completionItems(index, doc, parsed, position);
    const item = items.find((candidate) => candidate.label === testCase.label);

    assert.ok(item);
    assert.equal(
      applyCompletionTextEdit(source, doc, item),
      source.replace(
        testCase.markedLine.replace('|', ''),
        testCase.completedLine,
      ),
    );
  }
});

test('completionItems replaces an incomplete field prefix without duplicating text', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { source, doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn int main(String[] args)',
    '{',
    '    Result{int, Parse_Error} x = result::err({.l|});',
    '}',
    '',
  ]);

  addResultStdlib(index);
  index.upsert(parsed);

  const items = completionItems(index, doc, parsed, position);
  const line = items.find((item) => item.label === 'line');

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['line', CompletionItemKind.Field, 'int line;']],
  );
  assert.ok(line);
  assert.equal(
    applyCompletionTextEdit(source, doc, line),
    source.replace('result::err({.l});', 'result::err({.line});'),
  );
});

test('completionItems returns semantic fields for manual completion in empty initializer', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct Parse_Error',
    '{',
    '    int line;',
    '    String message;',
    '}',
    'fn int main(String[] args)',
    '{',
    '    Result{int, Parse_Error} x = result::err({|});',
    '}',
    '',
  ]);

  addResultStdlib(index);
  index.upsert(parsed);

  const items = completionItems(index, doc, parsed, position);

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['line', CompletionItemKind.Field, 'int line;'],
      ['message', CompletionItemKind.Field, 'String message;'],
    ],
  );
});

test('completionItems infers fields for any struct-typed call argument', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const { doc, parsed, position } = completionFixture(uri, [
    'module app;',
    'struct User',
    '{',
    '    String name;',
    '    int age;',
    '}',
    'fn void save_user(User user) {}',
    'fn void main()',
    '{',
    '    save_user({.|});',
    '}',
    '',
  ]);

  index.upsert(parsed);

  const items = completionItems(index, doc, parsed, position);

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['age', CompletionItemKind.Field, 'int age;'],
      ['name', CompletionItemKind.Field, 'String name;'],
    ],
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
    doc.positionAt(
      source.indexOf('(*pointer).inner.') + '(*pointer).inner.'.length,
    ),
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

test('completionItems returns visible result module members after namespace qualifier', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const appSource = [
    'module app;',
    'import std::collections::result;',
    'struct Parse_Error {}',
    'fn Result{int, Parse_Error} parse_number(String s)',
    '{',
    '    return result::;',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result {}',
    'fn Result ok(OkType value) { return {}; }',
    'fn Result err(ErrType err) { return {}; }',
    'fn Result hidden() @private { return {}; }',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(resultUri, resultSource, { sourceKind: 'stdlib' }),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('result::') + 'result::'.length),
  );

  assert.equal(
    items.some(
      (item) =>
        item.label === 'ok' &&
        item.kind === CompletionItemKind.Function &&
        item.detail === 'Result ok(OkType value)',
    ),
    true,
  );
  assert.equal(
    items.some(
      (item) =>
        item.label === 'err' &&
        item.kind === CompletionItemKind.Function &&
        item.detail === 'Result err(ErrType err)',
    ),
    true,
  );
  assert.equal(
    items.some((item) => item.label === 'hidden'),
    false,
  );
});

test('completionItems returns stdlib string module members after namespace qualifier', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stringUri = 'file:///stdlib/std/core/string.c3';
  const appSource = [
    'module app;',
    'fn void main()',
    '{',
    '    string::;',
    '}',
    '',
  ].join('\n');
  const stringSource = [
    'module std::core::string;',
    'fn String tformat(String fmt, args...) @format(0) { return ""; }',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(stringUri, stringSource, { sourceKind: 'stdlib' }),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('string::') + 'string::'.length),
  );

  assert.equal(
    items.some(
      (item) =>
        item.label === 'tformat' &&
        item.kind === CompletionItemKind.Function &&
        item.detail === 'String tformat(String fmt, args...) @format(0)',
    ),
    true,
  );
});

test('completionItems returns stdlib result module members after namespace qualifier', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const appSource = [
    'module app;',
    'struct Parse_Error {}',
    'fn Result{int, Parse_Error} parse_number(String s)',
    '{',
    '    return result::;',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result {}',
    'fn Result ok(OkType value) { return {}; }',
    'fn Result err(ErrType err) { return {}; }',
    'fn Result hidden() @private { return {}; }',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(resultUri, resultSource, { sourceKind: 'stdlib' }),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('result::') + 'result::'.length),
  );

  assert.equal(
    items.some(
      (item) =>
        item.label === 'ok' &&
        item.kind === CompletionItemKind.Function &&
        item.detail === 'Result ok(OkType value)',
    ),
    true,
  );
  assert.equal(
    items.some(
      (item) =>
        item.label === 'err' &&
        item.kind === CompletionItemKind.Function &&
        item.detail === 'Result err(ErrType err)',
    ),
    true,
  );
  assert.equal(
    items.some((item) => item.label === 'hidden'),
    false,
  );
});

test('completionItems suggests stdlib module names in expression position', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const stringUri = 'file:///stdlib/std/core/string.c3';
  const appSource = [
    'module app;',
    'fn void main()',
    '{',
    '    stri;',
    '}',
    '',
  ].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource(stringUri, 'module std::core::string;\n', {
      sourceKind: 'stdlib',
    }),
    false,
  );
  index.rebuild();

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('stri') + 'stri'.length),
  );

  assert.equal(
    items.some(
      (item) =>
        item.label === 'string' &&
        item.kind === CompletionItemKind.Module &&
        item.detail === 'module std::core::string',
    ),
    true,
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

test('completionItems completes partial module paths in imports', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = ['module app;', 'import std::n', ''].join('\n');
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

  const position = doc.positionAt(
    appSource.indexOf('std::n') + 'std::n'.length,
  );
  const items = completionItems(index, doc, parsedApp, position);

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail, item.textEdit]),
    [
      [
        'net',
        CompletionItemKind.Module,
        'module std::net',
        {
          range: {
            start: doc.positionAt(appSource.indexOf('std::n') + 'std::'.length),
            end: position,
          },
          newText: 'net',
        },
      ],
    ],
  );
});

test('completionItems completes module paths in alias module targets', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = ['module app;', 'alias net = module std::n', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource('file:///stdlib/std/net.c3', 'module std::net;\n', {
      sourceKind: 'stdlib',
    }),
    false,
  );
  index.rebuild();

  const position = doc.positionAt(
    appSource.indexOf('std::n') + 'std::n'.length,
  );
  const items = completionItems(index, doc, parsedApp, position);

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [['net', CompletionItemKind.Module, 'module std::net']],
  );
});

test('completionItems suggests relative child modules in imports', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const appSource = ['module app;', 'import ', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(
    parseSource('file:///workspace/net.c3', 'module app::net;\n', {
      sourceKind: 'workspace',
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
    doc.positionAt(appSource.indexOf('import ') + 'import '.length),
  );

  assert.deepEqual(
    items.map((item) => [item.label, item.kind, item.detail]),
    [
      ['app', CompletionItemKind.Module, 'module app'],
      ['net', CompletionItemKind.Module, 'module app::net'],
      ['std', CompletionItemKind.Module, 'module std'],
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
    doc.positionAt(
      appSource.indexOf('listener.sock.') + 'listener.sock.'.length,
    ),
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
    doc.positionAt(
      appSource.indexOf('PollSubscribe.R') + 'PollSubscribe.R'.length,
    ),
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
  assert.equal(
    items.some((item) => item.label === 'read'),
    false,
  );
});

test('completionItems includes visible symbols and skips empty-prefix auto imports', () => {
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

  const items = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.length),
  );

  assert.equal(
    items.find((item) => item.label === 'local')?.detail,
    'void local()',
  );
  assert.equal(
    items.find((item) => item.label === 'connect')?.detail,
    'void connect()',
  );
  assert.equal(
    items.some((item) => item.label === 'unrelated'),
    false,
  );
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

test('completionItems suggests auto imports for unimported public symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = ['module app;', 'fn void use() {', '    con', '}', ''].join(
    '\n',
  );
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const item = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('con') + 'con'.length),
  ).find((candidate) => candidate.label === 'connect');

  assert.equal(item?.kind, CompletionItemKind.Function);
  assert.equal(item?.detail, 'void connect() (auto import lib::net)');
  assert.deepEqual(item?.additionalTextEdits, [
    {
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
      newText: 'import lib::net;\n',
    },
  ]);
});

test('completionItems does not auto import private symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = ['module app;', 'fn void use() {', '    hid', '}', ''].join(
    '\n',
  );
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
    doc.positionAt(appSource.indexOf('hid') + 'hid'.length),
  ).map((item) => item.label);

  assert.equal(labels.includes('hidden'), false);
});

test('completionItems does not add import edits for visible symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const netUri = 'file:///workspace/lib/net.c3';
  const appSource = [
    'module app;',
    'import lib::net;',
    'fn void use() {',
    '    con',
    '}',
    '',
  ].join('\n');
  const netSource = ['module lib::net;', 'fn void connect() {}', ''].join('\n');
  const parsedApp = parseSource(appUri, appSource);
  const doc = TextDocument.create(appUri, 'c3', 1, appSource);

  index.upsert(parsedApp, false);
  index.upsert(parseSource(netUri, netSource), false);
  index.rebuild();

  const connectItems = completionItems(
    index,
    doc,
    parsedApp,
    doc.positionAt(appSource.indexOf('con') + 'con'.length),
  ).filter((item) => item.label === 'connect');

  assert.equal(connectItems.length, 1);
  assert.equal(connectItems[0]?.additionalTextEdits, undefined);
});
