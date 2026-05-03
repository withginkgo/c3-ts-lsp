import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import type { InitializeParams } from 'vscode-languageserver/node.js';

import {
  hasLspTransportArg,
  isPathInside,
  resolveStdlibRoots,
  resolveWorkspaceRoot,
} from '../src/server/environment.js';

test('hasLspTransportArg detects supported LSP transports', () => {
  assert.equal(hasLspTransportArg(['--stdio']), true);
  assert.equal(hasLspTransportArg(['--socket=8123']), true);
  assert.equal(hasLspTransportArg(['--pipe', 'c3-lsp']), true);
  assert.equal(hasLspTransportArg(['--help']), false);
});

test('resolveWorkspaceRoot prefers workspace folders over rootUri', () => {
  const workspace = path.join(os.tmpdir(), 'workspace-folder');
  const fallback = path.join(os.tmpdir(), 'root-uri');
  const params = initializeParams({
    rootUri: pathToFileURL(fallback).href,
    workspaceFolders: [
      {
        name: 'workspace-folder',
        uri: pathToFileURL(workspace).href,
      },
    ],
  });

  assert.equal(resolveWorkspaceRoot(params), workspace);
});

test('resolveStdlibRoots normalizes, deduplicates, and filters configured paths', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-env-'));
  const root = path.join(temp, 'workspace');
  const relativeStdlib = path.join(root, 'lib');
  const absoluteStdlib = path.join(temp, 'stdlib');

  fs.mkdirSync(relativeStdlib, { recursive: true });
  fs.mkdirSync(absoluteStdlib, { recursive: true });

  try {
    const params = initializeParams({
      initializationOptions: {
        stdlibPaths: ['lib', absoluteStdlib, absoluteStdlib, 'missing', root],
      },
    });

    const roots = withCleanStdlibEnvironment(() =>
      resolveStdlibRoots(params, root),
    );

    assert.deepEqual(roots, [relativeStdlib, absoluteStdlib]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolveStdlibRoots accepts C3C_LIB from the compiler environment', () => {
  const stdlib = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-stdlib-'));

  try {
    const roots = withCleanStdlibEnvironment(() => {
      process.env.C3C_LIB = stdlib;
      return resolveStdlibRoots(initializeParams({}), null);
    });

    assert.deepEqual(roots, [stdlib]);
  } finally {
    fs.rmSync(stdlib, { recursive: true, force: true });
  }
});

test('resolveStdlibRoots discovers nested c3c lib folders in the workspace', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-env-'));
  const root = path.join(temp, 'workspace');
  const stdlib = path.join(root, 'c3c', 'lib');
  const resultFile = path.join(stdlib, 'std', 'collections', 'result.c3');

  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, 'module std::collections::result;\n');

  try {
    const roots = withCleanStdlibEnvironment(() =>
      resolveStdlibRoots(initializeParams({}), root),
    );

    assert.deepEqual(roots, [stdlib]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('resolveStdlibRoots derives stdlib roots from configured c3c paths', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-lsp-env-'));
  const install = path.join(temp, 'c3');
  const c3c = path.join(install, 'build', 'bin', 'c3c');
  const stdlib = path.join(install, 'lib');
  const resultFile = path.join(stdlib, 'std', 'collections', 'result.c3');

  fs.mkdirSync(path.dirname(c3c), { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(c3c, '');
  fs.writeFileSync(resultFile, 'module std::collections::result;\n');

  try {
    const roots = withCleanStdlibEnvironment(() =>
      resolveStdlibRoots(
        initializeParams({
          initializationOptions: {
            c3cPath: c3c,
          },
        }),
        null,
      ),
    );

    assert.deepEqual(roots, [stdlib]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('isPathInside treats the parent itself as inside', () => {
  assert.equal(isPathInside('/tmp/project/src/main.c3', '/tmp/project'), true);
  assert.equal(isPathInside('/tmp/project', '/tmp/project'), true);
  assert.equal(
    isPathInside('/tmp/project-other/main.c3', '/tmp/project'),
    false,
  );
});

function initializeParams(
  overrides: Partial<InitializeParams>,
): InitializeParams {
  return {
    processId: null,
    rootUri: null,
    capabilities: {},
    ...overrides,
  } as InitializeParams;
}

function withCleanStdlibEnvironment<T>(callback: () => T): T {
  const names = [
    'C3_STDLIB_PATH',
    'C3_STDLIB_ROOT',
    'C3_STANDARD_LIBRARY_PATH',
    'C3C_LIB',
    'C3_HOME',
    'C3C_HOME',
  ];
  const previous = new Map<string, string | undefined>();

  for (const name of names) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }

  try {
    return callback();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value == null) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
