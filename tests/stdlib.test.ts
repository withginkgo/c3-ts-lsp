import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { parseSource } from '../src/parser/c3-parser.js';
import { ProjectIndex } from '../src/project/project-index.js';
import { scanWorkspace } from '../src/workspace/scan.js';

test('scanWorkspace can index stdlib roots for imported module resolution', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c3-stdlib-'));

  try {
    const stdlibFile = path.join(root, 'std', 'io.c3');
    const stdlibUri = pathToFileURL(stdlibFile).toString();
    const appUri = 'file:///workspace/app.c3';
    const appSource = [
      'module app;',
      'import std::io;',
      'fn void use() {',
      '    print("hello");',
      '}',
      '',
    ].join('\n');
    const appDoc = TextDocument.create(appUri, 'c3', 1, appSource);
    const index = new ProjectIndex();

    mkdirSync(path.dirname(stdlibFile), { recursive: true });
    writeFileSync(
      stdlibFile,
      ['module std::io;', 'fn void print(String value) {}', ''].join('\n'),
    );

    scanWorkspace(root, index, {}, { rebuild: false, sourceKind: 'stdlib' });
    index.upsert(parseSource(appUri, appSource), false);
    index.rebuild();

    const result = index.resolveSymbol(
      appUri,
      'print',
      appDoc.positionAt(appSource.indexOf('print')),
    );

    assert.equal(index.getParsed(stdlibUri)?.sourceKind, 'stdlib');
    assert.equal(result.reason, 'resolved');
    assert.equal(result.selected?.uri, stdlibUri);
    assert.equal(result.selected?.signature, 'void print(String value)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
