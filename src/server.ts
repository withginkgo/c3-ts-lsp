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
  type Diagnostic,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { semanticDiagnostics } from './analysis/diagnostics.js';
import { codeActions } from './lsp/code-actions.js';
import { completionItems } from './lsp/completions.js';
import { wordAtPosition } from './lsp/document-refs.js';
import { documentSymbols } from './lsp/document-symbols.js';
import { hoverFromResolveResult } from './lsp/hover.js';
import { inlayHints } from './lsp/inlay-hints.js';
import { prepareRename, renameSymbol } from './lsp/rename.js';
import { semanticTokenLegend, semanticTokens } from './lsp/semantic-tokens.js';
import { signatureHelp } from './lsp/signature-help.js';
import { workspaceSymbols } from './lsp/workspace-symbols.js';
import { parseSource } from './parser/c3-parser.js';
import {
  isProjectConfigFile,
  matchesProjectSource,
  projectTargetFromInitializationOptions,
  resolveC3ProjectModel,
  type C3ProjectModel,
} from './project/project-config.js';
import { ProjectIndex } from './project/project-index.js';
import type { C3Symbol, SourceKind } from './shared/types.js';
import {
  formatDocument,
  resolveFormatterCommand,
  type FormatterCommand,
} from './toolchain/formatter.js';
import {
  resolveCompilerCommand,
  runCompilerDiagnostics,
  type C3CompilerCommand,
  type CompilerDiagnosticRequest,
} from './toolchain/c3c.js';
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
let formatterCommand: FormatterCommand | null = null;
let compilerCommand: C3CompilerCommand | null = null;
let projectModel: C3ProjectModel | null = null;
let configuredProjectTarget: string | undefined;
let compilerDiagnosticsByUri = new Map<string, Diagnostic[]>();
let compilerDiagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
let compilerDiagnosticsGeneration = 0;

const compilerDiagnosticsDebounceMs = 500;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = resolveWorkspaceRoot(params);
  stdlibRoots = resolveStdlibRoots(params, workspaceRoot);
  formatterCommand = resolveFormatterCommand(params.initializationOptions);
  compilerCommand = resolveCompilerCommand(params.initializationOptions);
  configuredProjectTarget = projectTargetFromInitializationOptions(
    params.initializationOptions,
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
      semanticTokensProvider: {
        legend: semanticTokenLegend,
        full: true,
      },
      inlayHintProvider: true,
      documentFormattingProvider: formatterCommand !== null,
      completionProvider: {
        triggerCharacters: [':', '.', '@', '$'],
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
  if (compilerCommand) {
    connection.console.log(
      `compiler diagnostics enabled: ${compilerCommand.command}`,
    );
  }

  refreshProjectModel();
  scanWorkspaceSources();

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
  scheduleCompilerDiagnostics();

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
  clearCompilerDiagnostics(event.document.uri);
  parseAndIndexDocument(event.document);
});

documents.onDidClose((event) => {
  restoreClosedDocumentFromDisk(event.document.uri);
});

connection.onShutdown(() => {
  if (compilerDiagnosticsTimer) {
    clearTimeout(compilerDiagnosticsTimer);
    compilerDiagnosticsTimer = null;
  }
  workspaceWatcher?.close();
  workspaceWatcher = null;
});

connection.onDocumentSymbol((params) => {
  const parsed = projectIndex.getParsed(params.textDocument.uri);
  if (!parsed) return [];

  return documentSymbols(parsed);
});

connection.onWorkspaceSymbol((params) => {
  return workspaceSymbols(projectIndex, params);
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

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return signatureHelp(projectIndex, doc, current, params.position);
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return renameSymbol(
    projectIndex,
    doc,
    current,
    params.position,
    params.newName,
  );
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return prepareRename(projectIndex, doc, current, params.position);
});

connection.onCodeAction((params) => {
  const current = projectIndex.getParsed(params.textDocument.uri);

  return codeActions(projectIndex, current, params);
});

connection.languages.semanticTokens.on((params) => {
  const current = projectIndex.getParsed(params.textDocument.uri);

  return current ? semanticTokens(current) : { data: [] };
});

connection.languages.inlayHint.on((params) => {
  const current = projectIndex.getParsed(params.textDocument.uri);

  return inlayHints(projectIndex, current, params.range);
});

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);

  return doc ? formatDocument(doc, formatterCommand) : null;
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  const current = projectIndex.getParsed(params.textDocument.uri);

  return completionItems(projectIndex, doc, current, params.position);
});

function refreshProjectModel(): void {
  if (!workspaceRoot) {
    projectModel = null;
    return;
  }

  try {
    projectModel = resolveC3ProjectModel(workspaceRoot, {
      targetName: configuredProjectTarget,
    });
  } catch (err) {
    projectModel = null;
    connection.console.error(`failed to load C3 project model: ${String(err)}`);
    return;
  }

  if (!projectModel) return;

  const target = projectModel.targetName
    ? ` target=${projectModel.targetName}`
    : '';
  connection.console.log(
    `loaded project.json:${target}, sources=${projectModel.sourceFiles.length}, dependencies=${projectModel.dependencyFiles.length}`,
  );

  if (
    configuredProjectTarget &&
    projectModel.targetName !== configuredProjectTarget
  ) {
    connection.console.error(
      `configured project target '${configuredProjectTarget}' was not found; using '${projectModel.targetName ?? '<none>'}'`,
    );
  }
}

function scanWorkspaceSources(): void {
  if (!workspaceRoot) return;

  const reporter = {
    log: (message: string) => connection.console.log(message),
    error: (message: string) => connection.console.error(message),
  };

  if (!projectModel) {
    scanWorkspace(workspaceRoot, projectIndex, reporter, {
      rebuild: false,
    });
    return;
  }

  scanWorkspace(workspaceRoot, projectIndex, reporter, {
    rebuild: false,
    files: projectModel.sourceFiles,
  });

  if (projectModel.dependencyFiles.length > 0) {
    scanWorkspace(workspaceRoot, projectIndex, reporter, {
      rebuild: false,
      files: projectModel.dependencyFiles,
      sourceKind: 'dependency',
    });
  }
}

function reloadWorkspaceProjectModel(): void {
  if (!workspaceRoot) return;

  const previousWorkspaceUris = new Set(
    projectIndex
      .allParsed()
      .filter((parsed) => parsed.sourceKind === 'workspace')
      .map((parsed) => parsed.uri),
  );

  for (const parsed of projectIndex.allParsed()) {
    if (parsed.sourceKind === 'workspace' || parsed.sourceKind === 'dependency') {
      projectIndex.remove(parsed.uri);
    }
  }

  compilerDiagnosticsByUri = new Map();
  refreshProjectModel();
  scanWorkspaceSources();

  for (const doc of documents.all()) {
    const filePath = filePathFromUri(doc.uri);
    if (filePath && isIndexedSourcePath(filePath)) {
      const parsed = parseSource(doc.uri, doc.getText(), {
        sourceKind: sourceKindForPath(filePath),
      });
      projectIndex.upsert(parsed, false);
    }
  }

  projectIndex.rebuild();

  const currentWorkspaceUris = new Set(
    projectIndex
      .allParsed()
      .filter((parsed) => parsed.sourceKind === 'workspace')
      .map((parsed) => parsed.uri),
  );

  for (const uri of previousWorkspaceUris) {
    if (!currentWorkspaceUris.has(uri)) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }

  publishWorkspaceDiagnostics();
  scheduleCompilerDiagnostics();
  connection.console.log('reloaded C3 project model');
}

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
    scheduleCompilerDiagnostics();
    return;
  }

  const filePath = filePathFromUri(uri);

  if (filePath && isProjectConfigFile(filePath)) {
    reloadWorkspaceProjectModel();
    return;
  }

  if (filePath && isIndexedSourcePath(filePath)) {
    try {
      if (fs.existsSync(filePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        const parsed = parseSource(uri, source, {
          sourceKind: sourceKindForPath(filePath),
        });
        projectIndex.upsert(parsed);
        publishWorkspaceDiagnostics();
        scheduleCompilerDiagnostics();
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
  const filePath = filePathFromUri(uri);

  if (filePath && isProjectConfigFile(filePath)) {
    reloadWorkspaceProjectModel();
    return;
  }

  projectIndex.remove(uri);
  compilerDiagnosticsByUri.delete(uri);
  connection.sendDiagnostics({ uri, diagnostics: [] });
  publishWorkspaceDiagnostics();
  scheduleCompilerDiagnostics();
  connection.console.log(`removed ${uri} from index`);
}

function publishDiagnostics(parsed: ReturnType<typeof parseSource>): void {
  if (parsed.sourceKind !== 'workspace') return;

  const diagnostics = [
    ...parsed.diagnostics,
    ...semanticDiagnostics(projectIndex, parsed),
    ...(compilerDiagnosticsByUri.get(parsed.uri) ?? []),
  ];

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

function scheduleCompilerDiagnostics(): void {
  if (!compilerCommand || !workspaceRoot) return;

  compilerDiagnosticsGeneration++;

  if (compilerDiagnosticsTimer) {
    clearTimeout(compilerDiagnosticsTimer);
  }

  const generation = compilerDiagnosticsGeneration;
  compilerDiagnosticsTimer = setTimeout(() => {
    compilerDiagnosticsTimer = null;
    void refreshCompilerDiagnostics(generation);
  }, compilerDiagnosticsDebounceMs);
}

async function refreshCompilerDiagnostics(generation: number): Promise<void> {
  if (!compilerCommand) return;

  const request = compilerDiagnosticRequest();
  if (!request || (request.files.length === 0 && !hasWorkspaceProjectFile())) {
    compilerDiagnosticsByUri = new Map();
    publishWorkspaceDiagnostics();
    return;
  }

  try {
    const diagnostics = await runCompilerDiagnostics(compilerCommand, request);
    if (generation !== compilerDiagnosticsGeneration) return;

    compilerDiagnosticsByUri = diagnostics;
    publishWorkspaceDiagnostics();
  } catch (err) {
    if (generation !== compilerDiagnosticsGeneration) return;

    compilerDiagnosticsByUri = new Map();
    publishWorkspaceDiagnostics();
    connection.console.error(`c3c diagnostics failed: ${String(err)}`);
  }
}

function compilerDiagnosticRequest(): CompilerDiagnosticRequest | null {
  if (!workspaceRoot) return null;

  const files = new Set<string>();

  for (const parsed of projectIndex.allParsed()) {
    if (parsed.sourceKind !== 'workspace') continue;

    const filePath = filePathFromUri(parsed.uri);
    if (filePath && isIndexedSourcePath(filePath)) {
      files.add(filePath);
    }
  }

  return {
    workspaceRoot,
    files: [...files].sort((a, b) => a.localeCompare(b)),
    stdlibRoots,
    projectTarget: projectModel?.targetName,
  };
}

function clearCompilerDiagnostics(uri: string): void {
  compilerDiagnosticsByUri.delete(uri);

  if (!compilerCommand) return;

  compilerDiagnosticsGeneration++;

  if (compilerDiagnosticsTimer) {
    clearTimeout(compilerDiagnosticsTimer);
    compilerDiagnosticsTimer = null;
  }
}

function hasWorkspaceProjectFile(): boolean {
  return !!workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'project.json'));
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
  if (isStdlibSourcePath(filePath)) return 'stdlib';
  if (isDependencySourcePath(filePath)) return 'dependency';
  return 'workspace';
}

function isIndexedSourcePath(filePath: string): boolean {
  if (isStdlibSourcePath(filePath) || isDependencySourcePath(filePath)) {
    return true;
  }

  if (projectModel) {
    return matchesProjectSource(projectModel, filePath);
  }

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

function isDependencySourcePath(filePath: string): boolean {
  return (
    projectModel?.dependencyRoots.some((root) => isPathInside(filePath, root)) ??
    false
  );
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
