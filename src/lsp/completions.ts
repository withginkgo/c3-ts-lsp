import {
  CompletionItemKind,
  InsertTextFormat,
  SymbolKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters, isCallableSymbol } from '../shared/callable.js';
import {
  C3_BUILTIN_ATTRIBUTES,
  C3_COMPILE_TIME_BUILTINS,
  C3_DEFINED_CONSTANTS,
  C3_KEYWORDS,
} from '../shared/language-data.js';
import type { C3Symbol, ParsedDocument } from '../shared/types.js';
import {
  attributeCompletionBeforeCursor,
  callArgumentContextBeforeCursor,
  dotAccessCompletionBeforeCursor,
  memberAccessBeforeCursor,
  methodContext,
  modulePathCompletionBeforeCursor,
  modulePrefixBeforeCursor,
  namedArgumentsBeforeCursor,
  type AttributeCompletionContext,
  type CallArgumentContext,
  type ModulePathCompletionContext,
  typeMethodDeclarationBeforeCursor,
} from './completion-context.js';
import { importTextEdit } from './import-edits.js';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const modulePathCompletion = modulePathCompletionBeforeCursor(doc, position);

  if (modulePathCompletion) {
    return modulePathCompletions(index, current, modulePathCompletion);
  }

  const attributeCompletion = attributeCompletionBeforeCursor(doc, position);

  if (attributeCompletion) {
    return attributeCompletions(index, current, position, attributeCompletion);
  }

  const typeMethodDeclaration = typeMethodDeclarationBeforeCursor(
    doc,
    position,
  );

  if (typeMethodDeclaration) {
    return methodCompletionsForType(
      index,
      current,
      typeMethodDeclaration.receiver,
      typeMethodDeclaration.position,
    );
  }

  const memberAccess = memberAccessBeforeCursor(doc, position);

  if (memberAccess) {
    return memberCompletions(
      index,
      current,
      memberAccess.receiver,
      memberAccess.position,
    );
  }

  if (dotAccessCompletionBeforeCursor(doc, position)) {
    return [];
  }

  const prefix = modulePrefixBeforeCursor(doc, position);

  if (prefix) {
    return moduleMemberCompletions(index, current, prefix);
  }

  const argumentItems = argumentNameCompletions(index, doc, current, position);
  const visibleSymbols = index.visibleSymbolsAt(current.uri, position);
  const visibleNames = new Set(visibleSymbols.map((symbol) => symbol.name));

  const symbolItems = visibleSymbols.map((symbol) =>
    symbolCompletionItem(symbol),
  );
  const autoImportItems = index
    .autoImportCandidates(current)
    .filter(({ symbol }) => !visibleNames.has(symbol.name))
    .map(({ moduleName, symbol }) =>
      autoImportCompletionItem(current, moduleName, symbol),
    );

  return [
    ...argumentItems,
    ...keywordCompletions(),
    ...symbolItems,
    ...autoImportItems,
  ];
}

function attributeCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: AttributeCompletionContext,
): CompletionItem[] {
  return uniqueCompletionItems([
    ...C3_BUILTIN_ATTRIBUTES.filter((attribute) =>
      attributeMatchesPrefix(attribute, context.prefix),
    ).map((attribute) => attributeCompletionItem(attribute, context)),
    ...index
      .visibleSymbolsAt(current.uri, position)
      .filter(
        (symbol) =>
          symbol.kind === SymbolKind.Property &&
          symbol.name.startsWith('@') &&
          attributeMatchesPrefix(symbol.name, context.prefix),
      )
      .map((symbol) =>
        attributeCompletionItem(symbol.name, context, symbol.signature),
      ),
  ]);
}

function attributeMatchesPrefix(attribute: string, prefix: string): boolean {
  const name = attributeName(attribute);

  return (
    prefix.length === 0 ||
    attribute.startsWith(`@${prefix}`) ||
    name.startsWith(prefix)
  );
}

function attributeCompletionItem(
  attribute: string,
  context: AttributeCompletionContext,
  detail?: string,
): CompletionItem {
  const name = attributeName(attribute);

  return {
    label: attribute,
    kind: CompletionItemKind.Property,
    detail,
    filterText: name,
    textEdit: {
      range: context.replaceRange,
      newText: name,
    },
  };
}

function attributeName(attribute: string): string {
  return attribute.startsWith('@') ? attribute.slice(1) : attribute;
}

function argumentNameCompletions(
  index: ProjectIndex,
  doc: TextDocument,
  current: ParsedDocument,
  position: Position,
): CompletionItem[] {
  const context = callArgumentContextBeforeCursor(doc, position);
  if (!context) return [];

  const callable = callableForContext(index, current, context);
  if (!callable) return [];

  const supplied = namedArgumentsBeforeCursor(context.argumentsText);

  return callableParameters(callable.symbol, {
    methodStyle: callable.methodStyle,
  })
    .filter((parameter) => parameter.name && !supplied.has(parameter.name))
    .map((parameter) => ({
      label: parameter.name!,
      kind: CompletionItemKind.Variable,
      detail: parameter.label,
      insertText: `${parameter.name}: `,
    }));
}

function callableForContext(
  index: ProjectIndex,
  current: ParsedDocument,
  context: CallArgumentContext,
): { symbol: C3Symbol; methodStyle: boolean } | null {
  const method = methodContext(context.callee);

  if (method) {
    const symbol = index
      .memberSymbolsForExpression(
        current.uri,
        method.receiver,
        context.calleePosition,
      )
      .find((candidate) => candidate.name === method.name);

    return symbol && isCallableSymbol(symbol)
      ? { symbol, methodStyle: true }
      : null;
  }

  const result = index.resolveSymbol(
    current.uri,
    context.callee,
    context.calleePosition,
  );
  const symbol = result.selected;

  return symbol && isCallableSymbol(symbol)
    ? { symbol, methodStyle: false }
    : null;
}

function keywordCompletions(): CompletionItem[] {
  return [
    ...C3_KEYWORDS.map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Keyword,
    })),
    ...C3_BUILTIN_ATTRIBUTES.map((attribute) => ({
      label: attribute,
      kind: CompletionItemKind.Property,
    })),
    ...C3_DEFINED_CONSTANTS.map((constant) => ({
      label: constant,
      kind: CompletionItemKind.Constant,
    })),
    ...C3_COMPILE_TIME_BUILTINS.map((builtin) => ({
      label: builtin,
      kind: CompletionItemKind.Function,
    })),
  ];
}

function memberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  receiver: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForExpression(current.uri, receiver, position)
    .map((symbol) => memberCompletionItem(symbol));
}

function memberCompletionItem(symbol: C3Symbol): CompletionItem {
  const item: CompletionItem = {
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  };

  if (symbol.kind === SymbolKind.Method) {
    item.insertText = `${symbol.name}($0)`;
    item.insertTextFormat = InsertTextFormat.Snippet;
  }

  return item;
}

function symbolCompletionItem(symbol: C3Symbol): CompletionItem {
  return {
    label: symbol.name,
    kind: toCompletionKind(symbol.kind),
    detail: symbol.signature,
  };
}

function autoImportCompletionItem(
  current: ParsedDocument,
  moduleName: string,
  symbol: C3Symbol,
): CompletionItem {
  return {
    ...symbolCompletionItem(symbol),
    detail: `${symbol.signature} (auto import ${moduleName})`,
    sortText: `~${symbol.name}`,
    additionalTextEdits: [importTextEdit(current, moduleName)],
  };
}

function methodCompletionsForType(
  index: ProjectIndex,
  current: ParsedDocument,
  typeName: string,
  position: Position,
): CompletionItem[] {
  return index
    .memberSymbolsForType(current.uri, typeName, position)
    .filter((symbol) => symbol.kind === SymbolKind.Method)
    .map((symbol) => ({
      label: symbol.name,
      kind: CompletionItemKind.Method,
      detail: symbol.signature,
    }));
}

function moduleMemberCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  prefix: string,
): CompletionItem[] {
  const mod = index.resolveModuleFromPrefix(current, prefix);
  const moduleItems = index
    .moduleChildNamesForPrefix(current, prefix)
    .map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      detail: `module ${prefix}::${name}`,
    }));

  if (!mod) return moduleItems;

  const symbols = [...mod.symbols.values()].flat();

  return [
    ...moduleItems,
    ...symbols.map((symbol) => ({
      label: symbol.name,
      kind: toCompletionKind(symbol.kind),
      detail: symbol.signature,
    })),
  ];
}

function modulePathCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  context: ModulePathCompletionContext,
): CompletionItem[] {
  return index
    .modulePathCandidates(current, context.pathPrefix)
    .map((candidate) => ({
      label: candidate.label,
      kind: CompletionItemKind.Module,
      detail: `module ${candidate.moduleName}`,
      textEdit: {
        range: context.replaceRange,
        newText: candidate.label,
      },
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

function uniqueCompletionItems(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const unique: CompletionItem[] = [];

  for (const item of items) {
    if (seen.has(item.label)) continue;

    seen.add(item.label);
    unique.push(item);
  }

  return unique;
}
