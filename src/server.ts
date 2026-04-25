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
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { completionItems } from './lsp/completions.js';
import { wordAtPosition } from './lsp/document-refs.js';
import { parseSource } from './parser/c3-parser.js';
import { ProjectIndex } from './project/project-index.js';
import { scanWorkspace } from './workspace/scan.js';

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

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = resolveWorkspaceRoot(params);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
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

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const parsed = projectIndex.getParsed(params.textDocument.uri);
  if (!parsed) return [];

  return parsed.symbols.map((symbol) => ({
    name: symbol.name,
    detail: symbol.signature,
    kind: symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  }));
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const symbol = projectIndex.findSymbol(params.textDocument.uri, word);
  if (!symbol) return null;

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
});

connection.onDefinition((params): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const symbol = projectIndex.findSymbol(params.textDocument.uri, word);
  if (!symbol) return null;

  return Location.create(symbol.uri, symbol.selectionRange);
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return completionItems(projectIndex, doc, current, params.position);
});

function parseAndIndexDocument(doc: TextDocument): void {
  const parsed = parseSource(doc.uri, doc.getText());
  projectIndex.upsert(parsed);

  connection.console.log(
    `indexed ${doc.uri}: module=${parsed.moduleName}, symbols=${parsed.symbols.length}`,
  );
}

function restoreClosedDocumentFromDisk(uri: string): void {
  const filePath = filePathFromUri(uri);

  if (filePath && workspaceRoot && isPathInside(filePath, workspaceRoot)) {
    try {
      if (fs.existsSync(filePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        projectIndex.upsert(parseSource(uri, source));
        return;
      }
    } catch (err) {
      connection.console.error(
        `failed to re-index closed document ${uri}: ${String(err)}`,
      );
    }
  }

  projectIndex.remove(uri);
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
