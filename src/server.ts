#!/usr/bin/env node

import Parser, { SyntaxNode, Tree } from "tree-sitter";
import C3 from "tree-sitter-c3/bindings/node/index.js";

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DocumentSymbol,
  SymbolKind,
  Range,
  Hover,
  MarkupKind,
  Location,
  CompletionItem,
  CompletionItemKind,
  Position,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

type C3Symbol = {
  name: string;
  moduleName: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  selectionRange: Range;
  signature: string;
};

type ModuleIndex = {
  uri: string;
  symbols: C3Symbol[];
  moduleName: string;
  imports: Set<string>;
};

type ParsedDocument = ModuleIndex & {
  tree: Tree;
};

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

const hasTransportArg = process.argv.slice(2).some((arg) => {
  return (
    arg === "--node-ipc" ||
    arg === "--stdio" ||
    arg === "--socket" ||
    arg.startsWith("--socket=") ||
    arg === "--pipe" ||
    arg.startsWith("--pipe=")
  );
});

const connection = hasTransportArg
  ? createConnection(ProposedFeatures.all)
  : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

const parsedByUri = new Map<string, ParsedDocument>();
const symbolsByName = new Map<string, C3Symbol[]>();
const modulesByName = new Map<string, ModuleIndex>();

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      completionProvider: {
        triggerCharacters: [":", "."],
      },
    },
  };
});

documents.onDidOpen((event) => {
  parseAndIndex(event.document);
});

documents.onDidChangeContent((event) => {
  parseAndIndex(event.document);
});

documents.onDidClose((event) => {
  parsedByUri.delete(event.document.uri);
  rebuildGlobalIndex();
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const parsed = parsedByUri.get(params.textDocument.uri);
  if (!parsed) return [];

  return parsed.symbols.map((s) => ({
    name: s.name,
    detail: s.signature,
    kind: s.kind,
    range: s.range,
    selectionRange: s.selectionRange,
  }));
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const sym = findSymbol(params.textDocument.uri, word);
  if (!sym) return null;

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: [
        "```c3",
        sym.signature,
        "```",
        "",
        `module: \`${sym.moduleName || "<unknown>"}\``,
      ].join("\n"),
    },
  };
});

connection.onDefinition((params): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const word = wordAtPosition(doc, params.position);
  if (!word) return null;

  const sym = findSymbol(params.textDocument.uri, word);
  if (!sym) return null;

  return Location.create(sym.uri, sym.selectionRange);
});

connection.onCompletion((params): CompletionItem[] => {
  const parsed = parsedByUri.get(params.textDocument.uri);
  const localSymbols = parsed?.symbols ?? [];

  const keywords = [
    "module",
    "import",
    "fn",
    "struct",
    "union",
    "enum",
    "interface",
    "macro",
    "fault",
    "faultdef",
    "typedef",
    "alias",
    "const",
    "return",
    "defer",
    "catch",
    "if",
    "else",
    "while",
    "foreach",
    "switch",
    "@pool",
    "@dynamic",
  ];

  const keywordItems: CompletionItem[] = keywords.map((kw) => ({
    label: kw,
    kind: CompletionItemKind.Keyword,
  }));

  const symbolItems: CompletionItem[] = localSymbols.map((s) => ({
    label: s.name,
    kind: toCompletionKind(s.kind),
    detail: s.signature,
  }));

  return [...keywordItems, ...symbolItems];
});

function parseAndIndex(doc: TextDocument): void {
  const source = doc.getText();
  const tree = parser.parse(source);

  const moduleName = extractModuleName(tree.rootNode);
  const imports = extractImports(tree.rootNode);
  const symbols = extractTopLevelSymbols(doc, tree.rootNode, moduleName);

  parsedByUri.set(doc.uri, {
    uri: doc.uri,
    tree,
    symbols,
    moduleName,
    imports,
  });

  rebuildGlobalIndex();

  connection.console.log(
    `indexed ${doc.uri}: module=${moduleName}, symbols=${symbols.length}`,
  );
}

function extractModuleName(root: SyntaxNode): string {
  const moduleDecl = root.namedChildren.find(
    (child) => child.type === "module_declaration",
  );

  if (!moduleDecl) return "";

  const path = moduleDecl.childForFieldName("path");
  return path?.text ?? "";
}

function extractImports(root: SyntaxNode): Set<string> {
  const imports = new Set<string>();

  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child || child.type !== "import_declaration") continue;

    const importPath = findFirstDescendantOfType(child, "import_path");
    const importName = importPath?.text.trim();
    if (importName) imports.add(importName);
  }

  return imports;
}

function extractTopLevelSymbols(
  doc: TextDocument,
  root: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    const kind = symbolKindForNode(node);
    if (!kind) continue;

    const nameNode = extractNameNode(node);
    if (!nameNode) continue;

    symbols.push({
      name: nameNode.text,
      moduleName,
      kind,
      uri: doc.uri,
      range: rangeFromNode(node),
      selectionRange: rangeFromNode(nameNode),
      signature: compactSignature(node),
    });
  }

  return symbols;
}

function symbolKindForNode(node: SyntaxNode): SymbolKind | null {
  switch (node.type) {
    case "func_definition":
      return SymbolKind.Function;

    case "struct_declaration":
      return SymbolKind.Struct;

    case "enum_declaration":
      return SymbolKind.Enum;

    case "interface_declaration":
      return SymbolKind.Interface;

    case "faultdef_declaration":
      return SymbolKind.Constant;

    case "constdef_declaration":
      return SymbolKind.Constant;

    case "global_declaration":
      return SymbolKind.Variable;

    case "macro_declaration":
      return SymbolKind.Function;

    default:
      return null;
  }
}

function extractNameNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "func_definition") {
    const header = findFirstDescendantOfType(node, "func_header");
    if (!header) return null;

    const name = header.childForFieldName("name");
    if (name) return name;

    return findFirstDescendantOfTypes(header, ["ident"]);
  }

  if (node.type === "struct_declaration") {
    const name = node.childForFieldName("name");
    if (name) return name;

    return findFirstDescendantOfTypes(node, ["type_ident"]);
  }

  if (node.type === "enum_declaration") {
    const name = node.childForFieldName("name");
    if (name) return name;

    return findFirstDescendantOfTypes(node, ["type_ident"]);
  }

  if (node.type === "interface_declaration") {
    const name = node.childForFieldName("name");
    if (name) return name;

    return findFirstDescendantOfTypes(node, ["type_ident"]);
  }

  if (node.type === "faultdef_declaration") {
    return findFirstDescendantOfTypes(node, ["const_ident", "ident"]);
  }

  const byField = node.childForFieldName("name");
  if (byField) return byField;

  return findFirstDescendantOfTypes(node, [
    "ident",
    "type_ident",
    "const_ident",
    "at_ident",
    "ct_ident",
    "ct_type_ident",
    "ct_const_ident",
  ]);
}

function findFirstDescendantOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | null {
  if (node.type === type) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const found = findFirstDescendantOfType(child, type);
    if (found) return found;
  }

  return null;
}

function findFirstDescendantOfTypes(
  node: SyntaxNode,
  types: string[],
): SyntaxNode | null {
  if (types.includes(node.type)) return node;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const found = findFirstDescendantOfTypes(child, types);
    if (found) return found;
  }

  return null;
}

function rebuildGlobalIndex(): void {
  symbolsByName.clear();
  modulesByName.clear();

  for (const parsed of parsedByUri.values()) {
    if (parsed.moduleName) {
      modulesByName.set(parsed.moduleName, {
        uri: parsed.uri,
        symbols: parsed.symbols,
        moduleName: parsed.moduleName,
        imports: parsed.imports,
      });
    }

    for (const sym of parsed.symbols) {
      const arr = symbolsByName.get(sym.name) ?? [];
      arr.push(sym);
      symbolsByName.set(sym.name, arr);
    }
  }
}

function findSymbol(currentUri: string, name: string): C3Symbol | undefined {
  const current = parsedByUri.get(currentUri);

  const local = current?.symbols.find((s) => s.name === name);
  if (local) return local;

  const global = symbolsByName.get(name);
  return global?.[0];
}

function wordAtPosition(doc: TextDocument, position: Position): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_.$@]/.test(ch);

  let start = offset;
  while (start > 0 && isIdentChar(text[start - 1])) {
    start--;
  }

  let end = offset;
  while (end < text.length && isIdentChar(text[end])) {
    end++;
  }

  const word = text.slice(start, end);

  if (!/^[A-Za-z_$@][A-Za-z0-9_$@]*$/.test(word)) {
    return null;
  }

  return word;
}

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    Position.create(node.startPosition.row, node.startPosition.column),
    Position.create(node.endPosition.row, node.endPosition.column),
  );
}

function compactSignature(node: SyntaxNode): string {
  if (node.type === "func_definition") {
    const header = findFirstDescendantOfType(node, "func_header");
    const params = findFirstDescendantOfType(node, "func_param_list");

    if (header && params) {
      return `${header.text}${params.text}`;
    }

    const braceIndex = node.text.indexOf("{");
    if (braceIndex >= 0) {
      return node.text.slice(0, braceIndex).trim();
    }
  }

  if (
    node.type === "struct_declaration" ||
    node.type === "enum_declaration" ||
    node.type === "interface_declaration"
  ) {
    const braceIndex = node.text.indexOf("{");
    if (braceIndex >= 0) {
      return node.text.slice(0, braceIndex).trim();
    }
  }

  const text = node.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  if (text.length <= 160) return text;
  return text.slice(0, 157) + "...";
}

function toCompletionKind(kind: SymbolKind): CompletionItemKind {
  switch (kind) {
    case SymbolKind.Function:
      return CompletionItemKind.Function;
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

// function walk(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
//   fn(node);

//   for (let i = 0; i < node.namedChildCount; i++) {
//     const child = node.namedChild(i);
//     if (child) walk(child, fn);
//   }
// }

documents.listen(connection);
connection.listen();
