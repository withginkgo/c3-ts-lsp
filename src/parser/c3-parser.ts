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
} from '../shared/types.js';

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

const commentTypes = new Set(['doc_comment', 'block_comment', 'line_comment']);

export function parseSource(uri: string, source: string): ParsedDocument {
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
