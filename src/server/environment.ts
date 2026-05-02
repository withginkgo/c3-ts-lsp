import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InitializeParams } from 'vscode-languageserver/node.js';

export type ServerReporter = {
  error(message: string): void;
};

export function hasLspTransportArg(args = process.argv.slice(2)): boolean {
  return args.some((arg) => {
    return (
      arg === '--node-ipc' ||
      arg === '--stdio' ||
      arg === '--socket' ||
      arg.startsWith('--socket=') ||
      arg === '--pipe' ||
      arg.startsWith('--pipe=')
    );
  });
}

export function resolveWorkspaceRoot(
  params: InitializeParams,
  reporter?: ServerReporter,
): string | null {
  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? null;
  if (!rootUri) return null;

  try {
    return fileURLToPath(rootUri);
  } catch (err) {
    reporter?.error(`invalid workspace root ${rootUri}: ${String(err)}`);
    return null;
  }
}

export function resolveStdlibRoots(
  params: InitializeParams,
  root: string | null,
): string[] {
  const configured = [
    ...stdlibPathsFromInitializationOptions(params.initializationOptions),
    ...stdlibPathsFromEnvironment(),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const configuredPath of configured) {
    const resolved = normalizeConfiguredPath(configuredPath, root);

    if (
      !resolved ||
      resolved === root ||
      seen.has(resolved) ||
      !isDirectory(resolved)
    ) {
      continue;
    }

    seen.add(resolved);
    roots.push(resolved);
  }

  return roots;
}

export function filePathFromUri(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function stdlibPathsFromInitializationOptions(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];

  const record = options as Record<string, unknown>;
  const values = [
    record.stdlibPath,
    record.stdlibPaths,
    record.standardLibraryPath,
    record.standardLibraryPaths,
    record.c3StdlibPath,
    record.c3StdlibPaths,
    // 适配 C3 Language Support 插件实际传的 key
    record['stdlib-path'],
    record['c3.stdlib-path'], // 插件用这个
    record['c3.stdlibPath'], // 可能有的拼法
    record['c3.standardLibraryPath'], // 极端情况
  ];

  return values.flatMap(configuredPathValues);
}

function stdlibPathsFromEnvironment(): string[] {
  const direct = [
    process.env.C3_STDLIB_PATH,
    process.env.C3_STDLIB_ROOT,
    process.env.C3_STANDARD_LIBRARY_PATH,
    process.env.C3C_LIB,
  ].flatMap(configuredPathValues);
  const homes = [process.env.C3_HOME, process.env.C3C_HOME]
    .flatMap(configuredPathValues)
    .flatMap((home) => [
      path.join(home, 'lib'),
      path.join(home, 'lib', 'std'),
      path.join(home, 'stdlib'),
    ]);

  return [...direct, ...homes];
}

function configuredPathValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.flatMap(configuredPathValues);
  }

  return [];
}

function normalizeConfiguredPath(
  configuredPath: string,
  root: string | null,
): string | null {
  const expanded =
    configuredPath === '~' || configuredPath.startsWith(`~${path.sep}`)
      ? path.join(process.env.HOME ?? '', configuredPath.slice(1))
      : configuredPath;

  if (!expanded) return null;

  return path.resolve(
    path.isAbsolute(expanded) || !root ? expanded : path.join(root, expanded),
  );
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
