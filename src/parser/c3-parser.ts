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
  C3Contract,
  C3ModuleAlias,
  C3Parameter,
  C3Symbol,
  C3TypeDeclarationInfo,
  ParsedDocument,
  SourceKind,
} from '../shared/types.js';
import { parameterDetailFromLabel } from '../shared/callable.js';

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
  const moduleAttributes = extractModuleAttributes(tree.rootNode);
  const importSpecs = extractImportSpecs(tree.rootNode);
  const imports = importSpecs.map((imp) => imp.path);
  const moduleAliases = extractModuleAliases(doc, tree.rootNode);
  const moduleGenericParameterCount = moduleGenericParameters(
    tree.rootNode,
  ).length;
  const parsedSymbols = extractTopLevelSymbols(
    doc,
    tree.rootNode,
    moduleName,
    moduleGenericParameterCount,
  );
  const symbols = tree.rootNode.hasError
    ? mergeRecoveredSymbols(parsedSymbols, [
        ...recoverTopLevelAggregateSymbols(
          doc,
          source,
          moduleName,
          moduleGenericParameterCount,
        ),
        ...recoverTopLevelTypeAliasSymbols(
          doc,
          source,
          moduleName,
          moduleGenericParameterCount,
        ),
        ...recoverTopLevelCallableSymbols(doc, source, moduleName),
      ])
    : parsedSymbols;
  const scopedSymbols = extractScopedSymbols(doc, tree.rootNode, moduleName);
  const diagnostics = collectSyntaxDiagnostics(doc, tree.rootNode);

  return {
    uri,
    source,
    sourceKind: options.sourceKind ?? 'workspace',
    tree,
    symbols,
    scopedSymbols,
    moduleName,
    moduleAttributes,
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

function moduleGenericParameters(root: SyntaxNode): string[] {
  const moduleDecl = root.namedChildren.find(
    (child) => child.type === 'module_declaration',
  );

  return moduleDecl ? genericParameterNames(moduleDecl) : [];
}

function extractModuleAttributes(root: SyntaxNode): string[] {
  const moduleDecl = root.namedChildren.find(
    (child) => child.type === 'module_declaration',
  );

  return moduleDecl ? attributesFor(moduleDecl) : [];
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
  moduleGenericParameterCount: number,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const node of root.namedChildren) {
    symbols.push(
      ...topLevelSymbolsForNode(
        doc,
        node,
        moduleName,
        moduleGenericParameterCount,
      ),
    );
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
  const recoveredBody =
    !body && node.nextNamedSibling?.type === 'ERROR'
      ? node.nextNamedSibling
      : undefined;
  const scopeRange = rangeFromNode(body ?? recoveredBody ?? node);
  const receiverType = receiverTypeForCallable(node);
  const localScope = body ?? recoveredBody;

  return [
    ...parameterSymbols(doc, node, moduleName, scopeRange, receiverType),
    ...(localScope
      ? localDeclarationSymbols(doc, localScope, moduleName, {
          inMacro: node.type === 'macro_declaration',
        })
      : []),
  ];
}

function topLevelSymbolsForNode(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  moduleGenericParameterCount: number,
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
          moduleGenericParameterCount,
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
          moduleGenericParameterCount,
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
          moduleGenericParameterCount,
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
          moduleGenericParameterCount,
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
          moduleGenericParameterCount,
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
          moduleGenericParameterCount,
        ),
      ]);

    case 'typedef_declaration':
      return compact([
        simpleDeclarationSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.TypeParameter,
          moduleGenericParameterCount,
        ),
      ]);

    case 'attrdef_declaration':
      return compact([
        simpleDeclarationSymbol(
          doc,
          node,
          moduleName,
          SymbolKind.Property,
          0,
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
  moduleGenericParameterCount = 0,
): C3Symbol | null {
  const nameNode = extractNameNode(node);
  if (!nameNode) return null;

  return createSymbol(doc, node, nameNode, moduleName, kind, {
    bodyNode: node.childForFieldName('body') ?? undefined,
    children,
    implementedInterfaces: implementedInterfacesFor(node),
    signature: declarationSignature(node),
    typeInfo: typeDeclarationInfo(
      doc,
      node,
      nameNode,
      typeDeclarationKindForNode(node),
      moduleGenericParameterCount,
    ),
  });
}

function simpleDeclarationSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  moduleGenericParameterCount = 0,
  children: C3Symbol[] = [],
): C3Symbol | null {
  const nameNode = extractNameNode(node);
  if (!nameNode) return null;

  const declarationKind = typeDeclarationKindForNode(node);

  return createSymbol(doc, node, nameNode, moduleName, kind, {
    children,
    signature: declarationSignature(node),
    returnType:
      node.childForFieldName('type')?.text ??
      directChildOfType(node, 'type')?.text,
    typeInfo:
      declarationKind === 'alias' || declarationKind === 'typedef'
        ? typeDeclarationInfo(
            doc,
            node,
            nameNode,
            declarationKind,
            moduleGenericParameterCount,
          )
        : undefined,
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
  if (header?.hasError) return null;

  const nameNode = header?.childForFieldName('name') ?? extractNameNode(node);
  if (!nameNode) return null;

  const receiverType = receiverTypeForCallable(node);

  return createSymbol(doc, rangeNode, nameNode, moduleName, kind, {
    kind: receiverType ? SymbolKind.Method : kind,
    bodyNode: node.childForFieldName('body') ?? undefined,
    children: parameterSymbols(doc, node, moduleName, undefined, receiverType),
    parameters: parameterSignatures(node),
    parameterDetails: parameterDetails(node, receiverType),
    genericParameterCount: genericParameterNames(node).length,
    returnType: header?.childForFieldName('return_type')?.text,
    receiverType,
    signature: callableSignature(node, 'func_header', 'func_param_list'),
    attributes: attributesFor(node),
  });
}

function macroSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  moduleName: string,
): C3Symbol | null {
  const header = directChildOfType(node, 'macro_header');
  if (header?.hasError) return null;

  const nameNode = header?.childForFieldName('name') ?? extractNameNode(node);
  if (!nameNode) return null;

  const receiverType = receiverTypeForCallable(node);
  const macroBody = macroBodyParameter(node);

  return createSymbol(doc, node, nameNode, moduleName, SymbolKind.Function, {
    kind: receiverType ? SymbolKind.Method : SymbolKind.Function,
    bodyNode: node.childForFieldName('body') ?? undefined,
    children: parameterSymbols(doc, node, moduleName, undefined, receiverType),
    parameters: parameterSignatures(node),
    parameterDetails: parameterDetails(node, receiverType),
    genericParameterCount: genericParameterNames(node).length,
    macroBodyName: macroBody?.name,
    macroBodyParameters: macroBody?.parameters,
    returnType: header?.childForFieldName('return_type')?.text,
    receiverType,
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
      returnType: 'fault',
      typeInfo: typeDeclarationInfo(doc, node, nameNode, 'fault-value'),
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
  const ownerTypeName = extractNameNode(node)?.text;

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
        returnType: ownerTypeName,
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
  receiverType?: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];
  let receiverParamAssigned = false;

  for (const param of callableParameterNodes(node)) {
    const nameNode = parameterNameNode(param);
    if (!nameNode) continue;

    const explicitTypeNode = param.childForFieldName('type');
    const explicitType = explicitTypeNode?.text;
    const typeNodeIsName =
      !!explicitTypeNode && sameSyntaxNode(explicitTypeNode, nameNode);
    const inferredReceiverType =
      (!explicitType || typeNodeIsName) &&
      receiverType &&
      !receiverParamAssigned
        ? receiverType
        : undefined;

    if (inferredReceiverType) {
      receiverParamAssigned = true;
    }

    symbols.push(
      createSymbol(doc, param, nameNode, moduleName, SymbolKind.Variable, {
        signature: declarationSignature(param),
        returnType: typeNodeIsName
          ? inferredReceiverType
          : (explicitType ?? inferredReceiverType),
        scopeRange,
      }),
    );
  }

  const trailingBlockParam = directTrailingBlockParam(node);
  if (trailingBlockParam) {
    const nameNode = directChildOfType(trailingBlockParam, 'at_ident');

    if (nameNode) {
      const macroBody = macroBodyParameter(node);

      symbols.push(
        createSymbol(
          doc,
          trailingBlockParam,
          nameNode,
          moduleName,
          SymbolKind.Variable,
          {
            signature: compactText(trailingBlockParam.text),
            kind: SymbolKind.Function,
            parameters: macroBody?.parameters.map(
              (parameter) => parameter.label,
            ),
            parameterDetails: macroBody?.parameters,
            scopeRange,
          },
        ),
      );
    }
  }

  return symbols;
}

function localDeclarationSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
  options: { inMacro?: boolean } = {},
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

  for (const declaration of descendantsOfType(scopeRoot, 'var_declaration')) {
    const parent = declaration.parent;

    if (parent?.type !== 'var_stmt') continue;
    if (!varDeclarationAllowed(declaration, options)) continue;

    const nameNode = declaration.childForFieldName('name');
    if (!nameNode) continue;

    const scopeNode = nearestAncestorOfTypes(declaration, [
      'compound_stmt',
      'macro_func_body',
      'lambda_body',
      'ct_stmt_body',
    ]);
    const scopeRange = rangeFromNode(scopeNode ?? scopeRoot);

    symbols.push(
      createSymbol(doc, parent, nameNode, moduleName, SymbolKind.Variable, {
        signature: declarationSignature(parent),
        attributes: attributesFor(declaration),
        scopeRange,
      }),
    );
  }

  for (const declaration of descendantsOfType(scopeRoot, 'const_declaration')) {
    const parent = declaration.parent;

    if (parent?.type !== 'declaration_stmt') continue;

    const nameNode = declaration.childForFieldName('name');
    if (!nameNode) continue;

    const scopeNode = nearestAncestorOfTypes(declaration, [
      'compound_stmt',
      'macro_func_body',
      'lambda_body',
      'ct_stmt_body',
    ]);
    const scopeRange = rangeFromNode(scopeNode ?? scopeRoot);

    symbols.push(
      createSymbol(doc, parent, nameNode, moduleName, SymbolKind.Constant, {
        signature: declarationSignature(parent),
        returnType: declaration.childForFieldName('type')?.text,
        scopeRange,
      }),
    );
  }

  symbols.push(...foreachVariableSymbols(doc, scopeRoot, moduleName));
  symbols.push(...forInitializerSymbols(doc, scopeRoot, moduleName, options));
  symbols.push(...conditionalUnwrapVariableSymbols(doc, scopeRoot, moduleName));
  symbols.push(...callBodyParameterSymbols(doc, scopeRoot, moduleName));

  return symbols;
}

function callBodyParameterSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const call of descendantsOfType(scopeRoot, 'call_expr')) {
    const trailing = call.childForFieldName('trailing');
    const args = call.childForFieldName('arguments');
    if (!trailing || !args) continue;

    const scopeRange = rangeFromNode(trailing);

    for (const param of directChildrenOfType(args, 'param')) {
      const nameNode = parameterNameNode(param);
      if (!nameNode) continue;

      const explicitTypeNode = param.childForFieldName('type');

      symbols.push(
        createSymbol(doc, param, nameNode, moduleName, SymbolKind.Variable, {
          signature: compactText(param.text),
          returnType: explicitTypeNode?.text,
          scopeRange,
        }),
      );
    }
  }

  return symbols;
}

function varDeclarationAllowed(
  declaration: SyntaxNode,
  options: { inMacro?: boolean },
): boolean {
  return (
    !!options.inMacro ||
    !!nearestAncestorOfTypes(declaration, ['macro_declaration']) ||
    hasAttribute(declaration, '@safeinfer') ||
    varDeclarationInitializesLambda(declaration)
  );
}

function varDeclarationInitializesLambda(declaration: SyntaxNode): boolean {
  const right = declaration.childForFieldName('right');

  return !!right && right.type.startsWith('lambda_');
}

function forInitializerSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
  options: { inMacro?: boolean },
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const forCond of descendantsOfType(scopeRoot, 'for_cond')) {
    const initializer = forCond.childForFieldName('initializer');
    if (!initializer) continue;

    const scopeNode = nearestAncestorOfTypes(forCond, ['for_stmt']);
    const scopeRange = rangeFromNode(scopeNode ?? forCond);

    for (const declaration of directChildrenOfType(
      initializer,
      'declaration',
    )) {
      for (const nameNode of declarationNameNodes(declaration)) {
        symbols.push(
          createSymbol(
            doc,
            declaration,
            nameNode,
            moduleName,
            SymbolKind.Variable,
            {
              signature: declarationSignature(declaration),
              returnType: declaration.childForFieldName('type')?.text,
              scopeRange,
            },
          ),
        );
      }
    }

    for (const declaration of directChildrenOfType(
      initializer,
      'var_declaration',
    )) {
      if (!varDeclarationAllowed(declaration, options)) continue;

      const nameNode = declaration.childForFieldName('name');
      if (!nameNode) continue;

      symbols.push(
        createSymbol(
          doc,
          declaration,
          nameNode,
          moduleName,
          SymbolKind.Variable,
          {
            signature: declarationSignature(declaration),
            attributes: attributesFor(declaration),
            scopeRange,
          },
        ),
      );
    }
  }

  return symbols;
}

function hasAttribute(node: SyntaxNode, name: string): boolean {
  return attributesFor(node).some(
    (attribute) => attribute.split('(')[0] === name,
  );
}

function foreachVariableSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const foreachCond of descendantsOfType(scopeRoot, 'foreach_cond')) {
    const foreachStmt = foreachCond.parent;
    const body = foreachStmt?.childForFieldName('body');
    const scopeRange = rangeFromNode(body ?? foreachStmt ?? foreachCond);

    for (const foreachVar of directChildrenOfType(foreachCond, 'foreach_var')) {
      const nameNode = directChildOfType(foreachVar, 'ident');
      if (!nameNode) continue;

      symbols.push(
        createSymbol(
          doc,
          foreachVar,
          nameNode,
          moduleName,
          SymbolKind.Variable,
          {
            signature: compactText(foreachVar.text),
            returnType: directChildOfType(foreachVar, 'type')?.text,
            scopeRange,
          },
        ),
      );
    }
  }

  return symbols;
}

function conditionalUnwrapVariableSymbols(
  doc: TextDocument,
  scopeRoot: SyntaxNode,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];

  for (const unwrap of [
    ...descendantsOfType(scopeRoot, 'catch_unwrap'),
    ...descendantsOfType(scopeRoot, 'try_unwrap'),
  ]) {
    const nameNode = directChildOfType(unwrap, 'ident');
    if (!nameNode) continue;

    const owner = nearestAncestorOfTypes(unwrap, [
      'if_stmt',
      'while_stmt',
      'for_stmt',
      'switch_stmt',
    ]);
    if (!owner) continue;

    const body = owner.childForFieldName('body');
    const typeNode = directChildOfType(unwrap, 'type');
    const signature = compactText(unwrap.text);
    const returnType = typeNode?.text;

    if (body) {
      symbols.push(
        createSymbol(doc, unwrap, nameNode, moduleName, SymbolKind.Variable, {
          signature,
          returnType,
          scopeRange: rangeFromNode(body),
        }),
      );
    }

    if (unwrap.type !== 'try_unwrap') continue;

    const condition = nearestAncestorOfTypes(unwrap, [
      'paren_cond',
      'for_cond',
    ]);
    if (!condition || condition.endIndex <= unwrap.endIndex) continue;

    symbols.push(
      createSymbol(doc, unwrap, nameNode, moduleName, SymbolKind.Variable, {
        signature,
        returnType,
        scopeRange: rangeFromOffsets(doc, unwrap.endIndex, condition.endIndex),
      }),
    );
  }

  return symbols;
}

function recoverTopLevelAggregateSymbols(
  doc: TextDocument,
  source: string,
  moduleName: string,
  moduleGenericParameterCount: number,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];
  const aggregateStart = /(^|\n)(?:struct|union|enum|constdef)\s+/g;

  let match: RegExpExecArray | null;
  while ((match = aggregateStart.exec(source))) {
    const startIndex = match.index + match[1].length;

    if (braceDepthBefore(source, startIndex) !== 0) continue;

    const symbol = recoverAggregateSymbol(
      doc,
      source,
      moduleName,
      startIndex,
      moduleGenericParameterCount,
    );
    if (symbol) symbols.push(symbol);
  }

  return symbols;
}

function recoverAggregateSymbol(
  doc: TextDocument,
  source: string,
  moduleName: string,
  startIndex: number,
  moduleGenericParameterCount: number,
): C3Symbol | null {
  const headerEnd = topLevelDeclarationHeaderEndIndex(source, startIndex);
  const header = source.slice(startIndex, headerEnd).trim();
  const match = header.match(
    /^(?<kind>struct|union|enum|constdef)\s+(?<name>[A-Za-z_$@][A-Za-z0-9_$@]*)/,
  );
  if (!match?.groups) return null;

  const name = match.groups.name;
  const nameStart = source.indexOf(name, startIndex);
  const bodyRange = bracedBodyRange(source, headerEnd);
  const kind =
    match.groups.kind === 'enum'
      ? SymbolKind.Enum
      : match.groups.kind === 'constdef'
        ? SymbolKind.Constant
        : SymbolKind.Struct;
  const range = rangeFromOffsets(doc, startIndex, bodyRange?.end ?? headerEnd);
  const selectionRange = rangeFromOffsets(
    doc,
    nameStart,
    nameStart + name.length,
  );
  const ownGenericParameterCount = genericParameterCountFromText(header);
  const genericParameterCount =
    ownGenericParameterCount || moduleGenericParameterCount;
  const children =
    bodyRange &&
    (match.groups.kind === 'enum' || match.groups.kind === 'constdef')
      ? recoverEnumLikeChildren(
          doc,
          source,
          moduleName,
          name,
          bodyRange.start + 1,
          bodyRange.end - 1,
        )
      : [];

  return {
    name,
    moduleName,
    kind,
    uri: doc.uri,
    range,
    selectionRange,
    bodyRange: bodyRange
      ? rangeFromOffsets(doc, bodyRange.start, bodyRange.end)
      : undefined,
    signature: compactText(header),
    documentation: undefined,
    attributes: attributesFromText(header),
    implementedInterfaces: implementedInterfacesFromAggregateHeader(header),
    parameters: [],
    typeInfo: {
      name,
      kind: recoveredAggregateTypeKind(match.groups.kind),
      isGeneric: genericParameterCount > 0,
      genericParameterCount,
      range,
      selectionRange,
      genericSource: ownGenericParameterCount
        ? 'declaration'
        : moduleGenericParameterCount
          ? 'module'
          : undefined,
    },
    children,
  };
}

function recoverEnumLikeChildren(
  doc: TextDocument,
  source: string,
  moduleName: string,
  ownerTypeName: string,
  bodyStart: number,
  bodyEnd: number,
): C3Symbol[] {
  const body = source.slice(bodyStart, bodyEnd);
  const constants: C3Symbol[] = [];
  const constant = /(^|[,\n])\s*(?<name>[A-Z_][A-Z0-9_]*)\b/g;

  let match: RegExpExecArray | null;
  while ((match = constant.exec(body))) {
    if (!match.groups) continue;

    const name = match.groups.name;
    const localNameStart = match.index + match[0].lastIndexOf(name);
    const nameStart = bodyStart + localNameStart;
    const entryEnd =
      bodyStart + nextTopLevelEnumSeparator(body, localNameStart + name.length);

    constants.push({
      name,
      moduleName,
      kind: SymbolKind.Constant,
      uri: doc.uri,
      range: rangeFromOffsets(doc, nameStart, entryEnd),
      selectionRange: rangeFromOffsets(doc, nameStart, nameStart + name.length),
      signature: compactText(source.slice(nameStart, entryEnd)),
      documentation: undefined,
      attributes: attributesFromText(source.slice(nameStart, entryEnd)),
      returnType: ownerTypeName,
      parameters: [],
      children: [],
    });
  }

  return constants;
}

function recoverTopLevelTypeAliasSymbols(
  doc: TextDocument,
  source: string,
  moduleName: string,
  moduleGenericParameterCount: number,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];
  const aliasStart = /(^|\n)(?:typedef|alias)\s+/g;

  let match: RegExpExecArray | null;
  while ((match = aliasStart.exec(source))) {
    const startIndex = match.index + match[1].length;

    if (braceDepthBefore(source, startIndex) !== 0) continue;

    const symbol = recoverTypeAliasSymbol(
      doc,
      source,
      moduleName,
      startIndex,
      moduleGenericParameterCount,
    );
    if (symbol) symbols.push(symbol);
  }

  return symbols;
}

function recoverTypeAliasSymbol(
  doc: TextDocument,
  source: string,
  moduleName: string,
  startIndex: number,
  moduleGenericParameterCount: number,
): C3Symbol | null {
  const endIndex = topLevelDeclarationEndIndex(source, startIndex);
  const declaration = source.slice(startIndex, endIndex).trim();
  const match = declaration.match(
    /^(?<kind>typedef|alias)\s+(?<name>[A-Za-z_$@][A-Za-z0-9_$@]*)(?:\s*<(?<generic>[^>]*)>)?\s*=\s*(?:inline\s+)?(?<target>[^;]+?)\s*;?$/,
  );
  if (!match?.groups || match.groups.target.startsWith('module ')) return null;

  const name = match.groups.name;
  const nameStart = source.indexOf(name, startIndex);
  const range = rangeFromOffsets(doc, startIndex, endIndex);
  const selectionRange = rangeFromOffsets(
    doc,
    nameStart,
    nameStart + name.length,
  );
  const ownGenericParameterCount = genericParameterCountFromText(
    match.groups.generic,
  );
  const genericParameterCount =
    ownGenericParameterCount || moduleGenericParameterCount;

  return {
    name,
    moduleName,
    kind: SymbolKind.TypeParameter,
    uri: doc.uri,
    range,
    selectionRange,
    signature: compactText(declaration),
    documentation: undefined,
    attributes: attributesFromText(declaration),
    returnType: match.groups.target.trim(),
    implementedInterfaces: [],
    parameters: [],
    typeInfo: {
      name,
      kind: match.groups.kind === 'alias' ? 'alias' : 'typedef',
      isGeneric: genericParameterCount > 0,
      genericParameterCount,
      range,
      selectionRange,
      genericSource: ownGenericParameterCount
        ? 'declaration'
        : moduleGenericParameterCount
          ? 'module'
          : undefined,
    },
    children: [],
  };
}

function recoverTopLevelCallableSymbols(
  doc: TextDocument,
  source: string,
  moduleName: string,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];
  const callableStart = /(^|\n)(?:extern\s+)?(?:fn|macro)\s+/g;

  let match: RegExpExecArray | null;
  while ((match = callableStart.exec(source))) {
    const startIndex = match.index + match[1].length;

    if (braceDepthBefore(source, startIndex) !== 0) continue;

    const symbol = recoverCallableSymbol(doc, source, moduleName, startIndex);
    if (symbol) symbols.push(symbol);
  }

  return symbols;
}

function recoverCallableSymbol(
  doc: TextDocument,
  source: string,
  moduleName: string,
  startIndex: number,
): C3Symbol | null {
  const endIndex = callableHeaderEndIndex(source, startIndex);
  const header = source.slice(startIndex, endIndex).trim();
  const prefix = header.match(/^(?:extern\s+)?(?:fn|macro)\s+/)?.[0];
  const paramsStart = header.indexOf('(');

  if (!prefix || paramsStart < 0) return null;

  const beforeParams = header.slice(prefix.length, paramsStart).trim();
  if (containsNestedCallableStart(beforeParams)) return null;

  const fullName = beforeParams.split(/\s+/).at(-1);
  if (!fullName) return null;

  const methodSeparator = fullName.lastIndexOf('.');
  const receiverType =
    methodSeparator > 0 ? fullName.slice(0, methodSeparator) : undefined;
  const name =
    methodSeparator > 0
      ? fullName.slice(methodSeparator + 1)
      : fullName.split('.').at(-1);
  if (!name || !/^[A-Za-z_$@][A-Za-z0-9_$@]*$/.test(name)) return null;

  const fullNameStart = source.indexOf(fullName, startIndex + prefix.length);
  if (fullNameStart < 0) return null;

  const nameStart = fullNameStart + fullName.lastIndexOf(name);
  const params = parameterListText(header, paramsStart);
  const parameterTexts = params ? splitTopLevelParameters(params) : [];
  const paramsStartOffset =
    startIndex + source.slice(startIndex, endIndex).indexOf('(') + 1;

  return {
    name,
    moduleName,
    kind: receiverType ? SymbolKind.Method : SymbolKind.Function,
    uri: doc.uri,
    range: rangeFromOffsets(doc, startIndex, endIndex),
    selectionRange: rangeFromOffsets(doc, nameStart, nameStart + name.length),
    signature: compactText(header),
    documentation: undefined,
    attributes: attributesFromText(header),
    returnType: beforeParams.slice(0, -fullName.length).trim() || undefined,
    receiverType,
    implementedInterfaces: [],
    parameters: parameterTexts,
    genericParameterCount: genericParameterCountFromText(header),
    parameterDetails: parameterTexts.map((parameter, index) =>
      parameterDetailFromLabel(parameter, index, receiverType),
    ),
    children: recoveredParameterSymbols(
      doc,
      source,
      moduleName,
      parameterTexts,
      paramsStartOffset,
      receiverType,
    ),
  };
}

function containsNestedCallableStart(text: string): boolean {
  return /(^|\n)\s*(?:extern\s+)?(?:fn|macro)\s+/.test(text);
}

function recoveredParameterSymbols(
  doc: TextDocument,
  source: string,
  moduleName: string,
  parameters: string[],
  paramsStartOffset: number,
  receiverType: string | undefined,
): C3Symbol[] {
  const symbols: C3Symbol[] = [];
  let searchOffset = paramsStartOffset;

  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index];
    const info = recoveredParameterInfo(parameter, index, receiverType);
    if (!info) continue;

    const parameterOffset = source.indexOf(parameter, searchOffset);
    const rangeStart =
      parameterOffset >= 0 ? parameterOffset : paramsStartOffset;
    const nameOffset =
      parameterOffset >= 0
        ? source.indexOf(info.name, parameterOffset)
        : rangeStart;

    symbols.push({
      name: info.name,
      moduleName,
      kind: SymbolKind.Variable,
      uri: doc.uri,
      range: rangeFromOffsets(doc, rangeStart, rangeStart + parameter.length),
      selectionRange: rangeFromOffsets(
        doc,
        nameOffset,
        nameOffset + info.name.length,
      ),
      signature: parameter,
      documentation: undefined,
      attributes: [],
      returnType: info.type,
      implementedInterfaces: [],
      parameters: [],
      children: [],
    });

    if (parameterOffset >= 0) {
      searchOffset = parameterOffset + parameter.length;
    }
  }

  return symbols;
}

function recoveredParameterInfo(
  parameter: string,
  index: number,
  receiverType: string | undefined,
): { name: string; type?: string } | undefined {
  if (parameter === '...' || parameter.length === 0) return undefined;

  const withoutDefault = parameter.split('=')[0]?.trim() ?? parameter;
  const receiver = withoutDefault.match(/^&?([A-Za-z_$@][A-Za-z0-9_$@]*)$/);

  if (receiver) {
    return {
      name: receiver[1],
      type: index === 0 ? receiverType : undefined,
    };
  }

  const match = withoutDefault.match(
    /^(?<type>.+?)\s+(?<name>[A-Za-z_$@][A-Za-z0-9_$@]*)(?:\.\.\.)?$/,
  );

  if (!match?.groups) return undefined;

  return {
    name: match.groups.name,
    type: match.groups.type.trim(),
  };
}

function mergeRecoveredSymbols(
  parsedSymbols: C3Symbol[],
  recoveredSymbols: C3Symbol[],
): C3Symbol[] {
  const seen = new Set(parsedSymbols.map(symbolIdentity));

  return [
    ...parsedSymbols,
    ...recoveredSymbols.filter((symbol) => {
      const identity = symbolIdentity(symbol);
      if (seen.has(identity)) return false;

      seen.add(identity);
      return true;
    }),
  ];
}

function symbolIdentity(symbol: C3Symbol): string {
  return [
    symbol.name,
    symbol.selectionRange.start.line,
    symbol.selectionRange.start.character,
  ].join(':');
}

function createSymbol(
  doc: TextDocument,
  node: SyntaxNode,
  nameNode: SyntaxNode,
  moduleName: string,
  kind: SymbolKind,
  options: {
    signature: string;
    kind?: SymbolKind;
    bodyNode?: SyntaxNode;
    children?: C3Symbol[];
    documentation?: string;
    attributes?: string[];
    returnType?: string;
    receiverType?: string;
    implementedInterfaces?: string[];
    parameters?: string[];
    parameterDetails?: C3Parameter[];
    genericParameterCount?: number;
    macroBodyName?: string;
    macroBodyParameters?: C3Parameter[];
    contracts?: C3Contract[];
    typeInfo?: C3TypeDeclarationInfo;
    scopeRange?: Range;
  },
): C3Symbol {
  return {
    name: nameNode.text,
    moduleName,
    kind: options.kind ?? kind,
    uri: doc.uri,
    range: rangeFromNode(node),
    selectionRange: rangeFromNode(nameNode),
    bodyRange: options.bodyNode ? rangeFromNode(options.bodyNode) : undefined,
    signature: options.signature,
    documentation: options.documentation ?? documentationFor(node),
    attributes: options.attributes ?? attributesFor(node),
    returnType: options.returnType,
    receiverType: options.receiverType,
    implementedInterfaces: options.implementedInterfaces,
    parameters: options.parameters ?? [],
    parameterDetails: options.parameterDetails,
    genericParameterCount: options.genericParameterCount,
    macroBodyName: options.macroBodyName,
    macroBodyParameters: options.macroBodyParameters,
    contracts: options.contracts ?? contractsFor(node),
    typeInfo: options.typeInfo,
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
  return callableParameterNodes(node).map((param) => compactText(param.text));
}

function parameterDetails(
  node: SyntaxNode,
  receiverType: string | undefined,
): C3Parameter[] {
  return callableParameterNodes(node).map((param, index) => {
    const label = compactText(param.text);
    const detail = parameterDetailFromLabel(label, index, receiverType);
    const nameNode = parameterNameNode(param);
    const explicitTypeNode = param.childForFieldName('type');
    const explicitType =
      explicitTypeNode && !sameSyntaxNode(explicitTypeNode, nameNode)
        ? explicitTypeNode.text
        : undefined;
    const paramDefault = directChildOfType(param, 'param_default');
    const defaultValue = paramDefault?.childForFieldName('right')?.text;
    const baseEnd = paramDefault
      ? paramDefault.startIndex - param.startIndex
      : param.text.length;
    const baseText = param.text.slice(0, baseEnd);

    return {
      ...detail,
      name: nameNode?.text ?? detail.name,
      type: explicitType ?? detail.type,
      optional: !!paramDefault,
      variadic: /\.\.\./.test(baseText),
      defaultValue: defaultValue ? compactText(defaultValue) : undefined,
      receiver: !!receiverType && index === 0,
    };
  });
}

function callableParameterNodes(node: SyntaxNode): SyntaxNode[] {
  const paramList =
    directChildOfType(node, 'func_param_list') ??
    directChildOfType(node, 'macro_param_list') ??
    directChildOfType(node, 'attribute_param_list');

  return paramList ? directChildrenOfType(paramList, 'param') : [];
}

function parameterNameNode(param: SyntaxNode): SyntaxNode | null {
  const name = param.childForFieldName('name');
  if (name) return name;

  const type = param.childForFieldName('type');
  if (type?.text.startsWith('$')) return type;

  return null;
}

function directTrailingBlockParam(node: SyntaxNode): SyntaxNode | null {
  const paramList = directChildOfType(node, 'macro_param_list');
  return paramList
    ? directChildOfType(paramList, 'trailing_block_param')
    : null;
}

function macroBodyParameter(
  node: SyntaxNode,
): { name: string; parameters: C3Parameter[] } | undefined {
  const trailingBlockParam = directTrailingBlockParam(node);
  const nameNode = trailingBlockParam
    ? directChildOfType(trailingBlockParam, 'at_ident')
    : null;
  if (!trailingBlockParam || !nameNode) return undefined;

  const paramList = directChildOfType(trailingBlockParam, 'func_param_list');
  const params = paramList ? directChildrenOfType(paramList, 'param') : [];

  return {
    name: nameNode.text,
    parameters: params.map((param, index) => {
      const label = compactText(param.text);
      const detail = parameterDetailFromLabel(label, index);
      const explicitTypeNode = param.childForFieldName('type');
      const name = parameterNameNode(param)?.text ?? detail.name;

      return {
        ...detail,
        name,
        type: explicitTypeNode?.text ?? detail.type,
      };
    }),
  };
}

function receiverTypeForCallable(node: SyntaxNode): string | undefined {
  const header =
    directChildOfType(node, 'func_header') ??
    directChildOfType(node, 'macro_header');

  return header?.childForFieldName('method_type')?.text;
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

function contractsFor(node: SyntaxNode): C3Contract[] {
  const docComment = directChildOfType(node, 'doc_comment');
  if (!docComment) return [];

  return directChildrenOfType(docComment, 'doc_comment_contract').flatMap(
    (contract) => {
      const nameNode = contract.childForFieldName('name');
      if (!nameNode) return [];

      const parameterNode = contract.childForFieldName('parameter');
      const modifierNode = contract.childForFieldName('mutability_contract');
      const descriptionNode = contract.childForFieldName('description');
      const expressionNodes = contract.namedChildren.filter(
        (child) =>
          !sameSyntaxNode(child, nameNode) &&
          !sameSyntaxNode(child, parameterNode) &&
          !sameSyntaxNode(child, modifierNode) &&
          !sameSyntaxNode(child, descriptionNode),
      );

      return [
        {
          kind: contractKind(nameNode.text),
          name: nameNode.text,
          nameRange: rangeFromNode(nameNode),
          range: rangeFromNode(contract),
          expressions: expressionNodes.map((expr) => compactText(expr.text)),
          expressionRanges: expressionNodes.map(rangeFromNode),
          parameter: parameterNode?.text,
          parameterRange: parameterNode
            ? rangeFromNode(parameterNode)
            : undefined,
          modifier: modifierNode?.text,
          description: descriptionNode
            ? stringDescriptionText(descriptionNode.text)
            : undefined,
        },
      ];
    },
  );
}

function contractKind(name: string): C3Contract['kind'] {
  switch (name) {
    case '@require':
      return 'require';
    case '@ensure':
      return 'ensure';
    case '@param':
      return 'param';
    case '@return':
      return 'return';
    case '@pure':
      return 'pure';
    default:
      return 'other';
  }
}

function stringDescriptionText(text: string): string {
  return cleanCommentText(text).replace(/^"|"$/g, '').replace(/^`|`$/g, '');
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

function attributesFromText(text: string): string[] {
  return text.match(/@[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

function implementedInterfacesFor(node: SyntaxNode): string[] {
  const implList = directChildOfType(node, 'interface_impl_list');
  if (!implList) return [];

  return directChildrenOfType(implList, 'path_type_ident').map(
    (interfaceNode) => interfaceNode.text,
  );
}

function implementedInterfacesFromAggregateHeader(header: string): string[] {
  const match = header.match(
    /^(?:struct|union|enum|constdef)\s+[A-Za-z_$@][A-Za-z0-9_$@]*\s*\((?<interfaces>[^)]*)\)/,
  );
  if (!match?.groups?.interfaces) return [];

  return splitTopLevelParameters(match.groups.interfaces)
    .map((name) => name.trim())
    .filter(Boolean);
}

function typeDeclarationInfo(
  doc: TextDocument,
  node: SyntaxNode,
  nameNode: SyntaxNode,
  kind: C3TypeDeclarationInfo['kind'],
  moduleGenericParameterCount = 0,
): C3TypeDeclarationInfo {
  const ownGenericParameterCount = genericParameterNames(node).length;
  const genericParameterCount =
    ownGenericParameterCount || moduleGenericParameterCount;

  return {
    name: nameNode.text,
    kind,
    isGeneric: genericParameterCount > 0,
    genericParameterCount,
    range: rangeFromNode(node),
    selectionRange: rangeFromNode(nameNode),
    genericSource: ownGenericParameterCount
      ? 'declaration'
      : moduleGenericParameterCount
        ? 'module'
        : undefined,
  };
}

function typeDeclarationKindForNode(
  node: SyntaxNode,
): C3TypeDeclarationInfo['kind'] {
  switch (node.type) {
    case 'struct_declaration':
      return declarationKeyword(node) === 'union' ? 'union' : 'struct';
    case 'bitstruct_declaration':
      return 'bitstruct';
    case 'enum_declaration':
      return 'enum';
    case 'constdef_declaration':
      return 'constdef';
    case 'interface_declaration':
      return 'interface';
    case 'alias_declaration':
      return 'alias';
    case 'typedef_declaration':
      return 'typedef';
    default:
      return 'builtin';
  }
}

function recoveredAggregateTypeKind(
  keyword: string,
): C3TypeDeclarationInfo['kind'] {
  switch (keyword) {
    case 'union':
      return 'union';
    case 'enum':
      return 'enum';
    case 'constdef':
      return 'constdef';
    default:
      return 'struct';
  }
}

function declarationKeyword(node: SyntaxNode): string | undefined {
  return node.text
    .slice(signatureStartIndex(node) - node.startIndex)
    .match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

function genericParameterNames(node: SyntaxNode): string[] {
  const list = directChildOfType(node, 'generic_param_list');
  if (!list) return [];

  return directChildrenOfTypes(list, ['type_ident', 'const_ident']).map(
    (child) => child.text,
  );
}

function genericParameterCountFromText(text: string | undefined): number {
  if (!text) return 0;

  const params = text.includes('<')
    ? text.match(/<(?<params>[^>]*)>/)?.groups?.params
    : text;
  if (!params) return 0;

  return splitTopLevelParameters(params)
    .map((parameter) => parameter.trim())
    .filter(Boolean).length;
}

function collectSyntaxDiagnostics(
  doc: TextDocument,
  root: SyntaxNode,
): Diagnostic[] {
  const sourceDiagnostics = [
    ...collectDelimiterDiagnostics(doc),
    ...collectMissingTerminatorDiagnostics(doc),
    ...collectInvalidInitializerSyntaxDiagnostics(doc, root),
  ];
  const diagnostics: Diagnostic[] = [...sourceDiagnostics];

  function visit(node: SyntaxNode): void {
    if (!node.hasError && !node.isError && !node.isMissing) return;

    if (node.isError || node.isMissing) {
      if (!shouldSuppressErrorNodeDiagnostic(node, sourceDiagnostics)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: nonEmptyRangeFromNode(node),
          message: syntaxDiagnosticMessage(node),
          source: 'tree-sitter-c3',
        });
      }

      if (node.isError) return;
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);

  return uniqueDiagnostics(diagnostics);
}

function syntaxDiagnosticMessage(node: SyntaxNode): string {
  if (node.isMissing) {
    if (looksLikeMissingStatementTerminator(node)) return "Missing ';'";

    return `Missing ${printableSyntaxNodeType(node.type)}`;
  }

  if (looksLikeMissingCallArgumentComma(node)) {
    return 'Syntax error: missing comma between call arguments';
  }

  return 'Syntax error: unable to parse this C3 syntax';
}

function looksLikeMissingCallArgumentComma(node: SyntaxNode): boolean {
  return (
    node.isError &&
    node.parent?.type === 'call_arg_list' &&
    !!node.previousNamedSibling &&
    node.nextNamedSibling?.type === 'call_arg'
  );
}

function looksLikeMissingStatementTerminator(node: SyntaxNode): boolean {
  if (!node.isMissing || node.type !== '=') return false;

  const parent = node.parent;
  if (parent?.type !== 'assignment_expr') return false;

  const previous = node.previousNamedSibling;
  const next = node.nextNamedSibling;
  if (!previous || !next) return false;

  return previous.endPosition.row <= next.startPosition.row;
}

type OpenDelimiter = {
  char: string;
  index: number;
  indent: number;
  line: number;
  kind: 'control-block' | 'delimiter';
};

function collectDelimiterDiagnostics(doc: TextDocument): Diagnostic[] {
  const source = doc.getText();
  const diagnostics: Diagnostic[] = [];
  const stack: OpenDelimiter[] = [];
  const state: LexState = {};
  let lineStart = 0;
  let checkedLine = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const newline = char === '\n';

    if (updateLexState(source, index, state)) {
      if (newline) {
        lineStart = index + 1;
        checkedLine = false;
      }
      continue;
    }
    if (newline) {
      lineStart = index + 1;
      checkedLine = false;
      continue;
    }
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (!checkedLine && !isHorizontalWhitespace(char)) {
      checkedLine = true;
      closeDedentedControlBlocksBeforeLine(
        doc,
        source,
        stack,
        diagnostics,
        lineStart,
        index,
      );
    }

    if (isOpeningDelimiter(char)) {
      stack.push({
        char,
        index,
        indent: indentationAt(source, index),
        line: doc.positionAt(index).line,
        kind:
          char === '{' && isControlBlockOpen(source, index)
            ? 'control-block'
            : 'delimiter',
      });
      continue;
    }

    if (!isClosingDelimiter(char)) continue;

    while (
      stack.length > 0 &&
      closingDelimiterFor(stack[stack.length - 1]!.char) !== char
    ) {
      const open = stack.pop()!;

      diagnostics.push(
        syntaxDiagnostic(
          rangeFromOffsets(doc, index, index + 1),
          `Missing ${printableSyntaxNodeType(
            closingDelimiterFor(open.char),
          )} before ${printableSyntaxNodeType(char)}`,
          'c3-lsp',
        ),
      );
    }

    if (stack.length > 0) {
      stack.pop();
      continue;
    }

    diagnostics.push(
      syntaxDiagnostic(
        rangeFromOffsets(doc, index, index + 1),
        `Unexpected ${printableSyntaxNodeType(char)}`,
        'c3-lsp',
      ),
    );
  }

  for (const open of stack.reverse()) {
    diagnostics.push(
      syntaxDiagnostic(
        rangeFromOffsets(doc, open.index, open.index + 1),
        `Missing ${printableSyntaxNodeType(closingDelimiterFor(open.char))}`,
        'c3-lsp',
      ),
    );
  }

  return diagnostics;
}

function closeDedentedControlBlocksBeforeLine(
  doc: TextDocument,
  source: string,
  stack: OpenDelimiter[],
  diagnostics: Diagnostic[],
  lineStart: number,
  firstCodeIndex: number,
): void {
  const line = source.slice(lineStart, lineEndIndex(source, lineStart));
  if (/^\s*}/.test(line)) return;

  const indentation = firstCodeIndex - lineStart;
  const lineNumber = doc.positionAt(firstCodeIndex).line;

  while (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    if (open.char !== '{' || open.kind !== 'control-block') return;
    if (open.line >= lineNumber || indentation > open.indent) return;

    stack.pop();
    diagnostics.push(
      syntaxDiagnostic(
        rangeFromOffsets(doc, firstCodeIndex, firstCodeIndex + 1),
        "Missing '}' before this statement",
        'c3-lsp',
      ),
    );
  }
}

function isHorizontalWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r';
}

function indentationAt(source: string, offset: number): number {
  const lineStart = lineStartIndex(source, offset);
  const lineEnd = lineEndIndex(source, offset);

  for (let index = lineStart; index < lineEnd; index++) {
    if (!isHorizontalWhitespace(source[index]!)) return index - lineStart;
  }

  return 0;
}

function lineStartIndex(source: string, offset: number): number {
  const newline = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineEndIndex(source: string, offset: number): number {
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline;
}

function isControlBlockOpen(source: string, braceOffset: number): boolean {
  const header = blockHeaderBeforeBrace(source, braceOffset);

  return /\b(?:if|else|while|for|foreach|catch|defer)\b/.test(header);
}

function blockHeaderBeforeBrace(source: string, braceOffset: number): string {
  const lineStart = lineStartIndex(source, braceOffset);
  const sameLine = source.slice(lineStart, braceOffset).trim();
  if (sameLine) return sameLine;

  let lineEnd = lineStart - 1;
  while (lineEnd > 0) {
    const previousLineStart = lineStartIndex(source, lineEnd);
    const line = source.slice(previousLineStart, lineEnd).trim();
    if (line) return line;
    lineEnd = previousLineStart - 1;
  }

  return '';
}

function collectMissingTerminatorDiagnostics(doc: TextDocument): Diagnostic[] {
  const source = doc.getText();
  const diagnostics: Diagnostic[] = [];
  let lineStart = 0;

  for (let index = 0; index <= source.length; index++) {
    if (index < source.length && source[index] !== '\n') continue;

    const line = source.slice(lineStart, index);
    const codeLength = codeLengthBeforeLineComment(line);
    const code = line.slice(0, codeLength).trimEnd();

    if (needsSemicolonTerminator(code)) {
      const end = lineStart + code.length;

      diagnostics.push(
        syntaxDiagnostic(
          rangeFromOffsets(doc, end, end + 1),
          "Missing ';'",
          'c3-lsp',
        ),
      );
    }

    lineStart = index + 1;
  }

  return diagnostics;
}

function collectInvalidInitializerSyntaxDiagnostics(
  doc: TextDocument,
  root: SyntaxNode,
): Diagnostic[] {
  const source = doc.getText();
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();

  function add(typeName: SyntaxNode): void {
    const key = `${typeName.startIndex}:${typeName.endIndex}`;
    if (reported.has(key)) return;

    reported.add(key);
    diagnostics.push(
      syntaxDiagnostic(
        rangeFromNode(typeName),
        invalidInitializerSyntaxMessage(typeName.text),
        'c3-lsp',
      ),
    );
  }

  function visit(node: SyntaxNode): void {
    if (node.type === 'generic_type_ident') {
      const typeName = directChildOfType(node, 'path_type_ident');
      const args = directChildOfType(node, 'generic_arg_list');

      if (
        typeName &&
        args &&
        isExpressionTypeContext(node) &&
        genericArgumentsLookLikeInitializer(args)
      ) {
        add(typeName);
      }
    }

    if (node.isError) {
      for (const typeName of descendantsOfType(node, 'path_type_ident')) {
        if (looksLikeBareInitializerInErrorNode(source, node, typeName)) {
          add(typeName);
        }
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return diagnostics;
}

function genericArgumentsLookLikeInitializer(args: SyntaxNode): boolean {
  const inner = args.text.slice(1, -1).trim();
  return inner === '' || /(?:^|,)\s*\.[A-Za-z_$@]/.test(inner);
}

function looksLikeBareInitializerInErrorNode(
  source: string,
  errorNode: SyntaxNode,
  typeName: SyntaxNode,
): boolean {
  if (nearestAncestorOfTypes(typeName, ['generic_type_ident', 'type'])) {
    return false;
  }

  const braceOffset = nextNonWhitespaceIndex(source, typeName.endIndex);
  if (source[braceOffset] !== '{') return false;
  if (!braceContentLooksLikeInitializer(source, braceOffset)) return false;

  const boundary = Math.max(
    errorNode.startIndex,
    previousStatementBoundary(source, typeName.startIndex),
  );
  const prefix = source.slice(boundary, typeName.startIndex).trimEnd();
  if (!prefix) return false;

  if (/^(?:struct|union|enum|bitstruct|interface|constdef)\b/.test(prefix)) {
    return false;
  }

  const previousChar = prefix.at(-1);
  if (previousChar && '=([{,:!?+-*/%&|^~<>'.includes(previousChar)) {
    return true;
  }

  const previousWord = prefix.match(/[A-Za-z_$@][A-Za-z0-9_$@]*$/)?.[0];
  return previousWord === 'return' || previousWord === 'case';
}

function braceContentLooksLikeInitializer(
  source: string,
  braceOffset: number,
): boolean {
  const next = nextNonWhitespaceIndex(source, braceOffset + 1);
  return source[next] === '.' || source[next] === '}';
}

function nextNonWhitespaceIndex(source: string, offset: number): number {
  for (let index = offset; index < source.length; index++) {
    if (!/\s/.test(source[index]!)) return index;
  }

  return source.length;
}

function isExpressionTypeContext(node: SyntaxNode): boolean {
  const typeNode = nearestAncestorOfTypes(node, ['type']);
  return !!typeNode && !isTypeReferenceTypeNode(typeNode);
}

function isTypeReferenceTypeNode(typeNode: SyntaxNode): boolean {
  const parent = typeNode.parent;
  if (!parent) return false;

  if (sameSyntaxNode(parent.childForFieldName('type'), typeNode)) return true;
  if (sameSyntaxNode(parent.childForFieldName('return_type'), typeNode)) {
    return true;
  }

  if (parent.type === 'typed_initializer_list') return true;
  if (
    parent.type === 'cast_expr' &&
    sameSyntaxNode(parent.childForFieldName('type'), typeNode)
  ) {
    return true;
  }

  if (parent.type === 'generic_arg_list') {
    const owner = parent.parent;
    if (owner?.type === 'trailing_generic_expr') return true;

    return owner?.type === 'generic_type_ident'
      ? isGenericTypeIdentInTypeReferenceContext(owner)
      : false;
  }

  return false;
}

function isGenericTypeIdentInTypeReferenceContext(node: SyntaxNode): boolean {
  const typeNode = node.parent?.type === 'type' ? node.parent : undefined;
  return !!typeNode && isTypeReferenceTypeNode(typeNode);
}

function needsSemicolonTerminator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/[;{,}]$/.test(trimmed)) return false;

  return /^\s*(?:module|import|alias|typedef|attrdef)\b/.test(line);
}

function previousStatementBoundary(source: string, offset: number): number {
  for (let index = offset - 1; index >= 0; index--) {
    const char = source[index];
    if (char === '\n' || char === ';' || char === '{' || char === '}') {
      return index + 1;
    }
  }

  return 0;
}

function invalidInitializerSyntaxMessage(typeName: string): string {
  return `Invalid initializer syntax for '${typeName}': use '(${typeName}){ ... }' or infer the type with '{ ... }'.`;
}

function codeLengthBeforeLineComment(line: string): number {
  const state: Pick<LexState, 'stringQuote' | 'escaped'> = {};

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];

    if (state.stringQuote) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }

      if (state.stringQuote !== '`' && char === '\\') {
        state.escaped = true;
        continue;
      }

      if (char === state.stringQuote) state.stringQuote = undefined;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      state.stringQuote = char;
      continue;
    }

    if (char === '/' && next === '/') return index;
  }

  return line.length;
}

function shouldSuppressErrorNodeDiagnostic(
  node: SyntaxNode,
  sourceDiagnostics: Diagnostic[],
): boolean {
  if (isInvalidInitializerRecoveryArtifact(node)) return true;

  if (node.isMissing && isClosingDelimiter(node.type)) {
    return sourceDiagnostics.some(
      (diagnostic) =>
        diagnostic.source === 'c3-lsp' &&
        diagnostic.message.startsWith(
          `Missing ${printableSyntaxNodeType(node.type)}`,
        ),
    );
  }

  if (!node.isError) return false;

  const range = rangeFromNode(node);

  return sourceDiagnostics.some((diagnostic) =>
    rangeContainsPosition(range, diagnostic.range.start),
  );
}

function isInvalidInitializerRecoveryArtifact(node: SyntaxNode): boolean {
  const genericArgs = nearestAncestorOfTypes(node, ['generic_arg_list']);
  if (!genericArgs) return false;

  const owner = genericArgs.parent;
  return (
    owner?.type === 'generic_type_ident' &&
    isExpressionTypeContext(owner) &&
    genericArgumentsLookLikeInitializer(genericArgs)
  );
}

function syntaxDiagnostic(
  range: Range,
  message: string,
  source: string,
): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range,
    message,
    source,
  };
}

function isOpeningDelimiter(char: string): boolean {
  return char === '(' || char === '[' || char === '{';
}

function isClosingDelimiter(char: string): boolean {
  return char === ')' || char === ']' || char === '}';
}

function closingDelimiterFor(char: string): string {
  switch (char) {
    case '(':
      return ')';
    case '[':
      return ']';
    case '{':
      return '}';
    default:
      return '';
  }
}

function printableSyntaxNodeType(type: string): string {
  return type.length === 1 ? `'${type}'` : type;
}

function rangeContainsPosition(range: Range, position: Position): boolean {
  return (
    comparePositions(position, range.start) >= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

function comparePositions(left: Position, right: Position): number {
  if (left.line !== right.line) return left.line - right.line;

  return left.character - right.character;
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
      diagnostic.message,
    ].join(':');

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}

function callableHeaderEndIndex(source: string, startIndex: number): number {
  let parenDepth = 0;
  const state: LexState = {};

  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];

    if (updateLexState(source, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '(') {
      parenDepth++;
      continue;
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (parenDepth === 0) {
      if (char === '{' || char === ';') return index;
      if (char === '=' && source[index + 1] === '>') return index;
    }
  }

  return source.length;
}

function topLevelDeclarationHeaderEndIndex(
  source: string,
  startIndex: number,
): number {
  const state: LexState = {};
  let parenDepth = 0;

  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];

    if (updateLexState(source, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '(') {
      parenDepth++;
      continue;
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (parenDepth === 0 && (char === '{' || char === ';')) return index;
  }

  return source.length;
}

function topLevelDeclarationEndIndex(
  source: string,
  startIndex: number,
): number {
  const state: LexState = {};

  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];

    if (updateLexState(source, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === ';') return index + 1;
  }

  return source.length;
}

function bracedBodyRange(
  source: string,
  searchStart: number,
): { start: number; end: number } | undefined {
  const state: LexState = {};
  let bodyStart = -1;
  let depth = 0;

  for (let index = searchStart; index < source.length; index++) {
    const char = source[index];

    if (updateLexState(source, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '{') {
      if (depth === 0) bodyStart = index;
      depth++;
      continue;
    }

    if (char === '}') {
      depth--;
      if (depth === 0 && bodyStart >= 0) {
        return { start: bodyStart, end: index + 1 };
      }
    }
  }

  return undefined;
}

function nextTopLevelEnumSeparator(body: string, startIndex: number): number {
  const state: LexState = {};
  let depth = 0;

  for (let index = startIndex; index < body.length; index++) {
    const char = body[index];

    if (updateLexState(body, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ',' && depth === 0) return index;
  }

  return body.length;
}

function parameterListText(
  header: string,
  paramsStart: number,
): string | undefined {
  let depth = 0;
  const state: LexState = {};

  for (let index = paramsStart; index < header.length; index++) {
    const char = header[index];

    if (updateLexState(header, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      if (depth === 0) return header.slice(paramsStart + 1, index);
    }
  }

  return undefined;
}

function splitTopLevelParameters(text: string): string[] {
  const parameters: string[] = [];
  const state: LexState = {};
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (updateLexState(text, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ',' && depth === 0) {
      const parameter = compactText(text.slice(start, index));
      if (parameter) parameters.push(parameter);
      start = index + 1;
    }
  }

  const last = compactText(text.slice(start));
  if (last) parameters.push(last);

  return parameters;
}

function braceDepthBefore(source: string, offset: number): number {
  let depth = 0;
  const state: LexState = {};

  for (let index = 0; index < offset; index++) {
    const char = source[index];

    if (updateLexState(source, index, state)) continue;
    if (state.lineComment || state.blockComment || state.stringQuote) continue;

    if (char === '{') depth++;
    if (char === '}') depth = Math.max(0, depth - 1);
  }

  return depth;
}

type LexState = {
  lineComment?: boolean;
  blockComment?: string;
  stringQuote?: string;
  escaped?: boolean;
};

function updateLexState(
  source: string,
  index: number,
  state: LexState,
): boolean {
  const char = source[index];
  const next = source[index + 1];

  if (state.lineComment) {
    if (char === '\n') state.lineComment = false;
    return true;
  }

  if (state.blockComment) {
    if (
      (state.blockComment === '*/' && char === '*' && next === '/') ||
      (state.blockComment === '*>' && char === '*' && next === '>')
    ) {
      state.blockComment = undefined;
    }
    return true;
  }

  if (state.stringQuote) {
    if (state.escaped) {
      state.escaped = false;
      return true;
    }

    if (state.stringQuote !== '`' && char === '\\') {
      state.escaped = true;
      return true;
    }

    if (char === state.stringQuote) {
      state.stringQuote = undefined;
    }
    return true;
  }

  if (char === '/' && next === '/') {
    state.lineComment = true;
    return true;
  }

  if (char === '/' && next === '*') {
    state.blockComment = '*/';
    return true;
  }

  if (char === '<' && next === '*') {
    state.blockComment = '*>';
    return true;
  }

  if (char === '"' || char === "'" || char === '`') {
    state.stringQuote = char;
    return true;
  }

  return false;
}

function rangeFromOffsets(
  doc: TextDocument,
  startIndex: number,
  endIndex: number,
): Range {
  return Range.create(doc.positionAt(startIndex), doc.positionAt(endIndex));
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

function sameSyntaxNode(
  left: SyntaxNode | null | undefined,
  right: SyntaxNode | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
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
