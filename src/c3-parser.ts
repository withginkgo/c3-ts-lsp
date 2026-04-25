import Parser, { SyntaxNode } from 'tree-sitter';
import C3 from 'tree-sitter-c3/bindings/node/index.js';
import { Position, Range, SymbolKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { C3Symbol, ParsedDocument } from './types.js';

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

export function parseSource(uri: string, source: string): ParsedDocument {
  const doc = TextDocument.create(uri, 'c3', 0, source);
  const tree = parser.parse(source);

  const moduleName = extractModuleName(tree.rootNode);
  const imports = extractImports(tree.rootNode);
  const symbols = extractTopLevelSymbols(doc, tree.rootNode, moduleName);

  return {
    uri,
    tree,
    symbols,
    moduleName,
    imports,
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

function extractImports(root: SyntaxNode): string[] {
  const imports: string[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;

    if (child.type !== 'import_declaration') continue;

    const importPath = findFirstDescendantOfType(child, 'import_path');

    if (importPath) {
      imports.push(importPath.text);
    }
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
    case 'func_definition':
      return SymbolKind.Function;

    case 'struct_declaration':
      return SymbolKind.Struct;

    case 'enum_declaration':
      return SymbolKind.Enum;

    case 'interface_declaration':
      return SymbolKind.Interface;

    case 'faultdef_declaration':
      return SymbolKind.Constant;

    case 'constdef_declaration':
      return SymbolKind.Constant;

    case 'global_declaration':
      return SymbolKind.Variable;

    case 'macro_declaration':
      return SymbolKind.Function;

    default:
      return null;
  }
}

function extractNameNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'func_definition') {
    const header = findFirstDescendantOfType(node, 'func_header');
    if (!header) return null;

    const name = header.childForFieldName('name');
    if (name) return name;

    return findFirstDescendantOfTypes(header, ['ident']);
  }

  if (node.type === 'struct_declaration') {
    const name = node.childForFieldName('name');
    if (name) return name;

    return findFirstDescendantOfTypes(node, ['type_ident']);
  }

  if (node.type === 'enum_declaration') {
    const name = node.childForFieldName('name');
    if (name) return name;

    return findFirstDescendantOfTypes(node, ['type_ident']);
  }

  if (node.type === 'interface_declaration') {
    const name = node.childForFieldName('name');
    if (name) return name;

    return findFirstDescendantOfTypes(node, ['type_ident']);
  }

  if (node.type === 'faultdef_declaration') {
    return findFirstDescendantOfTypes(node, ['const_ident', 'ident']);
  }

  const byField = node.childForFieldName('name');
  if (byField) return byField;

  return findFirstDescendantOfTypes(node, [
    'ident',
    'type_ident',
    'const_ident',
    'at_ident',
    'ct_ident',
    'ct_type_ident',
    'ct_const_ident',
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

function rangeFromNode(node: SyntaxNode): Range {
  return Range.create(
    Position.create(node.startPosition.row, node.startPosition.column),
    Position.create(node.endPosition.row, node.endPosition.column),
  );
}

function compactSignature(node: SyntaxNode): string {
  if (node.type === 'func_definition') {
    const header = findFirstDescendantOfType(node, 'func_header');
    const params = findFirstDescendantOfType(node, 'func_param_list');

    if (header && params) {
      return `${header.text}${params.text}`;
    }

    const braceIndex = node.text.indexOf('{');
    if (braceIndex >= 0) {
      return node.text.slice(0, braceIndex).trim();
    }
  }

  if (
    node.type === 'struct_declaration' ||
    node.type === 'enum_declaration' ||
    node.type === 'interface_declaration'
  ) {
    const braceIndex = node.text.indexOf('{');
    if (braceIndex >= 0) {
      return node.text.slice(0, braceIndex).trim();
    }
  }

  const text = node.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  if (text.length <= 160) return text;
  return text.slice(0, 157) + '...';
}
