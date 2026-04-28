import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DiagnosticSeverity,
  Range,
  type Diagnostic,
} from 'vscode-languageserver/node.js';

export type C3CompilerCommand = {
  command: string;
  args: string[];
  checkArgs?: string[];
  timeoutMs: number;
};

export type CompilerDiagnosticRequest = {
  workspaceRoot: string;
  files: string[];
  stdlibRoots?: string[];
  projectTarget?: string;
};

export type ParsedCompilerDiagnostic = {
  uri: string;
  diagnostic: Diagnostic;
};

const defaultCompilerTimeoutMs = 10_000;
const maxCompilerOutputBytes = 4 * 1024 * 1024;

export function resolveCompilerCommand(
  options: unknown,
  env: NodeJS.ProcessEnv = process.env,
): C3CompilerCommand | null {
  if (!compilerDiagnosticsEnabled(options)) return null;

  const configured =
    configuredCompiler(options) ?? compilerFromEnvironment(env);
  const normalized = normalizeCompilerCommand(configured);
  const command = normalized ?? findExecutable('c3c', env);
  if (!command) return null;

  return {
    command: command.command,
    args: command.args,
    checkArgs: configuredCheckArgs(options),
    timeoutMs: configuredTimeoutMs(options) ?? defaultCompilerTimeoutMs,
  };
}

export function compilerDiagnosticArgs(
  compiler: C3CompilerCommand,
  request: CompilerDiagnosticRequest,
): string[] {
  if (compiler.checkArgs) {
    return compiler.checkArgs.flatMap((arg) => expandCheckArg(arg, request));
  }

  const args = [...compiler.args];

  pushAbsent(args, '--lsp');
  pushAbsent(
    args,
    '--ansi=no',
    (arg) => arg === '--ansi' || arg.startsWith('--ansi='),
  );
  pushAbsent(args, '-C');

  const stdlibRoot = request.stdlibRoots?.[0];
  if (stdlibRoot && !hasOption(args, '--stdlib')) {
    args.push('--stdlib', stdlibRoot);
  }

  const projectRoot = projectRootForDiagnostics(request.workspaceRoot);
  if (projectRoot) {
    if (!hasOption(args, '--path')) {
      args.push('--path', projectRoot);
    }
    args.push('build');
    if (request.projectTarget) {
      args.push(request.projectTarget);
    }
    return args;
  }

  args.push('compile-only', ...request.files);
  return args;
}

export async function runCompilerDiagnostics(
  compiler: C3CompilerCommand,
  request: CompilerDiagnosticRequest,
): Promise<Map<string, Diagnostic[]>> {
  const args = compilerDiagnosticArgs(compiler, request);
  const output = await runCompiler(compiler, args, request.workspaceRoot);
  return groupDiagnostics(
    parseCompilerDiagnostics(output, request.workspaceRoot),
  );
}

export function parseCompilerDiagnostics(
  output: string,
  cwd = process.cwd(),
): ParsedCompilerDiagnostic[] {
  const diagnostics: ParsedCompilerDiagnostic[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const lsp = parseLspDiagnosticLine(line, cwd);
    if (lsp) {
      diagnostics.push(lsp);
      continue;
    }

    const conventional = parseConventionalDiagnosticLine(line, cwd);
    if (conventional) diagnostics.push(conventional);
  }

  return diagnostics;
}

function compilerDiagnosticsEnabled(options: unknown): boolean {
  if (!options || typeof options !== 'object') return false;

  const record = options as Record<string, unknown>;
  const value =
    record.compilerDiagnostics ??
    record.enableCompilerDiagnostics ??
    record.c3CompilerDiagnostics ??
    record['c3.compilerDiagnostics'] ??
    record['c3.enableCompilerDiagnostics'];

  return value === true;
}

function configuredCompiler(options: unknown): unknown {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  return (
    record.compilerCommand ??
    record.compilerPath ??
    record.c3CompilerCommand ??
    record.c3CompilerPath ??
    record.c3cCommand ??
    record.c3cPath ??
    record['c3.compilerCommand'] ??
    record['c3.compilerPath'] ??
    record['c3.c3cCommand'] ??
    record['c3.c3cPath']
  );
}

function configuredCheckArgs(options: unknown): string[] | undefined {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  const value =
    record.compilerCheckArgs ??
    record.c3CompilerCheckArgs ??
    record.c3cCheckArgs ??
    record['c3.compilerCheckArgs'] ??
    record['c3.c3cCheckArgs'];

  return Array.isArray(value) && value.every((arg) => typeof arg === 'string')
    ? [...value]
    : undefined;
}

function configuredTimeoutMs(options: unknown): number | undefined {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  const value =
    record.compilerTimeoutMs ??
    record.c3CompilerTimeoutMs ??
    record['c3.compilerTimeoutMs'];

  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function compilerFromEnvironment(env: NodeJS.ProcessEnv): unknown {
  return env.C3C ?? env.C3C_PATH ?? env.C3_COMPILER ?? env.C3_COMPILER_PATH;
}

function normalizeCompilerCommand(
  configured: unknown,
): Pick<C3CompilerCommand, 'command' | 'args'> | null {
  if (typeof configured === 'string' && configured.trim()) {
    return { command: configured.trim(), args: [] };
  }

  if (
    Array.isArray(configured) &&
    configured.every((part) => typeof part === 'string')
  ) {
    const [command, ...args] = configured;
    return command ? { command, args } : null;
  }

  if (configured && typeof configured === 'object') {
    const record = configured as Record<string, unknown>;
    const command = record.command;
    const args = record.args;

    if (
      typeof command === 'string' &&
      (!args ||
        (Array.isArray(args) && args.every((arg) => typeof arg === 'string')))
    ) {
      return {
        command,
        args: Array.isArray(args) ? args : [],
      };
    }
  }

  return null;
}

function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
): Pick<C3CompilerCommand, 'command' | 'args'> | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;

  for (const dir of pathValue.split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return { command: candidate, args: [] };
  }

  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandCheckArg(
  arg: string,
  request: CompilerDiagnosticRequest,
): string[] {
  if (arg === '${files}') return request.files;

  return [
    arg
      .replaceAll('${workspaceRoot}', request.workspaceRoot)
      .replaceAll('${stdlibRoot}', request.stdlibRoots?.[0] ?? '')
      .replaceAll('${projectTarget}', request.projectTarget ?? ''),
  ];
}

function projectRootForDiagnostics(workspaceRoot: string): string | null {
  return fs.existsSync(path.join(workspaceRoot, 'project.json'))
    ? workspaceRoot
    : null;
}

function pushAbsent(
  args: string[],
  value: string,
  predicate: (arg: string) => boolean = (arg) => arg === value,
): void {
  if (!args.some(predicate)) args.push(value);
}

function hasOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function runCompiler(
  compiler: C3CompilerCommand,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(compiler.command, args, {
      cwd,
      env: {
        ...process.env,
        CLICOLOR: '0',
        NO_COLOR: '1',
      },
    });
    let output = '';
    let finished = false;

    const timeout = setTimeout(() => {
      finished = true;
      child.kill();
      reject(
        new Error(`c3c diagnostics timed out after ${compiler.timeoutMs}ms`),
      );
    }, compiler.timeoutMs);

    const appendOutput = (chunk: Buffer): void => {
      if (output.length >= maxCompilerOutputBytes) return;

      output += chunk
        .toString('utf8')
        .slice(0, maxCompilerOutputBytes - output.length);
    };

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        reject(err);
      }
    });
    child.on('close', () => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        resolve(output);
      }
    });
  });
}

function parseLspDiagnosticLine(
  line: string,
  cwd: string,
): ParsedCompilerDiagnostic | null {
  const marker = '> LSPERR|';
  if (!line.startsWith(marker)) return null;

  const parts = splitPipeRecord(line.slice(marker.length));
  if (parts.length < 5) return null;

  const [kind, filePart, rowPart, colPart, messagePart] = parts;
  const row = Number.parseInt(rowPart, 10);
  const col = Number.parseInt(colPart, 10);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;

  return compilerDiagnostic(
    unquoteCompilerString(filePart),
    row,
    col,
    severityForCompilerKind(kind),
    unquoteCompilerString(messagePart),
    cwd,
  );
}

function parseConventionalDiagnosticLine(
  line: string,
  cwd: string,
): ParsedCompilerDiagnostic | null {
  const match = line.match(
    /^\((.+?):(\d+)(?::(\d+))?\)\s+(Error|Warning|Note):\s+(.*)$/i,
  );
  if (!match) return null;

  return compilerDiagnostic(
    match[1],
    Number.parseInt(match[2], 10),
    match[3] ? Number.parseInt(match[3], 10) : 1,
    severityForCompilerKind(match[4].toLowerCase()),
    stripAnsi(match[5]),
    cwd,
  );
}

function compilerDiagnostic(
  file: string,
  row: number,
  col: number,
  severity: DiagnosticSeverity,
  message: string,
  cwd: string,
): ParsedCompilerDiagnostic {
  const line = Math.max(0, row - 1);
  const character = Math.max(0, col - 1);

  return {
    uri: uriForCompilerPath(file, cwd),
    diagnostic: {
      severity,
      range: Range.create(line, character, line, character + 1),
      message,
      source: 'c3c',
    },
  };
}

function splitPipeRecord(record: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let escaped = false;

  for (const char of record) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && inQuote) {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === '|' && !inQuote) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function unquoteCompilerString(value: string): string {
  const text =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

  return text
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function severityForCompilerKind(kind: string): DiagnosticSeverity {
  switch (kind.toLowerCase()) {
    case 'warn':
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'note':
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Error;
  }
}

function uriForCompilerPath(file: string, cwd: string): string {
  const normalized = stripAnsi(file);
  const filePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(cwd, normalized);

  return pathToFileURL(filePath).toString();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function groupDiagnostics(
  parsed: ParsedCompilerDiagnostic[],
): Map<string, Diagnostic[]> {
  const grouped = new Map<string, Diagnostic[]>();

  for (const item of parsed) {
    const diagnostics = grouped.get(item.uri) ?? [];
    diagnostics.push(item.diagnostic);
    grouped.set(item.uri, diagnostics);
  }

  return grouped;
}
