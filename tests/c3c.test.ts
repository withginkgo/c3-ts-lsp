import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DiagnosticSeverity } from 'vscode-languageserver/node.js';

import {
  compilerDiagnosticArgs,
  parseCompilerDiagnostics,
  resolveCompilerCommand,
  type C3CompilerCommand,
} from '../src/toolchain/c3c.js';

test('resolveCompilerCommand is opt-in and accepts configured command arrays', () => {
  assert.equal(resolveCompilerCommand({}, { PATH: '' }), null);

  const command = resolveCompilerCommand(
    {
      compilerDiagnostics: true,
      c3cCommand: ['/opt/c3c/bin/c3c', '--target', 'x64-linux'],
      compilerTimeoutMs: 1234,
    },
    { PATH: '' },
  );

  assert.deepEqual(command, {
    command: '/opt/c3c/bin/c3c',
    args: ['--target', 'x64-linux'],
    checkArgs: undefined,
    timeoutMs: 1234,
  });
});

test('compilerDiagnosticArgs builds project and file check commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-'));
  const compiler: C3CompilerCommand = {
    command: 'c3c',
    args: [],
    timeoutMs: 1000,
  };

  try {
    assert.deepEqual(
      compilerDiagnosticArgs(compiler, {
        workspaceRoot: root,
        files: [path.join(root, 'src', 'main.c3')],
        stdlibRoots: ['/opt/c3/lib/std'],
      }),
      [
        '--lsp',
        '--ansi=no',
        '-C',
        '--stdlib',
        '/opt/c3/lib/std',
        'compile-only',
        path.join(root, 'src', 'main.c3'),
      ],
    );

    fs.writeFileSync(path.join(root, 'project.json'), '{}');

    assert.deepEqual(
      compilerDiagnosticArgs(compiler, {
        workspaceRoot: root,
        files: [path.join(root, 'src', 'main.c3')],
      }),
      ['--lsp', '--ansi=no', '-C', '--path', root, 'build'],
    );

    assert.deepEqual(
      compilerDiagnosticArgs(compiler, {
        workspaceRoot: root,
        files: [path.join(root, 'src', 'main.c3')],
        projectTarget: 'demo',
      }),
      ['--lsp', '--ansi=no', '-C', '--path', root, 'build', 'demo'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compilerDiagnosticArgs supports explicit check arg templates', () => {
  const compiler: C3CompilerCommand = {
    command: 'c3c',
    args: [],
    checkArgs: [
      '--lsp',
      '--path',
      '${workspaceRoot}',
      'compile-only',
      '${files}',
      '${projectTarget}',
    ],
    timeoutMs: 1000,
  };

  assert.deepEqual(
    compilerDiagnosticArgs(compiler, {
      workspaceRoot: '/workspace',
      files: ['/workspace/a.c3', '/workspace/b.c3'],
      projectTarget: 'app',
    }),
    [
      '--lsp',
      '--path',
      '/workspace',
      'compile-only',
      '/workspace/a.c3',
      '/workspace/b.c3',
      'app',
    ],
  );
});

test('parseCompilerDiagnostics reads c3c LSP and conventional output', () => {
  const cwd = path.resolve('/workspace');
  const c3File = path.join(cwd, 'src', 'main.c3');
  const escapedPath = c3File.replaceAll('\\', '\\\\');
  const output = [
    `> LSPERR|error|"${escapedPath}"|3|9|"Cannot find symbol \\\"Foo\\\"\\x7c retry"`,
    `> LSPERR|warn|"${escapedPath}"|4|1|"Deprecated\\ncall"`,
    `(${path.join(cwd, 'src', 'other.c3')}:5:2) Note: Related detail`,
    '',
  ].join('\n');

  const diagnostics = parseCompilerDiagnostics(output, cwd);

  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0]?.uri, pathToFileURL(c3File).toString());
  assert.deepEqual(diagnostics[0]?.diagnostic, {
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line: 2, character: 8 },
      end: { line: 2, character: 9 },
    },
    message: 'Cannot find symbol "Foo"| retry',
    source: 'c3c',
  });
  assert.equal(diagnostics[1]?.diagnostic.severity, DiagnosticSeverity.Warning);
  assert.equal(diagnostics[1]?.diagnostic.message, 'Deprecated\ncall');
  assert.equal(
    diagnostics[2]?.uri,
    pathToFileURL(path.join(cwd, 'src', 'other.c3')).toString(),
  );
  assert.equal(
    diagnostics[2]?.diagnostic.severity,
    DiagnosticSeverity.Information,
  );
});

test('parseCompilerDiagnostics accepts real c3c --lsp output when c3c is installed', (t) => {
  const found = spawnSync('c3c', ['--version'], { encoding: 'utf8' });
  if (found.status !== 0) {
    t.skip('c3c is not available on PATH');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-real-'));
  const file = path.join(root, 'bad.c3');

  try {
    fs.writeFileSync(
      file,
      [
        'module lsp_probe;',
        'fn void probe() {',
        '    missing_symbol();',
        '}',
        '',
      ].join('\n'),
    );

    const result = spawnSync(
      'c3c',
      ['--lsp', '--ansi=no', '-C', 'compile-only', file],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    const diagnostics = parseCompilerDiagnostics(
      `${result.stdout}\n${result.stderr}`,
      root,
    );

    assert.ok(
      diagnostics.some(
        (item) =>
          item.uri === pathToFileURL(file).toString() &&
          item.diagnostic.source === 'c3c' &&
          item.diagnostic.message.includes('missing_symbol'),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
