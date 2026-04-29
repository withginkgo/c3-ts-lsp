import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Position, Range, TextEdit } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export type FormatterCommand = {
  command: string;
  args: string[];
};

export function resolveFormatterCommand(
  options: unknown,
  env: NodeJS.ProcessEnv = process.env,
): FormatterCommand | null {
  const configured =
    configuredFormatter(options) ?? env.C3_FORMATTER ?? env.C3FMT;
  if (configured) return normalizeFormatterCommand(configured);

  const discovered =
    findExecutable('c3fmt', env) ?? findExecutable('c3-format', env);
  return discovered ? { command: discovered, args: [] } : null;
}

export function formatDocument(
  doc: TextDocument,
  formatter: FormatterCommand | null,
): TextEdit[] | null {
  if (!formatter) return null;

  const result = spawnSync(formatter.command, formatter.args, {
    input: doc.getText(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5000,
  });

  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }

  return formatEdits(doc, result.stdout);
}

export function formatEdits(doc: TextDocument, formatted: string): TextEdit[] {
  if (formatted === doc.getText()) return [];

  return [TextEdit.replace(fullDocumentRange(doc), formatted)];
}

function configuredFormatter(options: unknown): unknown {
  if (!options || typeof options !== 'object') return undefined;

  const record = options as Record<string, unknown>;
  return (
    record.formatterCommand ??
    record.formatterPath ??
    record.c3Formatter ??
    record.c3FormatterPath ??
    record['c3.formatterCommand'] ??
    record['c3.formatterPath']
  );
}

function normalizeFormatterCommand(
  configured: unknown,
): FormatterCommand | null {
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

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;

  for (const dir of pathValue.split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
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

function fullDocumentRange(doc: TextDocument): Range {
  const text = doc.getText();
  const lastLineStart = text.lastIndexOf('\n') + 1;

  return Range.create(
    Position.create(0, 0),
    doc.positionAt(lastLineStart + text.slice(lastLineStart).length),
  );
}
