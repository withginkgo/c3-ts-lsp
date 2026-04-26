#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
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
import { hoverFromResolveResult } from './lsp/hover.js';
import { parseSource } from './parser/c3-parser.js';
import { ProjectIndex } from './project/project-index.js';
import type { C3Symbol, SourceKind } from './shared/types.js';
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
let stdlibRoots: string[] = [];

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = resolveWorkspaceRoot(params);
  stdlibRoots = resolveStdlibRoots(params, workspaceRoot);

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
  if (stdlibRoots.length > 0) {
    connection.console.log(`stdlib roots: ${stdlibRoots.join(', ')}`);
  }

  scanWorkspace(
    workspaceRoot,
    projectIndex,
    {
      log: (message) => connection.console.log(message),
      error: (message) => connection.console.error(message),
    },
    {
      rebuild: false,
    },
  );

  for (const stdlibRoot of stdlibRoots) {
    scanWorkspace(
      stdlibRoot,
      projectIndex,
      {
        log: (message) => connection.console.log(message),
        error: (message) => connection.console.error(message),
      },
      {
        rebuild: false,
        sourceKind: 'stdlib',
      },
    );
  }

  projectIndex.rebuild();
  connection.console.log(`indexed ${projectIndex.moduleCount()} modules`);

  if (stdlibRoots.length === 0) {
    connection.console.log(
      'no stdlib root configured; set initializationOptions.stdlibPath or C3_STDLIB_PATH',
    );
  }
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

  return hoverFromResolveResult(projectIndex, result);
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
  const parsed = parseSource(doc.uri, doc.getText(), {
    sourceKind: sourceKindForUri(doc.uri),
  });
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

  if (filePath && isIndexedSourcePath(filePath)) {
    try {
      if (fs.existsSync(filePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        const parsed = parseSource(uri, source, {
          sourceKind: sourceKindForPath(filePath),
        });
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
  if (parsed.sourceKind === 'stdlib') return;

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

function resolveStdlibRoots(
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
    record['c3.stdlib-path'],          // 插件用这个
    record['c3.stdlibPath'],           // 可能有的拼法
    record['c3.standardLibraryPath'],  // 极端情况
  ];

  return values.flatMap(configuredPathValues);
}

function stdlibPathsFromEnvironment(): string[] {
  const direct = [
    process.env.C3_STDLIB_PATH,
    process.env.C3_STDLIB_ROOT,
    process.env.C3_STANDARD_LIBRARY_PATH,
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

function filePathFromUri(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function sourceKindForUri(uri: string): SourceKind {
  const filePath = filePathFromUri(uri);
  return filePath ? sourceKindForPath(filePath) : 'workspace';
}

function sourceKindForPath(filePath: string): SourceKind {
  return isStdlibSourcePath(filePath) ? 'stdlib' : 'workspace';
}

function isIndexedSourcePath(filePath: string): boolean {
  return (
    (!!workspaceRoot && isPathInside(filePath, workspaceRoot)) ||
    stdlibRoots.some((root) => isPathInside(filePath, root))
  );
}

function isStdlibSourcePath(filePath: string): boolean {
  const inWorkspace = !!workspaceRoot && isPathInside(filePath, workspaceRoot);

  return stdlibRoots.some((root) => {
    if (!isPathInside(filePath, root)) return false;

    if (!inWorkspace) return true;

    return isPathInside(root, workspaceRoot!) && root !== workspaceRoot;
  });
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
