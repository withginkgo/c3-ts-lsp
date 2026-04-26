import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SymbolKind } from 'vscode-languageserver/node.js';

import { workspaceSymbols } from '../src/lsp/workspace-symbols.js';
import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';

test('workspaceSymbols returns matching symbols across workspace files', () => {
  const index = new ProjectIndex();

  index.upsert(
    parseSource(
      'file:///workspace/app.c3',
      ['module app;', 'struct HttpResponse {', '    String body;', '}', ''].join('\n'),
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///workspace/lib/net.c3',
      ['module lib::net;', 'fn void connect() {}', ''].join('\n'),
    ),
    false,
  );
  index.upsert(
    parseSource(
      'file:///stdlib/std/io.c3',
      ['module std::io;', 'fn void connect() {}', ''].join('\n'),
      { sourceKind: 'stdlib' },
    ),
    false,
  );
  index.rebuild();

  const symbols = workspaceSymbols(index, { query: 'connect' });

  assert.deepEqual(
    symbols.map((symbol) => [
      symbol.name,
      symbol.kind,
      symbol.containerName,
      symbol.location.uri,
    ]),
    [
      [
        'connect',
        SymbolKind.Function,
        'lib::net',
        'file:///workspace/lib/net.c3',
      ],
    ],
  );
});

test('workspaceSymbols includes nested members when queried directly', () => {
  const index = new ProjectIndex();

  index.upsert(
    parseSource(
      'file:///workspace/app.c3',
      ['module app;', 'struct HttpResponse {', '    String body;', '}', ''].join('\n'),
    ),
  );

  const symbols = workspaceSymbols(index, { query: 'body' });

  assert.equal(symbols[0]?.name, 'body');
  assert.equal(symbols[0]?.kind, SymbolKind.Field);
  assert.equal(symbols[0]?.containerName, 'app');
});
