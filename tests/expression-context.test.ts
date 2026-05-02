import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expectedTypeForExpression } from '../src/analysis/expression-context.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('expectedTypeForExpression infers generic call argument type from expected return type', () => {
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
      'fn Result{int, Parse_Error} parse_number(String s) {',
      '    Result{int, Parse_Error} x = result::err({.line = 1, .message = "bad"});',
      '    return x;',
      '}',
      '',
    ].join('\n'),
  );
  const result = parseSource(
    'file:///stdlib/std/collections/result.c3',
    [
      'module std::collections::result <OkType, ErrType>;',
      'struct Result {}',
      'fn Result err(ErrType err) { return {}; }',
      '',
    ].join('\n'),
    { sourceKind: 'stdlib' },
  );

  index.upsert(app, false);
  index.upsert(result, false);
  index.rebuild();

  const initializer = app.tree.rootNode
    .descendantsOfType('initializer_list')
    .find((node) => node.text.startsWith('{.line'));

  assert.ok(initializer);
  assert.equal(
    expectedTypeForExpression(index, app, initializer),
    'Parse_Error',
  );
});
