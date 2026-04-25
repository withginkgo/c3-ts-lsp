#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  MarkupKind,
  Location,
  type Hover,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { semanticDiagnostics } from './analysis/diagnostics.js';
import { completionItems } from './lsp/completions.js';
import { wordAtPosition } from './lsp/document-refs.js';
import { documentSymbols } from './lsp/document-symbols.js';
import { parseSource } from './parser/c3-parser.js';
import { ProjectIndex } from './project/project-index.js';
import type { C3Symbol, ResolveResult } from './shared/types.js';
import { scanWorkspace } from './workspace/scan.js';
import { watchWorkspace, type WorkspaceWatcher } from './workspace/watch.js';

const hasTransportArg = process.argv.slice(2).some((arg) => {
  return (
    arg === '--node-ipc' ||
    arg === '--stdio' ||
    arg === '--socket' ||
    arg.startsWith('--socket=') ||
    arg === '--pipe' ||
    arg.startsWith('--pipe=')
  );
});

const connection = hasTransportArg
  ? createConnection(ProposedFeatures.all)
  : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const projectIndex = new ProjectIndex();

let workspaceRoot: string | null = null;
let workspaceWatcher: WorkspaceWatcher | null = null;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = resolveWorkspaceRoot(params);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      completionProvider: {
        triggerCharacters: [':', '.'],
      },
    },
  };
});

connection.onInitialized(() => {
  if (!workspaceRoot) {
    connection.console.log('no workspace root found');
    return;
  }

  connection.console.log(`workspace root: ${workspaceRoot}`);
  scanWorkspace(workspaceRoot, projectIndex, {
    log: (message) => connection.console.log(message),
    error: (message) => connection.console.error(message),
  });
  publishWorkspaceDiagnostics();

  workspaceWatcher = watchWorkspace(
    workspaceRoot,
    {
      change: (uri) => indexDocumentFromDisk(uri),
      delete: (uri) => removeIndexedDocument(uri),
    },
    {
      log: (message) => connection.console.log(message),
      error: (message) => connection.console.error(message),
    },
  );
});

documents.onDidOpen((event) => {
  parseAndIndexDocument(event.document);
});

documents.onDidChangeContent((event) => {
  parseAndIndexDocument(event.document);
});

documents.onDidClose((event) => {
  restoreClosedDocumentFromDisk(event.document.uri);
});

connection.onShutdown(() => {
  workspaceWatcher?.close();
  workspaceWatcher = null;
});

connection.onDocumentSymbol((params) => {
  const parsed = projectIndex.getParsed(params.textDocument.uri);
  if (!parsed) return [];

  return documentSymbols(parsed);
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const result = projectIndex.resolveSymbol(
    params.textDocument.uri,
    word,
    params.position,
  );

  return hoverFromResolveResult(result);
});

connection.onDefinition((params): Location | Location[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const result = projectIndex.resolveSymbol(
    params.textDocument.uri,
    word,
    params.position,
  );

  if (result.reason === 'ambiguous') {
    return result.candidates.map(symbolLocation);
  }

  const symbol = result.selected;
  if (!symbol) return null;

  return symbolLocation(symbol);
});

connection.onReferences((params): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const word = wordAtPosition(doc, params.position);
  if (!word) return [];

  const result = projectIndex.resolveSymbol(
    params.textDocument.uri,
    word,
    params.position,
  );

  if (!result.selected) return [];

  return projectIndex.referencesTo(result.selected);
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return completionItems(projectIndex, doc, current, params.position);
});

function parseAndIndexDocument(doc: TextDocument): void {
  const parsed = parseSource(doc.uri, doc.getText());
  projectIndex.upsert(parsed);
  publishWorkspaceDiagnostics();

  connection.console.log(
    `indexed ${doc.uri}: module=${parsed.moduleName}, symbols=${parsed.symbols.length}`,
  );
}

function restoreClosedDocumentFromDisk(uri: string): void {
  indexDocumentFromDisk(uri);
}

function indexDocumentFromDisk(uri: string): void {
  const openDocument = documents.get(uri);

  if (openDocument) {
    parseAndIndexDocument(openDocument);
    return;
  }

  const filePath = filePathFromUri(uri);

  if (filePath && workspaceRoot && isPathInside(filePath, workspaceRoot)) {
    try {
      if (fs.existsSync(filePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        const parsed = parseSource(uri, source);
        projectIndex.upsert(parsed);
        publishWorkspaceDiagnostics();
        connection.console.log(
          `indexed ${uri}: module=${parsed.moduleName}, symbols=${parsed.symbols.length}`,
        );
        return;
      }
    } catch (err) {
      connection.console.error(
        `failed to index document ${uri}: ${String(err)}`,
      );
    }
  }

  removeIndexedDocument(uri);
}

function removeIndexedDocument(uri: string): void {
  projectIndex.remove(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
  publishWorkspaceDiagnostics();
  connection.console.log(`removed ${uri} from index`);
}

function publishDiagnostics(parsed: ReturnType<typeof parseSource>): void {
  const diagnostics =
    parsed.diagnostics.length > 0
      ? parsed.diagnostics
      : [...parsed.diagnostics, ...semanticDiagnostics(projectIndex, parsed)];

  connection.sendDiagnostics({
    uri: parsed.uri,
    diagnostics,
  });
}

function publishWorkspaceDiagnostics(): void {
  for (const parsed of projectIndex.allParsed()) {
    publishDiagnostics(parsed);
  }
}

function hoverFromResolveResult(result: ResolveResult): Hover | null {
  if (result.selected) {
    return symbolHover(result.selected);
  }

  if (result.reason === 'ambiguous') {
    return ambiguousHover(result.candidates);
  }

  return null;
}

function symbolHover(symbol: C3Symbol): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: [
        '```c3',
        symbol.signature,
        '```',
        '',
        `module: \`${symbol.moduleName || '<unknown>'}\``,
      ].join('\n'),
    },
  };
}

function ambiguousHover(candidates: C3Symbol[]): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: [
        `Ambiguous symbol: ${candidates.length} candidates`,
        '',
        ...candidates.map(
          (symbol) =>
            `- \`${symbol.moduleName || '<unknown>'}\`: \`${symbol.signature}\``,
        ),
      ].join('\n'),
    },
  };
}

function symbolLocation(symbol: C3Symbol): Location {
  return Location.create(symbol.uri, symbol.selectionRange);
}

function resolveWorkspaceRoot(params: InitializeParams): string | null {
  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? null;
  if (!rootUri) return null;

  try {
    return fileURLToPath(rootUri);
  } catch (err) {
    connection.console.error(
      `invalid workspace root ${rootUri}: ${String(err)}`,
    );
    return null;
  }
}

function filePathFromUri(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

documents.listen(connection);
connection.listen();
