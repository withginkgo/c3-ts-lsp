import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompletionItemKind } from 'vscode-languageserver/node.js';

import { completionItems } from '../src/lsp/completions.js';
import { ProjectIndex } from '../src/project/project-index.js';
import { C3_KEYWORDS } from '../src/shared/language-data.js';

test('completionItems includes current grammar keywords and builtins', () => {
  const items = completionItems(new ProjectIndex(), undefined, undefined, {
    line: 0,
    character: 0,
  });
  const byLabel = new Map(items.map((item) => [item.label, item]));

  for (const keyword of [
    'alias',
    'attrdef',
    'bfloat',
    'constdef',
    'faultdef',
    'lengthof',
    'sz',
    'untypedlist',
    'var',
  ]) {
    assert.equal(byLabel.get(keyword)?.kind, CompletionItemKind.Keyword);
  }

  assert.equal(byLabel.get('@builtin')?.kind, CompletionItemKind.Property);
  assert.equal(byLabel.get('$$FILE')?.kind, CompletionItemKind.Constant);
  assert.equal(byLabel.get('$if')?.kind, CompletionItemKind.Function);
  assert.equal((C3_KEYWORDS as readonly string[]).includes('def'), false);
  assert.equal((C3_KEYWORDS as readonly string[]).includes('scope'), false);
});
