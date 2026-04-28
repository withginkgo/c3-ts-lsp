# Table of Contents
- server.ts
- lsp/completions.ts
- lsp/document-refs.ts
- lsp/document-symbols.ts
- lsp/hover.ts
- parser/c3-parser.ts
- project/project-index.ts
- shared/types.ts
- tools/debug-tree.ts
- tools/debug-symbols.ts
- workspace/scan.ts
- workspace/watch.ts
- analysis/diagnostics.ts

## File: server.ts

- Extension: .ts
- Language: typescript
- Size: 11828 bytes
- Created: 2026-04-25 19:29:12
- Modified: 2026-04-25 19:29:12

### Code

```typescript
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

```

## File: lsp/completions.ts

- Extension: .ts
- Language: typescript
- Size: 4072 bytes
- Created: 2026-04-25 19:06:40
- Modified: 2026-04-25 19:06:40

### Code

```typescript
import {
  CompletionItemKind,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const memberAccess = memberAccessBeforeCursor(doc, position);

  if (memberAccess) {
    return memberCompletions(
      index,
      current,
      memberAccess.receiver,
      memberAccess.position,
    );
  }

  const prefix = modulePrefixBeforeCursor(doc, position);

  if (prefix) {
    return moduleMemberCompletions(index, current, prefix);
  }

  const symbolItems: CompletionItem[] = index
    .visibleSymbolsAt(current.uri, position)
    .map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    }));

  return [...keywordCompletions(), ...symbolItems];
}

function memberAccessBeforeCursor(
  doc: TextDocument,
  position: Position,
): { receiver: string; position: Position } | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);
  const match = before.match(
    /((?:[&*]\s*)?(?:\([^()\n]+\)|[A-Za-z_$@][A-Za-z0-9_$@]*(?:(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)|\([^()\n]*\)|\[[^\]\n]*\]|\.[A-Za-z_$@][A-Za-z0-9_$@]*)*))\.$/,
  );

  if (!match || match.index == null) return null;

  return {
    receiver: match[1],
    position: doc.positionAt(match.index + match[1].length),
  };
}

function modulePrefixBeforeCursor(
  doc: TextDocument,
  position: Position,
): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  const before = text.slice(0, offset);

  const match = before.match(
    /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)::$/,
  );

  return match?.[1] ?? null;
}

function keywordCompletions(): CompletionItem[] {
  const keywords = [
    'module',
    'import',
    'fn',
    'struct',
    'union',
    'enum',
    'interface',
    'macro',
    'fault',
    'faultdef',
    'typedef',
    'alias',
    'const',
    'return',
    'defer',
    'catch',
    'if',
    'else',
    'while',
    'foreach',
    'switch',
    '@pool',
    '@dynamic',
  ];

  return keywords.map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
  }));
}

function memberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  receiver: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForExpression(current.uri, receiver, position)
    .map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    }));
}

function moduleMemberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  prefix: string,
): CompletionItem[] {
  const mod = index.resolveModuleFromPrefix(current, prefix);

  if (!mod) return [];

  const symbols = [...mod.symbols.values()].flat();

  return symbols.map((symbol) => ({
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  }));
}

function toCompletionKind(kind: SymbolKind): CompletionItemKind {
  switch (kind) {
    case SymbolKind.Function:
      return CompletionItemKind.Function;
    case SymbolKind.Method:
      return CompletionItemKind.Method;
    case SymbolKind.Field:
      return CompletionItemKind.Field;
    case SymbolKind.Struct:
      return CompletionItemKind.Struct;
    case SymbolKind.Enum:
      return CompletionItemKind.Enum;
    case SymbolKind.Interface:
      return CompletionItemKind.Interface;
    case SymbolKind.Constant:
      return CompletionItemKind.Constant;
    case SymbolKind.Variable:
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Text;
  }
}

```

## File: lsp/document-refs.ts

- Extension: .ts
- Language: typescript
- Size: 730 bytes
- Created: 2026-04-25 12:19:20
- Modified: 2026-04-25 11:59:24

### Code

```typescript
import type { Position } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function wordAtPosition(
  doc: TextDocument,
  position: Position,
): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  const isRefChar = (ch: string): boolean => /[A-Za-z0-9_:$@]/.test(ch);

  let start = offset;
  while (start > 0 && isRefChar(text[start - 1])) {
    start--;
  }

  let end = offset;
  while (end < text.length && isRefChar(text[end])) {
    end++;
  }

  const word = text.slice(start, end);

  if (
    !/^[A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)*$/.test(word)
  ) {
    return null;
  }

  return word;
}

```

## File: lsp/document-symbols.ts

- Extension: .ts
- Language: typescript
- Size: 657 bytes
- Created: 2026-04-25 13:19:44
- Modified: 2026-04-25 13:19:44

### Code

```typescript
import type { DocumentSymbol } from 'vscode-languageserver/node.js';

import type { C3Symbol, ParsedDocument } from '../shared/types.js';

export function documentSymbols(parsed: ParsedDocument): DocumentSymbol[] {
  return parsed.symbols.map(toDocumentSymbol);
}

function toDocumentSymbol(symbol: C3Symbol): DocumentSymbol {
  const documentSymbol: DocumentSymbol = {
    name: symbol.name,
    detail: symbol.signature,
    kind: symbol.kind,
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  };

  if (symbol.children.length > 0) {
    documentSymbol.children = symbol.children.map(toDocumentSymbol);
  }

  return documentSymbol;
}

```

## File: lsp/hover.ts

- Extension: .ts
- Language: typescript
- Size: 2825 bytes
- Created: 2026-04-25 19:26:22
- Modified: 2026-04-25 19:26:22

### Code

```typescript
import {
  MarkupKind,
  SymbolKind,
  type Hover,
} from 'vscode-languageserver/node.js';

import type { ProjectIndex } from '../project/project-index.js';
import type { C3Symbol, ResolveResult } from '../shared/types.js';

const aggregateKinds = new Set<SymbolKind>([
  SymbolKind.Struct,
  SymbolKind.Enum,
  SymbolKind.Interface,
]);

export function hoverFromResolveResult(
  index: ProjectIndex,
  result: ResolveResult,
): Hover | null {
  if (result.selected) {
    return symbolHover(index, result.selected);
  }

  if (result.reason === 'ambiguous') {
    return ambiguousHover(result.candidates);
  }

  return null;
}

export function symbolHover(index: ProjectIndex, symbol: C3Symbol): Hover {
  const sections = [codeBlock(formatPrimarySymbol(symbol))];
  const owner = index.ownerSymbol(symbol);
  const typeSymbol = index.typeSymbolFor(symbol);

  if (symbol.documentation) {
    sections.push(symbol.documentation);
  }

  if (owner) {
    sections.push('member of:', codeBlock(formatAggregateSymbol(owner)));
  }

  if (
    typeSymbol &&
    !sameSymbol(typeSymbol, symbol) &&
    (!owner || !sameSymbol(typeSymbol, owner))
  ) {
    sections.push('type:', codeBlock(formatAggregateSymbol(typeSymbol)));
  }

  sections.push(`module: \`${symbol.moduleName || '<unknown>'}\``);

  if (index.sourceKindForSymbol(symbol) === 'stdlib') {
    sections.push('source: `stdlib`');
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: sections.join('\n\n'),
    },
  };
}

export function ambiguousHover(candidates: C3Symbol[]): Hover {
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

function formatPrimarySymbol(symbol: C3Symbol): string {
  return aggregateKinds.has(symbol.kind)
    ? formatAggregateSymbol(symbol)
    : symbol.signature;
}

function formatAggregateSymbol(symbol: C3Symbol): string {
  if (!aggregateKinds.has(symbol.kind) || symbol.children.length === 0) {
    return symbol.signature;
  }

  return [
    `${symbol.signature} {`,
    ...symbol.children.map((child) => `    ${child.signature}`),
    '}',
  ].join('\n');
}

function codeBlock(value: string): string {
  return ['```c3', value, '```'].join('\n');
}

function sameSymbol(a: C3Symbol, b: C3Symbol): boolean {
  return (
    a.uri === b.uri &&
    a.selectionRange.start.line === b.selectionRange.start.line &&
    a.selectionRange.start.character === b.selectionRange.start.character &&
    a.selectionRange.end.line === b.selectionRange.end.line &&
    a.selectionRange.end.character === b.selectionRange.end.character
  );
}

```

## File: parser/c3-parser.ts

- Extension: .ts
- Language: typescript
- Size: 23362 bytes
- Created: 2026-04-25 19:22:08
- Modified: 2026-04-25 19:22:08

### Code

```typescript
import Parser, { SyntaxNode } from 'tree-sitter';
import C3 from 'tree-sitter-c3/bindings/node/index.js';
import {
  DiagnosticSeverity,
  Position,
  Range,
  SymbolKind,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type {
  C3Import,
  C3ModuleAlias,
  C3Symbol,
  ParsedDocument,
  SourceKind,
} from '../shared/types.js';

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

const commentTypes = new Set(['doc_comment', 'block_comment', 'line_comment']);

export function parseSource(
  uri: string,
  source: string,
  options: { sourceKind?: SourceKind } = {},
): ParsedDocument {
  const doc = TextDocument.create(uri, 'c3', 0, source);
  const tree = parser.parse(source);

  const moduleName = extractModuleName(tree.rootNode);
  const importSpecs = extractImportSpecs(tree.rootNode);
  const imports = importSpecs.map((imp) => imp.path);
  const moduleAliases = extractModuleAliases(doc, tree.rootNode);
  const symbols = extractTopLevelSymbols(doc, tree.rootNode, moduleName);
  const scopedSymbols = extractScopedSymbols(doc, tree.rootNode, moduleName);
  const diagnostics = collectSyntaxDiagnostics(tree.rootNode);

  return {
    uri,
    source,
    sourceKind: options.sourceKind ?? 'workspace',
    tree,
    symbols,
    scopedSymbols,
    moduleName,
    imports,
    importSpecs,
    moduleAliases,
    diagnostics,
  };
}

function extractModuleName(root: SyntaxNode): string {
  const moduleDecl = root.namedChildren.find(
    (child) => child.type === 'module_declaration',
  );

  if (!moduleDecl) return '';

  const modulePath = moduleDecl.childForFieldName('path');
  return modulePath?.text ?? '';
}

function extractImportSpecs(root: SyntaxNode): C3Import[] {
  const imports: C3Import[] = [];

  for (const child of root.namedChildren) {
    if (child.type !== 'import_declaration') continue;

    for (const importPath of descendantsOfType(child, 'import_path')) {
      const pathNode = directChildOfType(importPath, 'path_ident');
      const pathText = pathNode?.text ?? importPath.text;

      imports.push({
        path: pathText,
        range: rangeFromNode(importPath),
        selectionRange: pathNode
          ? rangeFromNode(pathNode)
          : rangeFromNode(importPath),
        attributes: attributesFor(importPath),
      });
    }
  }

  return imports;
}

function extractModuleAliases(
  doc: TextDocument,
  root: SyntaxNode,
): C3ModuleAlias[] {
  const aliases: C3ModuleAlias[] = [];

  for (const child of root.namedChildren) {
    if (
      child.type !== 'alias_declaration' ||
      !child.text.includes('= module')
    ) {
      continue;
    }

    const nameNode = child.childForFieldName('name');
    const targetNode = directChildOfType(child, 'path_ident');

    if (!nameNode || !targetNode) continue;

    aliases.push({
      name: nameNode.text,
      target: targetNode.text,
      range: rangeFromNode(child),
      selectionRange: rangeFromNode(nameNode),
      targetRange: rangeFromNode(targetNode),
    });
  }

  return aliases;
}

function extractTopLevelSymbols(
  doc: TextDocument,
  root: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const node of root.namedChildren) {
    symbols.push(...topLevelSymbolsForNode(doc, node, moduleName));
  }

  return symbols;
}

function extractScopedSymbols(
  doc: TextDocument,
  root: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const node of root.namedChildren) {
    symbols.push(...scopedSymbolsForNode(doc, node, moduleName));
  }

  return symbols;
}

function scopedSymbolsForNode(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  switch (node.type) {
    case 'func_definition':
    case 'macro_declaration':
      return scopedSymbolsForCallable(doc, node, moduleName);

    case 'global_declaration': {
      const funcDecl = directChildOfType(node, 'func_declaration');
      return funcDecl
        ? scopedSymbolsForCallable(doc, funcDecl, moduleName)
        : [];
    }

    default:
      return [];
  }
}

function scopedSymbolsForCallable(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const body = node.childForFieldName('body');
  const scopeRange = rangeFromNode(body ?? node);

  return [
    ...parameterSymbols(doc, node, moduleName, scopeRange),
    ...(body ? localDeclarationSymbols(doc, body, moduleName) : []),
  ];
}

function topLevelSymbolsForNode(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  switch (node.type) {
    case 'func_definition':
      return compact([
        functionSymbol(doc, node, moduleName, SymbolKind.Function),
      ]);

    case 'global_declaration':
      return globalSymbols(doc, node, moduleName);

    case 'struct_declaration':
      return compact([
        aggregateSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Struct,
          structMemberSymbols(doc, node, moduleName),
        ),
      ]);

    case 'bitstruct_declaration':
      return compact([
        aggregateSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Struct,
          bitstructMemberSymbols(doc, node, moduleName),
        ),
      ]);

    case 'enum_declaration':
      return compact([
        aggregateSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Enum,
          enumChildSymbols(doc, node, moduleName),
        ),
      ]);

    case 'constdef_declaration':
      return compact([
        aggregateSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Constant,
          enumChildSymbols(doc, node, moduleName),
        ),
      ]);

    case 'interface_declaration':
      return compact([
        aggregateSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Interface,
          interfaceMemberSymbols(doc, node, moduleName),
        ),
      ]);

    case 'macro_declaration':
      return compact([macroSymbol(doc, node, moduleName)]);

    case 'alias_declaration':
      return compact([
        simpleDeclarationSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.TypeParameter,
        ),
      ]);

    case 'typedef_declaration':
      return compact([
        simpleDeclarationSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.TypeParameter,
        ),
      ]);

    case 'attrdef_declaration':
      return compact([
        simpleDeclarationSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Property,
          parameterSymbols(doc, node, moduleName),
        ),
      ]);

    case 'faultdef_declaration':
      return faultSymbols(doc, node, moduleName);

    default:
      return [];
  }
}

function globalSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const funcDecl = directChildOfType(node, 'func_declaration');

  if (funcDecl) {
    return compact([
      functionSymbol(doc, funcDecl, moduleName, SymbolKind.Function, node),
    ]);
  }

  const constDecl = directChildOfType(node, 'const_declaration');

  if (constDecl) {
    const nameNode = constDecl.childForFieldName('name');
    return compact([
      nameNode
        ? createSymbol(doc, node, nameNode, moduleName, SymbolKind.Constant, {
            signature: declarationSignature(node),
            returnType: constDecl.childForFieldName('type')?.text,
          })
        : null,
    ]);
  }

  const declaration = directChildOfType(node, 'declaration');
  if (!declaration) return [];

  const names = declarationNameNodes(declaration);

  return names.map((nameNode) =>
    createSymbol(doc, node, nameNode, moduleName, SymbolKind.Variable, {
      signature: declarationSignature(node),
      returnType: declaration.childForFieldName('type')?.text,
    }),
  );
}

function aggregateSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  children: C3Symbol[] = [],
): C3Symbol | null {
  const nameNode = extractNameNode(node);
  if (!nameNode) return null;

  return createSymbol(doc, node, nameNode, moduleName, kind, {
    bodyNode: node.childForFieldName('body') ?? undefined,
    children,
    signature: declarationSignature(node),
  });
}

function simpleDeclarationSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  children: C3Symbol[] = [],
): C3Symbol | null {
  const nameNode = extractNameNode(node);
  if (!nameNode) return null;

  return createSymbol(doc, node, nameNode, moduleName, kind, {
    children,
    signature: declarationSignature(node),
  });
}

function functionSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  rangeNode = node,
): C3Symbol | null {
  const header = directChildOfType(node, 'func_header');
  const nameNode = header?.childForFieldName('name') ?? extractNameNode(node);
  if (!nameNode) return null;

  return createSymbol(doc, rangeNode, nameNode, moduleName, kind, {
    bodyNode: node.childForFieldName('body') ?? undefined,
    children: parameterSymbols(doc, node, moduleName),
    parameters: parameterSignatures(node),
    returnType: header?.childForFieldName('return_type')?.text,
    signature: callableSignature(node, 'func_header', 'func_param_list'),
  });
}

function macroSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol | null {
  const header = directChildOfType(node, 'macro_header');
  const nameNode = header?.childForFieldName('name') ?? extractNameNode(node);
  if (!nameNode) return null;

  return createSymbol(doc, node, nameNode, moduleName, SymbolKind.Function, {
    bodyNode: node.childForFieldName('body') ?? undefined,
    children: parameterSymbols(doc, node, moduleName),
    parameters: parameterSignatures(node),
    returnType: header?.childForFieldName('return_type')?.text,
    signature: `macro ${callableSignature(
      node,
      'macro_header',
      'macro_param_list',
    )}`,
  });
}

function faultSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  return directChildrenOfType(node, 'const_ident').map((nameNode) =>
    createSymbol(doc, node, nameNode, moduleName, SymbolKind.Constant, {
      signature: declarationSignature(node),
    }),
  );
}

function structMemberSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];

  const symbols: C3Symbol[] = [];

  for (const member of directChildrenOfType(
    body,
    'struct_member_declaration',
  )) {
    const fieldNames = identifierListNames(member);

    for (const nameNode of fieldNames) {
      symbols.push(
        createSymbol(doc, member, nameNode, moduleName, SymbolKind.Field, {
          signature: declarationSignature(member),
          returnType: member.childForFieldName('type')?.text,
        }),
      );
    }

    if (fieldNames.length > 0) continue;

    const nestedName = directChildOfType(member, 'ident');
    const nestedBody = member.childForFieldName('body');

    if (nestedName && nestedBody) {
      symbols.push(
        createSymbol(doc, member, nestedName, moduleName, SymbolKind.Struct, {
          bodyNode: nestedBody,
          children: structMemberSymbols(doc, member, moduleName),
          signature: declarationSignature(member),
        }),
      );
    }
  }

  return symbols;
}

function bitstructMemberSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];

  return directChildrenOfType(body, 'bitstruct_member_declaration').flatMap(
    (member) => {
      const nameNode = directChildOfType(member, 'ident');

      return nameNode
        ? [
            createSymbol(doc, member, nameNode, moduleName, SymbolKind.Field, {
              signature: declarationSignature(member),
              returnType: member.childForFieldName('type')?.text,
            }),
          ]
        : [];
    },
  );
}

function enumChildSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const param of descendantsOfType(node, 'enum_param')) {
    const nameNode = param.childForFieldName('name');
    if (!nameNode) continue;

    symbols.push(
      createSymbol(doc, param, nameNode, moduleName, SymbolKind.Variable, {
        signature: declarationSignature(param),
        returnType: param.childForFieldName('type')?.text,
      }),
    );
  }

  const body = node.childForFieldName('body');
  if (!body) return symbols;

  for (const constant of directChildrenOfType(body, 'enum_constant')) {
    const nameNode = constant.childForFieldName('name');
    if (!nameNode) continue;

    symbols.push(
      createSymbol(doc, constant, nameNode, moduleName, SymbolKind.Constant, {
        signature: declarationSignature(constant),
      }),
    );
  }

  return symbols;
}

function interfaceMemberSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];

  return directChildrenOfType(body, 'interface_func_declaration').flatMap(
    (member) => {
      const funcDecl = directChildOfType(member, 'func_declaration');
      if (!funcDecl) return [];

      const symbol = functionSymbol(
        doc,
        funcDecl,
        moduleName,
        SymbolKind.Method,
        member,
      );

      return symbol ? [symbol] : [];
    },
  );
}

function parameterSymbols(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  scopeRange?: Range,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const param of descendantsOfType(node, 'param')) {
    const nameNode = param.childForFieldName('name');
    if (!nameNode) continue;

    symbols.push(
      createSymbol(doc, param, nameNode, moduleName, SymbolKind.Variable, {
        signature: declarationSignature(param),
        returnType: param.childForFieldName('type')?.text,
        scopeRange,
      }),
    );
  }

  for (const trailingBlockParam of descendantsOfType(
    node,
    'trailing_block_param',
  )) {
    const nameNode = directChildOfType(trailingBlockParam, 'at_ident');
    if (!nameNode) continue;

    symbols.push(
      createSymbol(
        doc,
        trailingBlockParam,
        nameNode,
        moduleName,
        SymbolKind.Variable,
        {
          signature: compactText(trailingBlockParam.text),
          scopeRange,
        },
      ),
    );
  }

  return symbols;
}

function localDeclarationSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const declaration of descendantsOfType(scopeRoot, 'declaration')) {
    const parent = declaration.parent;

    if (parent?.type !== 'declaration_stmt') continue;

    const names = declarationNameNodes(declaration);
    const rangeNode = parent ?? declaration;
    const scopeNode = nearestAncestorOfTypes(declaration, [
      'compound_stmt',
      'macro_func_body',
      'lambda_body',
      'ct_stmt_body',
    ]);
    const scopeRange = rangeFromNode(scopeNode ?? scopeRoot);

    for (const nameNode of names) {
      symbols.push(
        createSymbol(
          doc,
          rangeNode,
          nameNode,
          moduleName,
          SymbolKind.Variable,
          {
            signature: declarationSignature(rangeNode),
            returnType: declaration.childForFieldName('type')?.text,
            scopeRange,
          },
        ),
      );
    }
  }

  return symbols;
}

function createSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  nameNode: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  options: {
    signature: string;
    bodyNode?: SyntaxNode;
    children?: C3Symbol[];
    documentation?: string;
    attributes?: string[];
    returnType?: string;
    parameters?: string[];
    scopeRange?: Range;
  },
): C3Symbol {
  return {
    name: nameNode.text,
    moduleName,
    kind,
    uri: doc.uri,
    range: rangeFromNode(node),
    selectionRange: rangeFromNode(nameNode),
    bodyRange: options.bodyNode ? rangeFromNode(options.bodyNode) : undefined,
    signature: options.signature,
    documentation: options.documentation ?? documentationFor(node),
    attributes: options.attributes ?? attributesFor(node),
    returnType: options.returnType,
    parameters: options.parameters ?? [],
    scopeRange: options.scopeRange,
    children: options.children ?? [],
  };
}

function extractNameNode(node: SyntaxNode): SyntaxNode | null {
  const byField = node.childForFieldName('name');
  if (byField) return byField;

  if (node.type === 'func_definition' || node.type === 'func_declaration') {
    const header = directChildOfType(node, 'func_header');
    return header?.childForFieldName('name') ?? null;
  }

  if (node.type === 'macro_declaration') {
    const header = directChildOfType(node, 'macro_header');
    return header?.childForFieldName('name') ?? null;
  }

  return findFirstDescendantOfTypes(node, [
    'ident',
    'type_ident',
    'const_ident',
    'at_ident',
    'at_type_ident',
    'ct_ident',
    'ct_type_ident',
    'ct_const_ident',
  ]);
}

function declarationNameNodes(node: SyntaxNode): SyntaxNode[] {
  const byField = node.childForFieldName('name');
  if (byField) return [byField];

  const identifierList = directChildOfType(node, 'identifier_list');
  if (identifierList) return directChildrenOfType(identifierList, 'ident');

  return [];
}

function identifierListNames(node: SyntaxNode): SyntaxNode[] {
  const identifierList = directChildOfType(node, 'identifier_list');
  if (!identifierList) return [];

  return directChildrenOfType(identifierList, 'ident');
}

function parameterSignatures(node: SyntaxNode): string[] {
  return descendantsOfType(node, 'param').map((param) =>
    compactText(param.text),
  );
}

function declarationSignature(node: SyntaxNode): string {
  const body = node.childForFieldName('body');
  const startIndex = signatureStartIndex(node);
  const endIndex = body?.startIndex ?? node.endIndex;

  return compactText(
    node.text.slice(startIndex - node.startIndex, endIndex - node.startIndex),
  );
}

function callableSignature(
  node: SyntaxNode,
  headerType: string,
  paramListType: string,
): string {
  const header = directChildOfType(node, headerType);
  const params = directChildOfType(node, paramListType);

  if (!header || !params) {
    return declarationSignature(node);
  }

  const endParts = directChildrenOfTypes(node, [
    'generic_param_list',
    'attributes',
  ])
    .filter((part) => part.startIndex > params.endIndex)
    .map((part) => part.text);

  const suffix = endParts.length > 0 ? ` ${endParts.join(' ')}` : '';
  return compactText(`${header.text}${params.text}${suffix}`);
}

function signatureStartIndex(node: SyntaxNode): number {
  const docComment = directChildOfType(node, 'doc_comment');
  return docComment ? docComment.endIndex : node.startIndex;
}

function documentationFor(node: SyntaxNode): string | undefined {
  const docComment = directChildOfType(node, 'doc_comment');

  if (docComment) {
    return cleanCommentText(docComment.text);
  }

  const previous = node.previousNamedSibling;

  if (
    previous &&
    commentTypes.has(previous.type) &&
    previous.endPosition.row + 1 >= node.startPosition.row
  ) {
    return cleanCommentText(previous.text);
  }

  return undefined;
}

function cleanCommentText(text: string): string {
  const cleaned = text
    .replace(/^<\*/, '')
    .replace(/\*>$/, '')
    .replace(/^\/\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^\* ?/, '')
        .replace(/^\/\/ ?/, ''),
    )
    .join('\n')
    .trim();

  return cleaned;
}

function attributesFor(node: SyntaxNode): string[] {
  const attributes: string[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'attributes') {
      attributes.push(
        ...directChildrenOfType(child, 'attribute').map((attr) => attr.text),
      );
    }

    if (child.type === 'attribute') {
      attributes.push(child.text);
    }
  }

  return attributes;
}

function collectSyntaxDiagnostics(root: SyntaxNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function visit(node: SyntaxNode): void {
    if (!node.hasError && !node.isError && !node.isMissing) return;

    if (node.isError || node.isMissing) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: nonEmptyRangeFromNode(node),
        message: node.isMissing
          ? `Missing ${node.type}`
          : 'Syntax error: unable to parse this C3 syntax',
        source: 'tree-sitter-c3',
      });

      if (node.isError) return;
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);

  return diagnostics;
}

function compactText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function directChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type === type) ?? null;
}

function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === type);
}

function directChildrenOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode[] {
  return node.namedChildren.filter((child) => types.includes(child.type));
}

function descendantsOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];

  for (const child of node.namedChildren) {
    if (child.type === type) {
      found.push(child);
    }

    found.push(...descendantsOfType(child, type));
  }

  return found;
}

function findFirstDescendantOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode | null {
  if (types.includes(node.type)) return node;

  for (const child of node.namedChildren) {
    const found = findFirstDescendantOfTypes(child, types);
    if (found) return found;
  }

  return null;
}

function nearestAncestorOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode | null {
  let current = node.parent;

  while (current) {
    if (types.includes(current.type)) return current;
    current = current.parent;
  }

  return null;
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    Position.create(node.startPosition.row, node.startPosition.column),
    Position.create(node.endPosition.row, node.endPosition.column),
  );
}

function nonEmptyRangeFromNode(node: SyntaxNode): Range {
  const range = rangeFromNode(node);

  if (
    range.start.line === range.end.line &&
    range.start.character === range.end.character
  ) {
    return Range.create(
      range.start,
      Position.create(range.end.line, range.end.character + 1),
    );
  }

  return range;
}

function compact<T>(items: Array<T | null | undefined>): T[] {
  return items.filter((item): item is T => item != null);
}

```

## File: project/project-index.ts

- Extension: .ts
- Language: typescript
- Size: 37024 bytes
- Created: 2026-04-25 19:24:38
- Modified: 2026-04-25 19:24:38

### Code

```typescript
import {
  Location,
  Range,
  SymbolKind,
  type Position,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type {
  C3Symbol,
  ModuleIndex,
  ParsedDocument,
  ResolveResult,
  SourceKind,
} from '../shared/types.js';

export class ProjectIndex {
  private readonly parsedByUri = new Map<string, ParsedDocument>();
  private readonly modulesByName = new Map<string, ModuleIndex>();

  getParsed(uri: string): ParsedDocument | undefined {
    return this.parsedByUri.get(uri);
  }

  allParsed(): ParsedDocument[] {
    return [...this.parsedByUri.values()];
  }

  getModule(name: string): ModuleIndex | undefined {
    return this.modulesByName.get(name);
  }

  resolveImportedModule(
    current: ParsedDocument,
    importPath: string,
  ): ModuleIndex | undefined {
    return (
      this.modulesByName.get(importPath) ??
      this.modulesByName.get(`${current.moduleName}::${importPath}`)
    );
  }

  moduleCount(): number {
    return this.modulesByName.size;
  }

  upsert(parsed: ParsedDocument, rebuild = true): void {
    const previous = this.parsedByUri.get(parsed.uri);
    this.parsedByUri.set(parsed.uri, parsed);

    if (rebuild) {
      this.rebuildAffectedModules(previous?.moduleName, parsed.moduleName);
    }
  }

  remove(uri: string): void {
    const previous = this.parsedByUri.get(uri);
    this.parsedByUri.delete(uri);

    if (previous) {
      this.rebuildAffectedModules(previous.moduleName);
    }
  }

  rebuild(): void {
    this.modulesByName.clear();

    for (const parsed of this.parsedByUri.values()) {
      this.addParsedToModule(parsed);
    }
  }

  visibleSymbols(current: ParsedDocument): C3Symbol[] {
    const currentModule = this.modulesByName.get(current.moduleName);
    if (!currentModule) return [];

    const symbols = [...currentModule.symbols.values()].flat();

    for (const imp of currentModule.imports) {
      const importedModule = this.resolveImportedModule(current, imp);
      if (!importedModule) continue;

      symbols.push(
        ...[...importedModule.symbols.values()]
          .flat()
          .filter((symbol) => isVisibleFrom(symbol, current.moduleName)),
      );
    }

    return symbols;
  }

  visibleSymbolsAt(currentUri: string, position: Position): C3Symbol[] {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return [];

    return [
      ...findScopedSymbolsAt(current.scopedSymbols, position),
      ...this.visibleSymbols(current),
    ];
  }

  memberSymbolsForReceiver(
    currentUri: string,
    receiverRef: string,
    position: Position,
  ): C3Symbol[] {
    return this.memberSymbolsForExpression(currentUri, receiverRef, position);
  }

  memberSymbolsForExpression(
    currentUri: string,
    receiverExpression: string,
    position: Position,
  ): C3Symbol[] {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return [];

    const typeName = this.expressionTypeNameFromText(
      current,
      receiverExpression,
      position,
    );
    if (!typeName) return [];

    return this.membersForTypeName(current, typeName, position);
  }

  memberSymbolsForType(
    currentUri: string,
    typeName: string,
    position: Position,
  ): C3Symbol[] {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return [];

    return this.membersForTypeName(current, typeName, position);
  }

  findSymbol(currentUri: string, ref: string): C3Symbol | undefined {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return undefined;

    if (ref.includes('::')) {
      return this.resolveQualifiedSymbol(current, ref);
    }

    const currentModule = this.modulesByName.get(current.moduleName);
    const local = currentModule?.allSymbols.get(ref)?.[0];

    if (local) return local;

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const importedModule = this.resolveImportedModule(current, imp);
        const imported = importedModule?.allSymbols
          .get(ref)
          ?.find((symbol) => isVisibleFrom(symbol, current.moduleName));

        if (imported) return imported;
      }
    }

    return undefined;
  }

  resolveSymbol(
    currentUri: string,
    ref: string,
    position: Position,
  ): ResolveResult {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return { candidates: [], reason: 'not_found' };

    const memberCandidates = this.memberSymbolCandidatesAt(
      current,
      ref,
      position,
    );

    if (memberCandidates) {
      return resultFromCandidates(memberCandidates);
    }

    if (ref.includes('::')) {
      return resultFromCandidates(
        this.overloadCandidatesAt(
          current,
          ref,
          position,
          this.qualifiedSymbolCandidates(current, ref),
        ),
      );
    }

    const declared = findDeclaredSymbolAt(current.symbols, ref, position);
    if (declared) return resultFromCandidates([declared]);

    const scoped = findScopedSymbolAt(current.scopedSymbols, ref, position);
    if (scoped) return resultFromCandidates([scoped]);

    const moduleCandidates = this.visibleModuleSymbolCandidates(current, ref);
    if (moduleCandidates.length > 0) {
      return resultFromCandidates(
        this.overloadCandidatesAt(current, ref, position, moduleCandidates),
      );
    }

    return resultFromCandidates(
      this.visibleUnqualifiedNestedCandidates(current, ref),
    );
  }

  findSymbolAt(
    currentUri: string,
    ref: string,
    position: Position,
  ): C3Symbol | undefined {
    return this.resolveSymbol(currentUri, ref, position).selected;
  }

  ownerSymbol(symbol: C3Symbol): C3Symbol | undefined {
    const parsed = this.parsedByUri.get(symbol.uri);
    if (!parsed) return undefined;

    for (const topLevel of parsed.symbols) {
      const owner = findOwnerSymbol(topLevel, symbol);
      if (owner) return owner;
    }

    return undefined;
  }

  typeSymbolFor(symbol: C3Symbol): C3Symbol | undefined {
    if (isTypeSymbol(symbol)) return symbol;
    if (!symbol.returnType) return undefined;

    const parsed = this.parsedByUri.get(symbol.uri);
    if (!parsed) return undefined;

    return this.resolveTypeSymbol(
      parsed,
      normalizeTypeName(symbol.returnType),
      symbol.selectionRange.start,
    );
  }

  sourceKindForSymbol(symbol: C3Symbol): SourceKind | undefined {
    return this.parsedByUri.get(symbol.uri)?.sourceKind;
  }

  referencesTo(target: C3Symbol): Location[] {
    const locations: Location[] = [];

    for (const parsed of this.parsedByUri.values()) {
      for (const symbol of declaredSymbols(parsed)) {
        if (sameSymbol(symbol, target)) {
          locations.push(symbolLocation(symbol));
        }
      }

      for (const ref of referenceNodes(parsed.tree.rootNode)) {
        this.addReferenceLocation(parsed, ref, target, locations);
      }

      for (const ref of memberReferenceNodes(parsed.tree.rootNode)) {
        this.addReferenceLocation(parsed, ref, target, locations);
      }

      if (isTypeSymbol(target)) {
        for (const ref of typeReferenceNodes(parsed.tree.rootNode)) {
          this.addTypeReferenceLocation(parsed, ref, target, locations);
        }
      }
    }

    return uniqueLocations(locations).sort(compareLocations);
  }

  private visibleModuleSymbolCandidates(
    current: ParsedDocument,
    ref: string,
  ): C3Symbol[] {
    const currentModule = this.modulesByName.get(current.moduleName);
    const local = currentModule?.symbols.get(ref) ?? [];

    if (local.length > 0) return local;

    const imported: C3Symbol[] = [];

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const importedModule = this.resolveImportedModule(current, imp);
        imported.push(
          ...(importedModule?.symbols.get(ref) ?? []).filter((symbol) =>
            isVisibleFrom(symbol, current.moduleName),
          ),
        );
      }
    }

    return imported;
  }

  resolveModuleFromPrefix(
    current: ParsedDocument,
    prefix: string,
  ): ModuleIndex | undefined {
    const direct = this.modulesByName.get(prefix);
    if (direct) return direct;

    const currentModule = this.modulesByName.get(current.moduleName);

    const aliased = currentModule?.moduleAliases.get(prefix);
    if (aliased) return this.resolveImportedModule(current, aliased);

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);

        if (lastSegment === prefix) {
          return this.resolveImportedModule(current, imp);
        }
      }
    }

    const relative = this.modulesByName.get(`${current.moduleName}::${prefix}`);
    if (relative) return relative;

    return undefined;
  }

  private resolveQualifiedSymbol(
    current: ParsedDocument,
    ref: string,
  ): C3Symbol | undefined {
    return this.qualifiedSymbolCandidates(current, ref)[0];
  }

  private qualifiedSymbolCandidates(
    current: ParsedDocument,
    ref: string,
  ): C3Symbol[] {
    const parts = ref.split('::');

    if (parts.length < 2) return [];

    const symbolName = parts[parts.length - 1];
    const modulePrefix = parts.slice(0, -1).join('::');

    const directModule = this.modulesByName.get(modulePrefix);
    const direct =
      directModule?.allSymbols
        .get(symbolName)
        ?.filter((symbol) => isVisibleFrom(symbol, current.moduleName)) ?? [];

    if (direct.length > 0) return direct;

    const currentModule = this.modulesByName.get(current.moduleName);

    const aliased = currentModule?.moduleAliases.get(modulePrefix);
    if (aliased) {
      return (
        this.resolveImportedModule(current, aliased)
          ?.allSymbols.get(symbolName)
          ?.filter((symbol) => isVisibleFrom(symbol, current.moduleName)) ?? []
      );
    }

    if (currentModule) {
      const imported: C3Symbol[] = [];

      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);

        if (lastSegment === modulePrefix) {
          const importedModule = this.resolveImportedModule(current, imp);
          imported.push(
            ...(importedModule?.allSymbols.get(symbolName) ?? []).filter(
              (symbol) => isVisibleFrom(symbol, current.moduleName),
            ),
          );
        }
      }

      if (imported.length > 0) return imported;
    }

    const relativeModuleName = `${current.moduleName}::${modulePrefix}`;
    const relativeModule = this.modulesByName.get(relativeModuleName);
    return relativeModule?.allSymbols.get(symbolName) ?? [];
  }

  private visibleUnqualifiedNestedCandidates(
    current: ParsedDocument,
    ref: string,
  ): C3Symbol[] {
    const currentModule = this.modulesByName.get(current.moduleName);
    const local = findUnqualifiedNestedUsageSymbol(currentModule, ref);

    if (local) return [local];

    if (currentModule) {
      const importedCandidates: C3Symbol[] = [];

      for (const imp of currentModule.imports) {
        const importedModule = this.resolveImportedModule(current, imp);
        const imported = findUnqualifiedNestedUsageSymbol(importedModule, ref);

        if (imported && isVisibleFrom(imported, current.moduleName)) {
          importedCandidates.push(imported);
        }
      }

      if (importedCandidates.length > 0) return importedCandidates;
    }

    return [];
  }

  private memberSymbolCandidatesAt(
    current: ParsedDocument,
    ref: string,
    position: Position,
  ): C3Symbol[] | undefined {
    const fieldExpr = fieldExpressionAt(current, ref, position);
    if (!fieldExpr) return undefined;

    const argument = fieldExpr.childForFieldName('argument');
    if (!argument) return [];

    const typeName = this.expressionTypeName(current, argument, position);
    if (!typeName) return [];

    return this.membersForTypeName(current, typeName, position).filter(
      (member) => member.name === ref,
    );
  }

  private expressionTypeName(
    current: ParsedDocument,
    expression: SyntaxNode,
    position: Position,
  ): string | undefined {
    const literalType = literalTypeName(expression);
    if (literalType) return literalType;

    if (expression.type === 'ident_expr') {
      const resolved = this.resolveSymbol(
        current.uri,
        expression.text,
        rangeFromNode(expression).start,
      ).selected;

      return resolved?.returnType ?? symbolTypeName(resolved);
    }

    if (expression.type === 'call_expr') {
      const functionNode = expression.childForFieldName('function');
      if (!functionNode) return undefined;

      return this.expressionTypeName(
        current,
        functionNode,
        rangeFromNode(functionNode).start,
      );
    }

    if (expression.type === 'field_expr') {
      const field = expression.childForFieldName('field');
      if (!field) return undefined;

      const member = this.memberSymbolCandidatesAt(
        current,
        field.text,
        rangeFromNode(field).start,
      )?.[0];

      return member?.returnType;
    }

    if (expression.type === 'subscript_expr') {
      const argument = expression.childForFieldName('argument');
      if (!argument) return undefined;

      const indexedType = this.expressionTypeName(current, argument, position);
      return indexedType ? elementTypeName(indexedType) : undefined;
    }

    if (expression.type === 'paren_expr') {
      const inner = expression.namedChildren[0];
      return inner ? this.expressionTypeName(current, inner, position) : undefined;
    }

    if (expression.type === 'unary_expr') {
      const argument = expression.childForFieldName('argument');
      if (!argument) return undefined;

      const argumentType = this.expressionTypeName(current, argument, position);
      if (!argumentType) return undefined;

      const text = expression.text.trim();
      if (text.startsWith('&')) return `${normalizeTypeName(argumentType)}*`;
      if (text.startsWith('*')) return normalizeTypeName(argumentType);

      return argumentType;
    }

    if (expression.type === 'cast_expr') {
      const typeNode = expression.childForFieldName('type');
      if (typeNode) return typeNode.text;
    }

    return undefined;
  }

  private expressionTypeNameFromText(
    current: ParsedDocument,
    expressionText: string,
    position: Position,
  ): string | undefined {
    const parts = splitMemberExpression(expressionText);
    if (parts.length === 0) {
      return this.expressionTypeNameAtPosition(current, position);
    }

    let typeName = this.baseExpressionTypeNameFromText(
      current,
      parts[0],
      position,
    );

    for (const part of parts.slice(1)) {
      if (!typeName) return undefined;

      const memberAccess = parseMemberSegment(part);
      if (!memberAccess) return undefined;

      const member = this.membersForTypeName(current, typeName, position).find(
        (candidate) => candidate.name === memberAccess.name,
      );

      typeName = member?.returnType;

      if (typeName && memberAccess.indexed) {
        typeName = elementTypeName(typeName);
      }
    }

    return typeName ?? this.expressionTypeNameAtPosition(current, position);
  }

  private expressionTypeNameAtPosition(
    current: ParsedDocument,
    position: Position,
  ): string | undefined {
    const node = nodeAtOrBeforePosition(current.tree.rootNode, position);
    if (!node) return undefined;

    const expression = nearestExpressionNode(node);
    if (!expression) return undefined;

    return this.expressionTypeName(current, expression, rangeFromNode(node).start);
  }

  private baseExpressionTypeNameFromText(
    current: ParsedDocument,
    expressionText: string,
    position: Position,
  ): string | undefined {
    const text = stripOuterParens(expressionText.trim());
    if (!text) return undefined;

    if (text.startsWith('&')) {
      const innerType = this.baseExpressionTypeNameFromText(
        current,
        text.slice(1),
        position,
      );
      return innerType ? `${normalizeTypeName(innerType)}*` : undefined;
    }

    if (text.startsWith('*')) {
      const innerType = this.baseExpressionTypeNameFromText(
        current,
        text.slice(1),
        position,
      );
      return innerType ? normalizeTypeName(innerType) : undefined;
    }

    const subscript = splitTrailingSubscript(text);
    if (subscript) {
      const baseType = this.baseExpressionTypeNameFromText(
        current,
        subscript.base,
        position,
      );
      return baseType ? elementTypeName(baseType) : undefined;
    }

    const call = splitCallExpression(text);
    if (call) {
      return this.resolveSymbol(current.uri, call.functionRef, position).selected
        ?.returnType;
    }

    if (isReferenceText(text)) {
      const resolved = this.resolveSymbol(current.uri, text, position).selected;
      return (
        resolved?.returnType ??
        symbolTypeName(resolved) ??
        recoverableLocalTypeName(current, text, position)
      );
    }

    return undefined;
  }

  private overloadCandidatesAt(
    current: ParsedDocument,
    ref: string,
    position: Position,
    candidates: C3Symbol[],
  ): C3Symbol[] {
    if (candidates.length <= 1) return candidates;

    const call = callExpressionAt(current, ref, position);
    if (!call) return candidates;

    const overloads = candidates.filter(
      (candidate) =>
        candidate.kind === SymbolKind.Function ||
        candidate.kind === SymbolKind.Method,
    );

    if (overloads.length <= 1) return candidates;

    const args = callArgumentNodes(call);
    const sameArity = overloads.filter(
      (candidate) => parameterTypes(candidate).length === args.length,
    );

    if (sameArity.length === 0) return candidates;
    if (sameArity.length === 1) return sameArity;

    const argTypes = args.map((arg) =>
      this.expressionTypeName(current, arg, rangeFromNode(arg).start),
    );

    if (argTypes.some((argType) => !argType)) return sameArity;

    const typed = sameArity.filter((candidate) =>
      parameterTypes(candidate).every((paramType, index) =>
        typesCompatible(argTypes[index], paramType),
      ),
    );

    return typed.length > 0 ? typed : sameArity;
  }

  private membersForTypeName(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): C3Symbol[] {
    const normalizedType = normalizeTypeName(typeName);
    if (!normalizedType) return [];

    const typeSymbol = this.resolveTypeSymbol(
      current,
      normalizedType,
      position,
    );
    return typeSymbol?.children ?? [];
  }

  private resolveTypeSymbol(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): C3Symbol | undefined {
    const candidates = typeName.includes('::')
      ? this.qualifiedSymbolCandidates(current, typeName)
      : this.visibleModuleSymbolCandidates(current, typeName);

    return resultFromCandidates(
      candidates.filter((symbol) => isTypeSymbol(symbol)),
    ).selected;
  }

  private rebuildAffectedModules(
    ...moduleNames: Array<string | undefined>
  ): void {
    for (const moduleName of new Set(moduleNames.filter(Boolean))) {
      this.rebuildModule(moduleName);
    }
  }

  private rebuildModule(moduleName: string | undefined): void {
    if (!moduleName) return;

    this.modulesByName.delete(moduleName);

    for (const parsed of this.parsedByUri.values()) {
      if (parsed.moduleName === moduleName) {
        this.addParsedToModule(parsed);
      }
    }
  }

  private addParsedToModule(parsed: ParsedDocument): void {
    if (!parsed.moduleName) return;

    let mod = this.modulesByName.get(parsed.moduleName);

    if (!mod) {
      mod = {
        name: parsed.moduleName,
        files: [],
        symbols: new Map(),
        allSymbols: new Map(),
        imports: new Set(),
        moduleAliases: new Map(),
      };

      this.modulesByName.set(parsed.moduleName, mod);
    }

    mod.files.push(parsed.uri);

    for (const imp of parsed.imports) {
      mod.imports.add(imp);
    }

    for (const alias of parsed.moduleAliases) {
      mod.moduleAliases.set(alias.name, alias.target);
    }

    for (const sym of parsed.symbols) {
      const list = mod.symbols.get(sym.name) ?? [];
      list.push(sym);
      mod.symbols.set(sym.name, list);

      addSymbolRecursive(mod.allSymbols, sym);
    }
  }

  private addReferenceLocation(
    parsed: ParsedDocument,
    ref: SyntaxNode,
    target: C3Symbol,
    locations: Location[],
  ): void {
    if (ref.text !== target.name) return;

    const resolved = this.resolveSymbol(
      parsed.uri,
      ref.text,
      rangeFromNode(ref).start,
    ).selected;

    if (resolved && sameSymbol(resolved, target)) {
      locations.push(Location.create(parsed.uri, rangeFromNode(ref)));
    }
  }

  private addTypeReferenceLocation(
    parsed: ParsedDocument,
    ref: SyntaxNode,
    target: C3Symbol,
    locations: Location[],
  ): void {
    const resolved = this.resolveTypeSymbol(
      parsed,
      ref.text,
      rangeFromNode(ref).start,
    );

    if (resolved && sameSymbol(resolved, target)) {
      locations.push(Location.create(parsed.uri, typeReferenceRange(ref)));
    }
  }
}

function addSymbolRecursive(
  symbols: Map<string, C3Symbol[]>,
  symbol: C3Symbol,
): void {
  const list = symbols.get(symbol.name) ?? [];
  list.push(symbol);
  symbols.set(symbol.name, list);

  for (const child of symbol.children) {
    addSymbolRecursive(symbols, child);
  }
}

function declaredSymbols(parsed: ParsedDocument): C3Symbol[] {
  return [
    ...flattenSymbols(parsed.symbols),
    ...flattenSymbols(parsed.scopedSymbols),
  ];
}

function flattenSymbols(symbols: C3Symbol[]): C3Symbol[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flattenSymbols(symbol.children),
  ]);
}

function findOwnerSymbol(
  current: C3Symbol,
  target: C3Symbol,
): C3Symbol | undefined {
  for (const child of current.children) {
    if (sameSymbol(child, target)) return current;

    const nestedOwner = findOwnerSymbol(child, target);
    if (nestedOwner) return nestedOwner;
  }

  return undefined;
}

function findDeclaredSymbolAt(
  symbols: C3Symbol[],
  ref: string,
  position: Position,
): C3Symbol | undefined {
  for (const symbol of symbols) {
    if (
      symbol.name === ref &&
      positionInRange(position, symbol.selectionRange)
    ) {
      return symbol;
    }

    const child = findDeclaredSymbolAt(symbol.children, ref, position);
    if (child) return child;
  }

  return undefined;
}

function findScopedSymbolAt(
  symbols: C3Symbol[],
  ref: string,
  position: Position,
): C3Symbol | undefined {
  const candidates = findScopedSymbolsAt(symbols, position).filter(
    (symbol) => symbol.name === ref,
  );

  return candidates.sort((a, b) => compareScopedCandidates(a, b, position))[0];
}

function findScopedSymbolsAt(
  symbols: C3Symbol[],
  position: Position,
): C3Symbol[] {
  return symbols
    .filter((symbol) => scopedSymbolVisibleAt(symbol, position))
    .sort((a, b) => compareScopedCandidates(a, b, position));
}

function scopedSymbolVisibleAt(symbol: C3Symbol, position: Position): boolean {
  if (positionInRange(position, symbol.selectionRange)) return true;

  return (
    !!symbol.scopeRange &&
    positionInRange(position, symbol.scopeRange) &&
    comparePositions(symbol.selectionRange.start, position) <= 0
  );
}

function compareScopedCandidates(
  a: C3Symbol,
  b: C3Symbol,
  position: Position,
): number {
  const aExact = positionInRange(position, a.selectionRange) ? 1 : 0;
  const bExact = positionInRange(position, b.selectionRange) ? 1 : 0;

  if (aExact !== bExact) return bExact - aExact;

  const aScopeSize = rangeSize(a.scopeRange ?? a.range);
  const bScopeSize = rangeSize(b.scopeRange ?? b.range);

  if (aScopeSize !== bScopeSize) return aScopeSize - bScopeSize;

  return comparePositions(b.selectionRange.start, a.selectionRange.start);
}

function findUnqualifiedNestedUsageSymbol(
  mod: ModuleIndex | undefined,
  ref: string,
): C3Symbol | undefined {
  return mod?.allSymbols
    .get(ref)
    ?.find((symbol) => symbol.kind === SymbolKind.Constant);
}

function isVisibleFrom(symbol: C3Symbol, moduleName: string): boolean {
  if (symbol.moduleName === moduleName) return true;

  return !symbol.attributes.some(
    (attribute) => attribute.toLowerCase() === '@private',
  );
}

function positionInRange(position: Position, range: Range): boolean {
  return (
    comparePositions(range.start, position) <= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function rangeSize(range: Range): number {
  return (
    (range.end.line - range.start.line) * 1_000_000 +
    range.end.character -
    range.start.character
  );
}

function nodeAtOrBeforePosition(
  root: SyntaxNode,
  position: Position,
): SyntaxNode | null {
  const current = root.descendantForPosition({
    row: position.line,
    column: Math.max(0, position.character),
  });

  if (current.type !== 'source_file') return current;

  if (position.character === 0) return current;

  return root.descendantForPosition({
    row: position.line,
    column: position.character - 1,
  });
}

function nearestExpressionNode(node: SyntaxNode | null): SyntaxNode | undefined {
  let current = node;

  while (current) {
    if (expressionNodeTypes.has(current.type)) return current;
    current = current.parent;
  }

  return undefined;
}

const expressionNodeTypes = new Set([
  'ident_expr',
  'call_expr',
  'field_expr',
  'subscript_expr',
  'paren_expr',
  'unary_expr',
  'cast_expr',
]);

function callExpressionAt(
  current: ParsedDocument,
  ref: string,
  position: Position,
): SyntaxNode | undefined {
  const node = current.tree.rootNode.descendantForPosition({
    row: position.line,
    column: position.character,
  });
  const identExpr = ancestorOfType(node, 'ident_expr');
  if (!identExpr || identExpr.text !== ref) return undefined;

  const call = ancestorOfType(identExpr, 'call_expr');
  if (!call) return undefined;

  const functionNode = call.childForFieldName('function');
  if (
    !functionNode ||
    functionNode.startIndex !== identExpr.startIndex ||
    functionNode.endIndex !== identExpr.endIndex
  ) {
    return undefined;
  }

  return call;
}

function callArgumentNodes(call: SyntaxNode): SyntaxNode[] {
  const args = call.childForFieldName('arguments');
  if (!args) return [];

  return args.namedChildren.flatMap((arg) => {
    if (arg.type !== 'call_arg') return [arg];
    return arg.namedChildren.length > 0 ? [arg.namedChildren.at(-1)!] : [];
  });
}

function parameterTypes(symbol: C3Symbol): string[] {
  const childTypes = symbol.children
    .map((child) => child.returnType)
    .filter((type): type is string => !!type);

  if (childTypes.length > 0) return childTypes;

  return symbol.parameters.flatMap((parameter) => {
    const parts = parameter.trim().split(/\s+/);
    return parts.length > 1 ? [parts.slice(0, -1).join(' ')] : [];
  });
}

function typesCompatible(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) return false;

  return normalizeTypeName(actual) === normalizeTypeName(expected);
}

function literalTypeName(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'integer_literal':
      return 'int';
    case 'real_literal':
      return 'float';
    case 'char_literal':
      return 'char';
    case 'string_literal':
      return 'String';
    case 'true':
    case 'false':
    case 'boolean_literal':
      return 'bool';
    default:
      return undefined;
  }
}

function resultFromCandidates(candidates: C3Symbol[]): ResolveResult {
  const orderedCandidates = [...candidates].sort(compareSymbols);

  if (orderedCandidates.length === 0) {
    return { candidates: [], reason: 'not_found' };
  }

  if (orderedCandidates.length === 1) {
    return {
      selected: orderedCandidates[0],
      candidates: orderedCandidates,
      reason: 'resolved',
    };
  }

  return {
    candidates: orderedCandidates,
    reason: 'ambiguous',
  };
}

function compareSymbols(a: C3Symbol, b: C3Symbol): number {
  return (
    a.moduleName.localeCompare(b.moduleName) ||
    a.name.localeCompare(b.name) ||
    a.uri.localeCompare(b.uri) ||
    comparePositions(a.selectionRange.start, b.selectionRange.start)
  );
}

function symbolLocation(symbol: C3Symbol): Location {
  return Location.create(symbol.uri, symbol.selectionRange);
}

function sameSymbol(a: C3Symbol, b: C3Symbol): boolean {
  return a.uri === b.uri && sameRange(a.selectionRange, b.selectionRange);
}

function sameRange(a: Range, b: Range): boolean {
  return (
    comparePositions(a.start, b.start) === 0 &&
    comparePositions(a.end, b.end) === 0
  );
}

function uniqueLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const unique: Location[] = [];

  for (const location of locations) {
    const key = [
      location.uri,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
    ].join(':');

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(location);
  }

  return unique;
}

function compareLocations(a: Location, b: Location): number {
  return (
    a.uri.localeCompare(b.uri) || comparePositions(a.range.start, b.range.start)
  );
}

function fieldExpressionAt(
  parsed: ParsedDocument,
  ref: string,
  position: Position,
): SyntaxNode | undefined {
  const node = parsed.tree.rootNode.descendantForPosition({
    row: position.line,
    column: position.character,
  });
  const fieldNode = ancestorOfType(node, 'access_ident');

  if (!fieldNode || fieldNode.text !== ref) return undefined;

  const fieldExpr = ancestorOfType(fieldNode, 'field_expr');
  if (!fieldExpr) return undefined;

  const field = fieldExpr.childForFieldName('field');
  if (
    !field ||
    field.startIndex !== fieldNode.startIndex ||
    field.endIndex !== fieldNode.endIndex
  ) {
    return undefined;
  }

  return fieldExpr;
}

function ancestorOfType(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | undefined {
  let current = node;

  while (current) {
    if (current.type === type) return current;
    current = current.parent;
  }

  return undefined;
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

function typeReferenceRange(node: SyntaxNode): Range {
  const typeName = lastDescendantOfTypes(node, ['type_ident', 'ident']);
  return typeName ? rangeFromNode(typeName) : rangeFromNode(node);
}

function splitMemberExpression(expressionText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < expressionText.length; index++) {
    const char = expressionText[index];

    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth--;

    if (char === '.' && depth === 0) {
      const part = expressionText.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }

  const tail = expressionText.slice(start).trim();
  if (tail) parts.push(tail);

  return parts;
}

function parseMemberSegment(
  segment: string,
): { name: string; indexed: boolean } | undefined {
  const text = segment.trim();
  const call = splitCallExpression(text);
  const indexed = !!splitTrailingSubscript(call?.functionRef ?? text);
  const base = splitTrailingSubscript(call?.functionRef ?? text)?.base ?? text;
  const name = base.match(/^[A-Za-z_$@][A-Za-z0-9_$@]*/)?.[0];

  return name ? { name, indexed } : undefined;
}

function splitTrailingSubscript(
  text: string,
): { base: string; indexText: string } | undefined {
  if (!text.endsWith(']')) return undefined;

  let depth = 0;

  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];

    if (char === ']') depth++;
    if (char === '[') depth--;

    if (char === '[' && depth === 0) {
      return {
        base: text.slice(0, index).trim(),
        indexText: text.slice(index + 1, -1),
      };
    }
  }

  return undefined;
}

function splitCallExpression(
  text: string,
): { functionRef: string; argsText: string } | undefined {
  if (!text.endsWith(')')) return undefined;

  let depth = 0;

  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];

    if (char === ')') depth++;
    if (char === '(') depth--;

    if (char === '(' && depth === 0) {
      const functionRef = text.slice(0, index).trim();
      if (!functionRef) return undefined;

      return {
        functionRef,
        argsText: text.slice(index + 1, -1),
      };
    }
  }

  return undefined;
}

function stripOuterParens(text: string): string {
  let current = text;

  while (
    current.startsWith('(') &&
    current.endsWith(')') &&
    matchingOuterParens(current)
  ) {
    current = current.slice(1, -1).trim();
  }

  return current;
}

function matchingOuterParens(text: string): boolean {
  let depth = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === '(') depth++;
    if (char === ')') depth--;

    if (depth === 0 && index < text.length - 1) return false;
  }

  return depth === 0;
}

function isReferenceText(text: string): boolean {
  return /^[A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)*$/.test(
    text,
  );
}

function recoverableLocalTypeName(
  current: ParsedDocument,
  ref: string,
  position: Position,
): string | undefined {
  if (!/^[A-Za-z_$@][A-Za-z0-9_$@]*$/.test(ref)) return undefined;

  const offset = offsetAt(current.source, position);
  const before = current.source.slice(0, offset);
  const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    String.raw`\b([A-Za-z_$@][A-Za-z0-9_$@]*(?:::[A-Za-z_$@][A-Za-z0-9_$@]*)?(?:\s*(?:\[[^\]]*\]|[*!?~]))*)\s+${escapedRef}\b`,
    'g',
  );
  let match: RegExpExecArray | null;
  let found: string | undefined;

  while ((match = declaration.exec(before))) {
    found = match[1].trim();
  }

  return found;
}

function offsetAt(source: string, position: Position): number {
  let line = 0;
  let character = 0;

  for (let index = 0; index < source.length; index++) {
    if (line === position.line && character === position.character) {
      return index;
    }

    if (source[index] === '\n') {
      line++;
      character = 0;
      continue;
    }

    character++;
  }

  return source.length;
}

function elementTypeName(typeName: string): string {
  return normalizeTypeName(typeName);
}

function normalizeTypeName(typeName: string): string {
  return typeName
    .replace(/\b(?:const|volatile)\s+/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[*!?~]+/g, '')
    .trim();
}

function symbolTypeName(symbol: C3Symbol | undefined): string | undefined {
  if (!symbol) return undefined;

  if (isTypeSymbol(symbol)) {
    return symbol.name;
  }

  return undefined;
}

function isTypeSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Struct ||
    symbol.kind === SymbolKind.Enum ||
    symbol.kind === SymbolKind.Interface
  );
}

function referenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'ident_expr') {
      refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function memberReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'field_expr') {
      const field = node.childForFieldName('field');
      if (field) refs.push(field);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function typeReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'path_type_ident') {
      refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function lastDescendantOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;

  function visit(current: SyntaxNode): void {
    if (types.includes(current.type)) {
      found = current;
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return found;
}

```

## File: shared/types.ts

- Extension: .ts
- Language: typescript
- Size: 1381 bytes
- Created: 2026-04-25 19:21:55
- Modified: 2026-04-25 19:21:55

### Code

```typescript
import type { Tree } from 'tree-sitter';
import type {
  Diagnostic,
  Range,
  SymbolKind,
} from 'vscode-languageserver/node.js';

export type C3Symbol = {
  name: string;
  moduleName: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  bodyRange?: Range;
  signature: string;
  documentation?: string;
  attributes: string[];
  returnType?: string;
  parameters: string[];
  scopeRange?: Range;
  children: C3Symbol[];
};

export type C3Import = {
  path: string;
  range: Range;
  selectionRange: Range;
  attributes: string[];
};

export type C3ModuleAlias = {
  name: string;
  target: string;
  range: Range;
  selectionRange: Range;
  targetRange: Range;
};

export type ModuleIndex = {
  name: string;
  files: string[];
  symbols: Map<string, C3Symbol[]>;
  allSymbols: Map<string, C3Symbol[]>;
  imports: Set<string>;
  moduleAliases: Map<string, string>;
};

export type SourceKind = 'workspace' | 'stdlib';

export type ParsedDocument = {
  uri: string;
  source: string;
  sourceKind: SourceKind;
  tree: Tree;
  symbols: C3Symbol[];
  scopedSymbols: C3Symbol[];
  moduleName: string;
  imports: string[];
  importSpecs: C3Import[];
  moduleAliases: C3ModuleAlias[];
  diagnostics: Diagnostic[];
};

export type ResolveResult = {
  selected?: C3Symbol;
  candidates: C3Symbol[];
  reason: 'resolved' | 'not_found' | 'ambiguous';
};

```

## File: tools/debug-tree.ts

- Extension: .ts
- Language: typescript
- Size: 585 bytes
- Created: 2026-04-25 12:19:44
- Modified: 2026-04-25 12:19:44

### Code

```typescript
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';

const file = process.argv[2] ?? 'testdata/simple/main.c3';
const source = fs.readFileSync(file, 'utf8');
const parsed = parseSource(pathToFileURL(file).toString(), source);
const root = parsed.tree.rootNode;

console.log(root.toString());

console.log('\n=== top level nodes ===');

for (let i = 0; i < root.namedChildCount; i++) {
  const node = root.namedChild(i);
  if (!node) continue;

  console.log(`${i}: ${node.type} => ${node.text.split('\n')[0]}`);
}

```

## File: tools/debug-symbols.ts

- Extension: .ts
- Language: typescript
- Size: 466 bytes
- Created: 2026-04-25 12:19:44
- Modified: 2026-04-25 12:19:44

### Code

```typescript
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';

const file = process.argv[2] ?? 'testdata/simple/main.c3';
const source = fs.readFileSync(file, 'utf8');
const parsed = parseSource(pathToFileURL(file).toString(), source);

console.log('module:', parsed.moduleName);
console.log('symbols:');

for (const symbol of parsed.symbols) {
  console.log(`  ${symbol.name} => ${symbol.signature}`);
}

```

## File: workspace/scan.ts

- Extension: .ts
- Language: typescript
- Size: 2182 bytes
- Created: 2026-04-25 19:22:15
- Modified: 2026-04-25 19:22:15

### Code

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSource } from '../parser/c3-parser.js';
import type { ProjectIndex } from '../project/project-index.js';
import type { SourceKind } from '../shared/types.js';

type WorkspaceScanReporter = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WorkspaceScanOptions = {
  rebuild?: boolean;
  sourceKind?: SourceKind;
};

const c3Extensions = new Set(['.c3', '.c3i', '.c3t']);
export const skippedDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.zig-cache',
]);

export function scanWorkspace(
  root: string,
  index: ProjectIndex,
  reporter: WorkspaceScanReporter = {},
  options: WorkspaceScanOptions = {},
): number {
  const files = collectC3Files(root);
  const sourceKind = options.sourceKind ?? 'workspace';

  reporter.log?.(`found ${files.length} ${sourceKind} C3 files`);

  for (const file of files) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      const uri = pathToFileURL(file).toString();

      index.upsert(parseSource(uri, source, { sourceKind }), false);
    } catch (err) {
      reporter.error?.(`failed to parse ${file}: ${String(err)}`);
    }
  }

  if (options.rebuild ?? true) {
    index.rebuild();
    reporter.log?.(`indexed ${index.moduleCount()} modules`);
  }

  return files.length;
}

export function collectC3Files(root: string): string[] {
  const result: string[] = [];

  function walkDir(dir: string): void {
    const base = path.basename(dir);

    if (skippedDirectories.has(base)) {
      return;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(full);
        continue;
      }

      if (entry.isFile() && isC3SourceFile(full)) {
        result.push(full);
      }
    }
  }

  walkDir(root);
  return result;
}

export function isC3SourceFile(file: string): boolean {
  return c3Extensions.has(path.extname(file));
}

```

## File: workspace/watch.ts

- Extension: .ts
- Language: typescript
- Size: 3566 bytes
- Created: 2026-04-25 17:56:54
- Modified: 2026-04-25 17:56:54

### Code

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectC3Files, isC3SourceFile, skippedDirectories } from './scan.js';

type WorkspaceWatchReporter = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WorkspaceWatcher = {
  close(): void;
};

export type WorkspaceWatchHandlers = {
  change(uri: string): void;
  delete(uri: string): void;
};

export function watchWorkspace(
  root: string,
  handlers: WorkspaceWatchHandlers,
  reporter: WorkspaceWatchReporter = {},
): WorkspaceWatcher {
  let watcher: fs.FSWatcher;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      const filePath = path.resolve(root, filename.toString());
      if (!shouldHandlePath(filePath)) return;

      scheduleFileEvent(filePath, handlers, pending);
    });
  } catch (err) {
    reporter.error?.(
      `failed to watch workspace ${root}: ${String(err)}; falling back to polling`,
    );
    return pollWorkspace(root, handlers, reporter);
  }

  watcher.on('error', (err) => {
    reporter.error?.(`workspace watcher error: ${String(err)}`);
  });

  reporter.log?.(`watching C3 files in ${root}`);

  return {
    close() {
      for (const timeout of pending.values()) {
        clearTimeout(timeout);
      }

      pending.clear();
      watcher.close();
    },
  };
}

function pollWorkspace(
  root: string,
  handlers: WorkspaceWatchHandlers,
  reporter: WorkspaceWatchReporter,
): WorkspaceWatcher {
  let previous = snapshotC3Files(root);

  const interval = setInterval(() => {
    const current = snapshotC3Files(root);

    for (const [filePath, mtimeMs] of current) {
      if (previous.get(filePath) !== mtimeMs) {
        handlers.change(pathToFileURL(filePath).toString());
      }
    }

    for (const filePath of previous.keys()) {
      if (!current.has(filePath)) {
        handlers.delete(pathToFileURL(filePath).toString());
      }
    }

    previous = current;
  }, 1_500);

  reporter.log?.(`polling C3 files in ${root}`);

  return {
    close() {
      clearInterval(interval);
    },
  };
}

function snapshotC3Files(root: string): Map<string, number> {
  const snapshot = new Map<string, number>();

  for (const filePath of collectC3Files(root)) {
    try {
      snapshot.set(filePath, fs.statSync(filePath).mtimeMs);
    } catch {
      // Ignore files that disappear during the scan.
    }
  }

  return snapshot;
}

function scheduleFileEvent(
  filePath: string,
  handlers: WorkspaceWatchHandlers,
  pending: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const previous = pending.get(filePath);

  if (previous) {
    clearTimeout(previous);
  }

  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      handleFileEvent(filePath, handlers);
    }, 75),
  );
}

function handleFileEvent(
  filePath: string,
  handlers: WorkspaceWatchHandlers,
): void {
  const uri = pathToFileURL(filePath).toString();

  try {
    if (!fs.existsSync(filePath)) {
      handlers.delete(uri);
      return;
    }

    const stat = fs.statSync(filePath);

    if (stat.isFile()) {
      handlers.change(uri);
    }
  } catch {
    handlers.delete(uri);
  }
}

function shouldHandlePath(filePath: string): boolean {
  if (!isC3SourceFile(filePath)) return false;

  const parts = path.normalize(filePath).split(path.sep);
  return !parts.some((part) => skippedDirectories.has(part));
}

```

## File: analysis/diagnostics.ts

- Extension: .ts
- Language: typescript
- Size: 3476 bytes
- Created: 2026-04-25 18:42:02
- Modified: 2026-04-25 18:42:02

### Code

```typescript
import {
  DiagnosticSeverity,
  Range,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import type { SyntaxNode } from 'tree-sitter';

import type { ProjectIndex } from '../project/project-index.js';
import type { ParsedDocument } from '../shared/types.js';

const diagnosticSource = 'c3-lsp';

export function semanticDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return [
    ...unresolvedImportDiagnostics(index, parsed),
    ...unresolvedModuleAliasDiagnostics(index, parsed),
    ...referenceDiagnostics(index, parsed),
  ];
}

function unresolvedImportDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.importSpecs
    .filter((imp) => !index.resolveImportedModule(parsed, imp.path))
    .map((imp) => ({
      severity: DiagnosticSeverity.Error,
      range: imp.selectionRange,
      message: `Unresolved import '${imp.path}'`,
      source: diagnosticSource,
    }));
}

function unresolvedModuleAliasDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  return parsed.moduleAliases
    .filter((alias) => !index.resolveImportedModule(parsed, alias.target))
    .map((alias) => ({
      severity: DiagnosticSeverity.Error,
      range: alias.targetRange,
      message: `Unresolved module alias target '${alias.target}'`,
      source: diagnosticSource,
    }));
}

function referenceDiagnostics(
  index: ProjectIndex,
  parsed: ParsedDocument,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const ref of referenceNodes(parsed.tree.rootNode)) {
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  for (const ref of memberReferenceNodes(parsed.tree.rootNode)) {
    pushReferenceDiagnostic(index, parsed, ref, diagnostics);
  }

  return diagnostics;
}

function pushReferenceDiagnostic(
  index: ProjectIndex,
  parsed: ParsedDocument,
  ref: SyntaxNode,
  diagnostics: Diagnostic[],
): void {
  const result = index.resolveSymbol(
    parsed.uri,
    ref.text,
    rangeFromNode(ref).start,
  );

  if (result.reason === 'not_found') {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: `Unresolved symbol '${ref.text}'`,
      source: diagnosticSource,
    });
  }

  if (result.reason === 'ambiguous') {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeFromNode(ref),
      message: `Ambiguous symbol '${ref.text}' (${result.candidates.length} candidates)`,
      source: diagnosticSource,
    });
  }
}

function referenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'ident_expr') {
      refs.push(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function memberReferenceNodes(root: SyntaxNode): SyntaxNode[] {
  const refs: SyntaxNode[] = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'field_expr') {
      const field = node.childForFieldName('field');
      if (field) refs.push(field);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return refs;
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

```

