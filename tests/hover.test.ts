import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hover } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { contractDefinition, contractHover } from '../src/lsp/contracts.js';
import { referenceAtPosition } from '../src/lsp/document-refs.js';
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

test('hover explains reflected member descriptor fields and tag helpers', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/reflection.c3';
  const source = [
    'macro print_json_fields($Type){',
    '    $foreach $field : $Type::members:',
    '        $if $field.has_tag("json_skip"):',
    '        $else',
    '            $if $field.has_tag("json_name"):',
    '                $echo $field.get_tag("json_name");',
    '            $else',
    '                $echo $field.name;',
    '            $endif',
    '        $endif',
    '    $endforeach',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);

  index.upsert(parsed);

  const namePosition = doc.positionAt(source.indexOf('name;'));
  const hasTagPosition = doc.positionAt(source.indexOf('has_tag("json_skip")'));
  const getTagPosition = doc.positionAt(source.indexOf('get_tag("json_name")'));

  const nameHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, 'name', namePosition),
    { currentUri: uri, position: namePosition },
  );
  const hasTagHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, 'has_tag', hasTagPosition),
    { currentUri: uri, position: hasTagPosition },
  );
  const getTagHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, 'get_tag', getTagPosition),
    { currentUri: uri, position: getTagPosition },
  );

  assert.match(hoverValue(nameHover), /compile-time name/);
  assert.match(hoverValue(hasTagHover), /tag named `json_skip`/);
  assert.match(hoverValue(getTagHover), /tag value associated with `json_name`/);
});

test('hover explains compile-time eval field selectors', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/encode.c3';
  const source = [
    'fn void write_field(String name, any value) {}',
    'macro void @encode_json($Type, $Type* obj)',
    '{',
    '    $foreach $member : $Type::members:',
    '        write_field($member.name, obj.$eval($member.name));',
    '    $endforeach',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);
  const parsed = parseSource(uri, source);
  const position = doc.positionAt(source.indexOf('$eval') + '$'.length);
  const ref = referenceAtPosition(doc, position);

  index.upsert(parsed);

  assert.ok(ref);
  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbol(uri, ref.text, position),
    { currentUri: uri, position },
  );
  const value = hoverValue(hover);

  assert.match(value, /\$eval/);
  assert.match(value, /dynamic field\/member selector/);
});

test('hover shows substituted types for promoted anonymous union fields', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const source = [
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
    '    x.error;',
    '    x.value;',
    '    x.is_ok;',
    '}',
    '',
  ].join('\n');
  const doc = TextDocument.create(uri, 'c3', 1, source);

  index.upsert(parseSource(uri, source));

  const errorHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'error',
      doc.positionAt(source.indexOf('x.error') + 'x.'.length),
    ),
  );
  const valueHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'value',
      doc.positionAt(source.indexOf('x.value') + 'x.'.length),
    ),
  );
  const isOkHover = hoverFromResolveResult(
    index,
    index.resolveSymbol(
      uri,
      'is_ok',
      doc.positionAt(source.indexOf('x.is_ok') + 'x.'.length),
    ),
  );

  assert.match(hoverValue(errorHover), /Student error;/);
  assert.match(hoverValue(valueHover), /int value;/);
  assert.match(hoverValue(isOkHover), /bool is_ok;/);
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

test('hover resolves qualified module path segments independently', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const source = [
    'module app;',
    'import std::collections::result;',
    'struct Parse_Error {}',
    'fn void use() {',
    '    Result{int, Parse_Error} test = result::err(1);',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result(Printable) {',
    '    bool is_ok;',
    '}',
    'fn Result err(ErrType err) { return {}; }',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source), false);
  index.upsert(
    parseSource(resultUri, resultSource, { sourceKind: 'stdlib' }),
    false,
  );
  index.rebuild();

  const resultPosition = doc.positionAt(source.indexOf('result::err') + 1);
  const ref = referenceAtPosition(doc, resultPosition);
  assert.ok(ref);

  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbolAtReferenceSegment(
      appUri,
      ref.text,
      ref.segmentIndex,
      resultPosition,
    ),
  );
  const value = hoverValue(hover);

  assert.match(value, /module std::collections::result <OkType, ErrType>/);
  assert.doesNotMatch(value, /Result err/);
});

test('hover shows instantiated function type for qualified module members', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const resultUri = 'file:///stdlib/std/collections/result.c3';
  const source = [
    'module app;',
    'import std::collections::result;',
    'struct Parse_Error {}',
    'fn void use() {',
    '    Result{int, Parse_Error} test = result::err(1);',
    '}',
    '',
  ].join('\n');
  const resultSource = [
    'module std::collections::result <OkType, ErrType>;',
    'struct Result(Printable) {',
    '    bool is_ok;',
    '}',
    'fn Result err(ErrType err) { return {}; }',
    '',
  ].join('\n');
  const doc = TextDocument.create(appUri, 'c3', 1, source);

  index.upsert(parseSource(appUri, source), false);
  index.upsert(
    parseSource(resultUri, resultSource, { sourceKind: 'stdlib' }),
    false,
  );
  index.rebuild();

  const errPosition = doc.positionAt(source.indexOf('err(1)') + 1);
  const ref = referenceAtPosition(doc, errPosition);
  assert.ok(ref);

  const hover = hoverFromResolveResult(
    index,
    index.resolveSymbolAtReferenceSegment(
      appUri,
      ref.text,
      ref.segmentIndex,
      errPosition,
    ),
    { currentUri: appUri, position: errPosition },
  );
  const value = hoverValue(hover);

  assert.match(
    value,
    /fn err\(Parse_Error err\) -> Result\{int, Parse_Error\}/,
  );
  assert.doesNotMatch(value, /type:/);
  assert.doesNotMatch(value, /struct Result\(Printable\)/);
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
