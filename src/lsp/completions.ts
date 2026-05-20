import {
  CompletionItemKind,
  InsertTextFormat,
  SymbolKind,
  type CompletionContext,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import {
  expectedTypeForExpression,
  initializerListAtPosition,
} from '../analysis/expression-context.js';
import { parseSource } from '../parser/c3-parser.js';
import type {
  ModuleCompletionCandidate,
  ProjectIndex,
} from '../project/project-index.js';
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
  identifierCompletionBeforeCursor,
  memberAccessBeforeCursor,
  methodContext,
  moduleNamespaceCompletionBeforeCursor,
  modulePathCompletionBeforeCursor,
  namedArgumentsBeforeCursor,
  structInitializerFieldBeforeCursor,
  type AttributeCompletionContext,
  type CallArgumentContext,
  type IdentifierCompletionContext,
  type ModuleNamespaceCompletionContext,
  type ModulePathCompletionContext,
  type StructInitializerFieldCompletionContext,
  typeMethodDeclarationBeforeCursor,
} from './completion-context.js';
import { contractCompletionItems } from './contracts.js';
import { importTextEdit } from './import-edits.js';

const MAX_AUTO_IMPORT_COMPLETIONS = 200;
const TRIGGER_PARAMETER_HINTS_COMMAND = 'editor.action.triggerParameterHints';

export function completionItems(
  index: ProjectIndex,
  doc: TextDocument | undefined,
  current: ParsedDocument | undefined,
  position: Position,
  _context?: CompletionContext,
): CompletionItem[] {
  if (!doc || !current) return keywordCompletions();

  const currentSyntax = parsedForCompletionSyntax(doc, current);
  const contractItems = contractCompletionItems(
    index,
    doc,
    currentSyntax,
    position,
  );
  if (contractItems) return contractItems;

  const modulePathCompletion = modulePathCompletionBeforeCursor(doc, position);

  if (modulePathCompletion) {
    return modulePathCompletions(index, currentSyntax, modulePathCompletion);
  }

  const attributeCompletion = attributeCompletionBeforeCursor(doc, position);

  if (attributeCompletion) {
    return attributeCompletions(
      index,
      currentSyntax,
      position,
      attributeCompletion,
    );
  }

  const typeMethodDeclaration = typeMethodDeclarationBeforeCursor(
    doc,
    position,
  );

  if (typeMethodDeclaration) {
    return methodCompletionsForType(
      index,
      currentSyntax,
      typeMethodDeclaration.receiver,
      typeMethodDeclaration.position,
    );
  }

  const memberAccess = memberAccessBeforeCursor(doc, position);

  if (memberAccess) {
    return memberCompletions(
      index,
      currentSyntax,
      memberAccess.receiver,
      memberAccess.position,
    );
  }

  const structInitializerField = structInitializerFieldBeforeCursor(
    doc,
    position,
  );

  if (structInitializerField) {
    return structInitializerFieldCompletions(
      index,
      currentSyntax,
      position,
      structInitializerField,
    );
  }

  if (dotAccessCompletionBeforeCursor(doc, position)) {
    return [];
  }

  const moduleNamespaceCompletion = moduleNamespaceCompletionBeforeCursor(
    currentSyntax,
    position,
  );

  if (moduleNamespaceCompletion) {
    return moduleMemberCompletions(
      index,
      currentSyntax,
      moduleNamespaceCompletion,
    );
  }

  const identifierCompletion = identifierCompletionBeforeCursor(doc, position);
  const argumentItems = argumentNameCompletions(
    index,
    doc,
    currentSyntax,
    position,
  );
  const visibleSymbols = index
    .visibleSymbolsAt(currentSyntax.uri, position)
    .filter((symbol) =>
      completionLabelMatchesPrefix(symbol.name, identifierCompletion.prefix),
    );
  const visibleNames = new Set(visibleSymbols.map((symbol) => symbol.name));
  const moduleCandidates = index.moduleCompletionCandidates(
    currentSyntax,
    identifierCompletion.prefix,
  );
  const moduleLabels = new Set(
    moduleCandidates.map((candidate) => candidate.label),
  );

  const symbolItems = visibleSymbols.map((symbol) =>
    identifierCompletionItem(
      symbolCompletionItem(symbol),
      identifierCompletion,
    ),
  );
  const moduleItems = moduleCandidates.map((candidate) =>
    identifierCompletionItem(
      moduleCompletionItem(candidate),
      identifierCompletion,
    ),
  );
  const autoImportItems =
    identifierCompletion.prefix.length > 0
      ? index
          .autoImportCandidates(currentSyntax, identifierCompletion.prefix)
          .slice(0, MAX_AUTO_IMPORT_COMPLETIONS)
          .filter(
            ({ symbol }) =>
              !visibleNames.has(symbol.name) && !moduleLabels.has(symbol.name),
          )
          .map(({ moduleName, symbol }) =>
            identifierCompletionItem(
              autoImportCompletionItem(currentSyntax, moduleName, symbol),
              identifierCompletion,
            ),
          )
      : [];

  return [
    ...argumentItems,
    ...keywordCompletions(identifierCompletion),
    ...moduleItems,
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

  const result = index.resolveCallableSymbol(
    current.uri,
    context.callee,
    context.calleePosition,
  );
  const symbol = result.selected;

  return symbol && isCallableSymbol(symbol)
    ? { symbol, methodStyle: false }
    : null;
}

function keywordCompletions(
  context?: IdentifierCompletionContext,
): CompletionItem[] {
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
  ]
    .filter((item) =>
      completionLabelMatchesPrefix(String(item.label), context?.prefix ?? ''),
    )
    .map((item) => identifierCompletionItem(item, context));
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
    item.command = {
      title: 'Trigger Parameter Hints',
      command: TRIGGER_PARAMETER_HINTS_COMMAND,
    };
  }

  return item;
}

function structInitializerFieldCompletions(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): CompletionItem[] {
  const typeName =
    context.typeName ??
    expectedInitializerTypeName(index, current, position, context);
  if (!typeName) return [];

  return index
    .memberSymbolsForType(current.uri, typeName, position)
    .filter(
      (symbol) =>
        symbol.kind === SymbolKind.Field &&
        symbol.name.startsWith(context.prefix),
    )
    .map((symbol) => {
      const newText = context.designatorDotTyped
        ? symbol.name
        : `.${symbol.name}`;

      return {
        ...memberCompletionItem(symbol),
        filterText: symbol.name,
        insertText: newText,
        sortText: `!${symbol.name}`,
        textEdit: {
          range: context.replaceRange,
          newText,
        },
      };
    });
}

function expectedInitializerTypeName(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): string | undefined {
  const initializer = initializerListAtPosition(
    current.tree.rootNode,
    position,
  );
  if (!initializer) {
    return expectedInitializerTypeNameFromRepairedDesignator(
      index,
      current,
      position,
      context,
    );
  }

  return (
    expectedTypeForExpression(index, current, initializer) ??
    expectedInitializerTypeNameFromRepairedDesignator(
      index,
      current,
      position,
      context,
    )
  );
}

function expectedInitializerTypeNameFromRepairedDesignator(
  index: ProjectIndex,
  current: ParsedDocument,
  position: Position,
  context: StructInitializerFieldCompletionContext,
): string | undefined {
  const start = offsetAtPosition(current.source, context.replaceRange.start);
  const end = offsetAtPosition(current.source, position);
  if (start == null || end == null || start > end) return undefined;

  const needsDot = current.source[start - 1] !== '.';
  const placeholder = `${needsDot ? '.' : ''}__c3_lsp_field`;
  const source = `${current.source.slice(0, start)}${placeholder}${current.source.slice(end)}`;
  const repairedPosition = positionAtOffset(source, start + placeholder.length);
  const repaired = parseSource(current.uri, source, {
    sourceKind: current.sourceKind,
  });
  const initializer = initializerListAtPosition(
    repaired.tree.rootNode,
    repairedPosition,
  );

  return initializer
    ? expectedTypeForExpression(index, repaired, initializer)
    : undefined;
}

function offsetAtPosition(
  source: string,
  position: Position,
): number | undefined {
  let line = 0;
  let character = 0;

  for (let offset = 0; offset < source.length; offset++) {
    if (line === position.line && character === position.character) {
      return offset;
    }

    if (source[offset] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return line === position.line && character === position.character
    ? source.length
    : undefined;
}

function positionAtOffset(source: string, targetOffset: number): Position {
  let line = 0;
  let character = 0;
  const boundedOffset = Math.max(0, Math.min(targetOffset, source.length));

  for (let offset = 0; offset < boundedOffset; offset++) {
    if (source[offset] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
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

function moduleCompletionItem(
  candidate: ModuleCompletionCandidate,
): CompletionItem {
  return {
    label: candidate.label,
    kind: CompletionItemKind.Module,
    detail: `module ${candidate.moduleName}`,
    sortText: candidate.sortText,
  };
}

function identifierCompletionItem(
  item: CompletionItem,
  context?: IdentifierCompletionContext,
): CompletionItem {
  if (!context?.prefix.startsWith('$')) return item;

  return {
    ...item,
    textEdit: {
      range: context.replaceRange,
      newText: item.insertText ?? String(item.label),
    },
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
  context: ModuleNamespaceCompletionContext,
): CompletionItem[] {
  const typeAccessItems = index
    .typeAccessMemberSymbols(current, context.prefix, context.replaceRange.start)
    .filter((symbol) =>
      completionLabelMatchesPrefix(symbol.name, context.memberPrefix),
    )
    .map((symbol) =>
      moduleNamespaceCompletionItem(
        {
          label: symbol.name,
          kind: toCompletionKind(symbol.kind),
          detail: symbol.signature,
        },
        context,
      ),
    );

  if (typeAccessItems.length > 0) {
    return uniqueCompletionItems(typeAccessItems);
  }

  const moduleItems = index
    .moduleChildNamesForPrefix(current, context.prefix)
    .filter((name) => completionLabelMatchesPrefix(name, context.memberPrefix))
    .map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      detail: `module ${context.prefix}::${name}`,
    }))
    .map((item) => moduleNamespaceCompletionItem(item, context));

  const symbolItems = index
    .moduleMemberSymbols(current, context.prefix)
    .filter((symbol) =>
      completionLabelMatchesPrefix(symbol.name, context.memberPrefix),
    )
    .map((symbol) =>
      moduleNamespaceCompletionItem(
        {
          label: symbol.name,
          kind: toCompletionKind(symbol.kind),
          detail: symbol.signature,
        },
        context,
      ),
    );

  return uniqueCompletionItems([...moduleItems, ...symbolItems]);
}

function moduleNamespaceCompletionItem(
  item: CompletionItem,
  context: ModuleNamespaceCompletionContext,
): CompletionItem {
  if (context.memberPrefix.length === 0) return item;

  return {
    ...item,
    textEdit: {
      range: context.replaceRange,
      newText: String(item.label),
    },
  };
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
    case SymbolKind.Module:
      return CompletionItemKind.Module;
    case SymbolKind.TypeParameter:
      return CompletionItemKind.TypeParameter;
    case SymbolKind.Variable:
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Text;
  }
}

function parsedForCompletionSyntax(
  doc: TextDocument,
  current: ParsedDocument,
): ParsedDocument {
  const source = doc.getText();

  return source === current.source
    ? current
    : parseSource(current.uri, source, { sourceKind: current.sourceKind });
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

function completionLabelMatchesPrefix(label: string, prefix: string): boolean {
  return prefix.length === 0 || label.startsWith(prefix);
}
