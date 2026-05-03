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
    ...stdlibPathsFromCompilerConfiguration(params.initializationOptions, root),
    ...stdlibPathsFromWorkspace(root),
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

function stdlibPathsFromCompilerConfiguration(
  options: unknown,
  root: string | null,
): string[] {
  const command = compilerCommandFromInitializationOptions(options);
  if (!command || !/[\\/]/.test(command)) return [];

  const resolved = normalizeConfiguredPath(command, root);
  if (!resolved) return [];

  return stdlibRootsNearPath(resolved);
}

function stdlibPathsFromWorkspace(root: string | null): string[] {
  if (!root) return [];

  return [
    root,
    path.join(root, 'lib'),
    path.join(root, 'c3c', 'lib'),
    path.join(root, 'vendor', 'c3c', 'lib'),
    path.join(root, 'third_party', 'c3c', 'lib'),
    path.join(root, 'deps', 'c3c', 'lib'),
  ].filter(isLikelyStdlibRoot);
}

function compilerCommandFromInitializationOptions(
  options: unknown,
): string | undefined {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  return commandFromConfiguredValue(
    record.compilerCommand ??
      record.compilerPath ??
      record.c3CompilerCommand ??
      record.c3CompilerPath ??
      record.c3cCommand ??
      record.c3cPath ??
      record['c3.compilerCommand'] ??
      record['c3.compilerPath'] ??
      record['c3.c3cCommand'] ??
      record['c3.c3cPath'],
  );
}

function commandFromConfiguredValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === 'string'
  ) {
    return value[0].trim() || undefined;
  }

  if (value && typeof value === 'object') {
    const command = (value as Record<string, unknown>).command;
    return typeof command === 'string' ? command.trim() || undefined : undefined;
  }

  return undefined;
}

function stdlibRootsNearPath(filePath: string): string[] {
  const roots: string[] = [];
  let current = isDirectory(filePath) ? filePath : path.dirname(filePath);

  for (let depth = 0; depth < 8; depth++) {
    const installedLib = path.join(current, 'lib');

    if (isLikelyStdlibRoot(installedLib)) roots.push(installedLib);
    if (isLikelyStdlibRoot(current)) roots.push(current);

    const parent = path.dirname(current);
    if (parent === current) break;

    current = parent;
  }

  return roots;
}

function isLikelyStdlibRoot(root: string): boolean {
  return (
    fileExists(path.join(root, 'std', 'collections', 'result.c3')) ||
    fileExists(path.join(root, 'std', 'core', 'builtin.c3')) ||
    fileExists(path.join(root, 'collections', 'result.c3')) ||
    fileExists(path.join(root, 'core', 'builtin.c3'))
  );
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

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
