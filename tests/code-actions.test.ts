import assert from 'node:assert/strict';
import { test } from 'node:test';

import { semanticDiagnostics } from '../src/analysis/diagnostics.js';
import { codeActions } from '../src/lsp/code-actions.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('codeActions suggests imports for unresolved symbols', () => {
  const index = new ProjectIndex();
  const appUri = 'file:///workspace/app.c3';
  const app = parseSource(
    appUri,
    [
      'module app;',
      'fn void use() {',
      '    connect();',
      '}',
      '',
    ].join('\n'),
  );

  index.upsert(app, false);
  index.upsert(
    parseSource(
      'file:///workspace/lib/net.c3',
      'module lib::net;\nfn void connect() {}\n',
    ),
    false,
  );
  index.rebuild();

  const diagnostics = semanticDiagnostics(index, app);
  const actions = codeActions(index, app, {
    textDocument: { uri: appUri },
    range: diagnostics[0]!.range,
    context: { diagnostics },
  });

  assert.deepEqual(
    actions.map((action) => [
      action.title,
      action.kind,
      action.edit?.changes?.[appUri]?.[0],
    ]),
    [
      [
        'Import lib::net',
        'quickfix',
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 0 },
          },
          newText: 'import lib::net;\n',
        },
      ],
    ],
  );
});

test('codeActions can remove unresolved imports', () => {
  const index = new ProjectIndex();
  const uri = 'file:///workspace/app.c3';
  const parsed = parseSource(
    uri,
    ['module app;', 'import missing::net;', 'fn void use() {}', ''].join('\n'),
  );

  index.upsert(parsed);

  const diagnostics = semanticDiagnostics(index, parsed);
  const actions = codeActions(index, parsed, {
    textDocument: { uri },
    range: diagnostics[0]!.range,
    context: { diagnostics },
  });

  assert.deepEqual(actions[0]?.edit?.changes?.[uri]?.[0], {
    range: {
      start: { line: 1, character: 0 },
      end: { line: 2, character: 0 },
    },
    newText: '',
  });
});
