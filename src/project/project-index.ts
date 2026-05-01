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
import {
  collectionElementTypeName,
  nominalTypeName,
  normalizeTypeName,
  terminalTypeName,
} from '../shared/type-ref.js';
import {
  defaultC3Environment,
  normalizeC3Environment,
  parsedIsActiveInEnvironment,
} from './environment.js';

export type ProjectIndexOptions = {
  activeEnvironment?: Iterable<string>;
};

export class ProjectIndex {
  private readonly parsedByUri = new Map<string, ParsedDocument>();
  private readonly modulesByName = new Map<string, ModuleIndex>();
  private readonly activeEnvironment: Set<string>;

  constructor(options: ProjectIndexOptions = {}) {
    this.activeEnvironment = normalizeC3Environment(
      options.activeEnvironment ?? defaultC3Environment(),
    );
  }

  getParsed(uri: string): ParsedDocument | undefined {
    return this.parsedByUri.get(uri);
  }

  allParsed(): ParsedDocument[] {
    return [...this.parsedByUri.values()];
  }

  workspaceSymbols(query = ''): C3Symbol[] {
    const normalizedQuery = query.trim().toLowerCase();

    return this.allParsed()
      .filter(
        (parsed) =>
          parsed.sourceKind === 'workspace' && this.shouldIndexParsed(parsed),
      )
      .flatMap((parsed) => flattenSymbols(parsed.symbols))
      .filter((symbol) =>
        normalizedQuery
          ? [symbol.name, symbol.moduleName, symbol.signature].some((value) =>
              value.toLowerCase().includes(normalizedQuery),
            )
          : true,
      )
      .sort(compareSymbols);
  }

  getModule(name: string): ModuleIndex | undefined {
    return this.modulesByName.get(name);
  }

  resolveImportedModule(
    current: ParsedDocument,
    importPath: string,
  ): ModuleIndex | undefined {
    return this.resolveImportFromModule(current.moduleName, importPath);
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

    for (const importedModule of this.visibleImportedModules(current)) {
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

  typeNameForExpression(
    currentUri: string,
    expressionText: string,
    position: Position,
  ): string | undefined {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return undefined;

    return this.expressionTypeNameFromText(current, expressionText, position);
  }

  resolveTypeName(
    currentUri: string,
    typeName: string,
    position: Position,
  ): ResolveResult {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return { candidates: [], reason: 'not_found' };

    return this.resultFromCandidates(
      this.typeSymbolCandidates(current, nominalTypeName(typeName), position),
    );
  }

  importCandidatesForSymbol(
    current: ParsedDocument,
    ref: string,
  ): Array<{ moduleName: string; symbol: C3Symbol }> {
    const imported = this.importedModuleNameSet(current);
    const candidates: Array<{ moduleName: string; symbol: C3Symbol }> = [];

    for (const mod of this.modulesByName.values()) {
      if (
        !mod.name ||
        mod.name === current.moduleName ||
        imported.has(mod.name)
      ) {
        continue;
      }

      const visible = (mod.symbols.get(ref) ?? []).find((symbol) =>
        isVisibleFrom(symbol, current.moduleName),
      );

      if (visible) {
        candidates.push({ moduleName: mod.name, symbol: visible });
      }
    }

    return candidates.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  }

  autoImportCandidates(
    current: ParsedDocument,
    prefix = '',
  ): Array<{ moduleName: string; symbol: C3Symbol }> {
    const imported = this.importedModuleNameSet(current);
    const candidates: Array<{ moduleName: string; symbol: C3Symbol }> = [];

    for (const mod of this.modulesByName.values()) {
      if (
        !mod.name ||
        mod.name === current.moduleName ||
        imported.has(mod.name)
      ) {
        continue;
      }

      for (const [name, symbols] of mod.symbols) {
        if (prefix.length > 0 && !name.startsWith(prefix)) continue;

        for (const symbol of symbols) {
          if (!isVisibleFrom(symbol, current.moduleName)) continue;

          candidates.push({ moduleName: mod.name, symbol });
        }
      }
    }

    return candidates.sort(compareAutoImportCandidates);
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

    for (const importedModule of this.visibleImportedAndChildModules(current)) {
      const imported = importedModule.allSymbols
        .get(ref)
        ?.find((symbol) => isVisibleFrom(symbol, current.moduleName));

      if (imported) return imported;
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
      return this.resultFromCandidates(memberCandidates);
    }

    if (ref.includes('::')) {
      return this.resultFromCandidates(
        this.qualifiedSymbolCandidates(current, ref),
      );
    }

    const declared = findDeclaredSymbolAt(current.symbols, ref, position);
    if (declared) return this.resultFromCandidates([declared]);

    const scoped = findScopedSymbolAt(current.scopedSymbols, ref, position);
    if (scoped) return this.resultFromCandidates([scoped]);

    const moduleCandidates = this.visibleModuleSymbolCandidates(current, ref);
    if (moduleCandidates.length > 0) {
      return this.resultFromCandidates(moduleCandidates);
    }

    return this.resultFromCandidates(
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
      nominalTypeName(symbol.returnType),
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

    for (const importedModule of this.visibleImportedAndChildModules(current)) {
      imported.push(
        ...(importedModule.symbols.get(ref) ?? []).filter((symbol) =>
          isVisibleFrom(symbol, current.moduleName),
        ),
      );
    }

    return imported;
  }

  resolveModuleFromPrefix(
    current: ParsedDocument,
    prefix: string,
  ): ModuleIndex | undefined {
    const resolvedName = this.resolveModuleNameFromPrefix(current, prefix);
    return resolvedName ? this.modulesByName.get(resolvedName) : undefined;
  }

  moduleChildNamesForPrefix(current: ParsedDocument, prefix: string): string[] {
    const resolvedPrefix =
      this.resolveModuleNameFromPrefix(current, prefix) ?? prefix;
    const childPrefix = `${resolvedPrefix}::`;
    const childNames = new Set<string>();

    for (const moduleName of this.modulesByName.keys()) {
      if (!moduleName.startsWith(childPrefix)) continue;

      const childName = moduleName.slice(childPrefix.length).split('::')[0];
      if (childName) childNames.add(childName);
    }

    return [...childNames].sort((a, b) => a.localeCompare(b));
  }

  modulePathCandidates(
    current: ParsedDocument,
    pathPrefix: string,
  ): Array<{ label: string; moduleName: string }> {
    const path = pathPrefix.trim();
    const parts = path.length > 0 ? path.split('::') : [];
    const segmentPrefix = parts.pop() ?? '';
    const parentPath = parts.join('::');
    const candidates = new Map<string, { label: string; moduleName: string }>();

    if (parentPath.length === 0) {
      for (const moduleName of this.modulesByName.keys()) {
        const label = moduleName.split('::')[0];

        if (label.startsWith(segmentPrefix)) {
          candidates.set(`absolute:${label}`, {
            label,
            moduleName: label,
          });
        }
      }

      for (const candidate of this.relativeModulePathCandidates(
        current,
        '',
        segmentPrefix,
      )) {
        candidates.set(
          `relative:${candidate.label}:${candidate.moduleName}`,
          candidate,
        );
      }

      return [...candidates.values()].sort(compareModulePathCandidates);
    }

    const parentNames = new Set<string>([parentPath]);
    const resolvedParent = this.resolveImportFromModule(
      current.moduleName,
      parentPath,
    );

    if (resolvedParent) {
      parentNames.add(resolvedParent.name);
    }

    if (current.moduleName) {
      parentNames.add(`${current.moduleName}::${parentPath}`);
    }

    for (const parentName of parentNames) {
      for (const moduleName of this.modulesByName.keys()) {
        if (!moduleName.startsWith(`${parentName}::`)) {
          continue;
        }

        const remainder = moduleName
          .slice(parentName.length + 2)
          .split('::')[0];
        if (!remainder || !remainder.startsWith(segmentPrefix)) continue;

        const completedModuleName = `${parentName}::${remainder}`;
        candidates.set(`${remainder}:${completedModuleName}`, {
          label: remainder,
          moduleName: completedModuleName,
        });
      }
    }

    return [...candidates.values()].sort(compareModulePathCandidates);
  }

  private relativeModulePathCandidates(
    current: ParsedDocument,
    parentPath: string,
    segmentPrefix: string,
  ): Array<{ label: string; moduleName: string }> {
    if (!current.moduleName) return [];

    const prefix = parentPath
      ? `${current.moduleName}::${parentPath}::`
      : `${current.moduleName}::`;
    const candidates = new Map<string, { label: string; moduleName: string }>();

    for (const moduleName of this.modulesByName.keys()) {
      if (!moduleName.startsWith(prefix)) continue;

      const label = moduleName.slice(prefix.length).split('::')[0];
      if (!label || !label.startsWith(segmentPrefix)) continue;

      candidates.set(`${label}:${moduleName}`, {
        label,
        moduleName: `${prefix}${label}`,
      });
    }

    return [...candidates.values()];
  }

  private resolveModuleNameFromPrefix(
    current: ParsedDocument,
    prefix: string,
  ): string | undefined {
    if (this.modulesByName.has(prefix)) return prefix;

    const currentModule = this.modulesByName.get(current.moduleName);

    const aliased = currentModule?.moduleAliases.get(prefix);
    if (aliased) return this.resolveImportedModule(current, aliased)?.name;

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);

        if (lastSegment === prefix) {
          return this.resolveImportedModule(current, imp)?.name;
        }
      }
    }

    const importedChild = this.importedChildModuleForPrefix(current, prefix);
    if (importedChild) return importedChild.name;

    const relative = this.modulesByName.get(`${current.moduleName}::${prefix}`);
    if (relative) return relative.name;

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

    // 1. 直接按完整模块名查找
    const directModule = this.modulesByName.get(modulePrefix);
    if (directModule) {
      return (
        directModule.allSymbols
          .get(symbolName)
          ?.filter((symbol) => isVisibleFrom(symbol, current.moduleName)) ?? []
      );
    }

    const currentModule = this.modulesByName.get(current.moduleName);

    // 2. 检查模块别名
    const aliased = currentModule?.moduleAliases.get(modulePrefix);
    if (aliased) {
      const aliasedModule = this.resolveImportedModule(current, aliased);
      if (aliasedModule) {
        return (
          aliasedModule.allSymbols
            .get(symbolName)
            ?.filter((symbol) => isVisibleFrom(symbol, current.moduleName)) ??
          []
        );
      }
    }

    // 3. 如果 modulePrefix 不含双冒号，尝试匹配导入的最后一段（例如 io -> std::io）
    if (currentModule && !modulePrefix.includes('::')) {
      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);
        if (lastSegment === modulePrefix) {
          const importedModule = this.resolveImportedModule(current, imp);
          if (importedModule) {
            const symbols =
              importedModule.allSymbols
                .get(symbolName)
                ?.filter((symbol) =>
                  isVisibleFrom(symbol, current.moduleName),
                ) ?? [];
            if (symbols.length > 0) return symbols;
          }
        }
      }
    }

    // 4. 检查导入模块下的子模块，例如 import std::thread 后的 channel::create_buffered
    const importedChild = this.importedChildModuleForPrefix(
      current,
      modulePrefix,
    );
    if (importedChild) {
      return (
        importedChild.allSymbols
          .get(symbolName)
          ?.filter((symbol) => isVisibleFrom(symbol, current.moduleName)) ?? []
      );
    }

    // 5. 尝试当前模块的相对路径解析
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

    const importedCandidates: C3Symbol[] = [];

    for (const importedModule of this.visibleImportedModules(current)) {
      const imported = findUnqualifiedNestedUsageSymbol(importedModule, ref);

      if (imported && isVisibleFrom(imported, current.moduleName)) {
        importedCandidates.push(imported);
      }
    }

    if (importedCandidates.length > 0) return importedCandidates;

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

    if (expression.type === 'type') {
      return expression.text;
    }

    if (expression.type === 'ident_expr') {
      const expressionPosition = rangeFromNode(expression).start;
      const resolved = this.resolveSymbol(
        current.uri,
        expression.text,
        expressionPosition,
      ).selected;

      return (
        resolved?.returnType ??
        symbolTypeName(resolved) ??
        this.foreachVariableTypeName(
          current,
          expression.text,
          expressionPosition,
        ) ??
        this.varDeclarationTypeName(
          current,
          expression.text,
          expressionPosition,
        ) ??
        recoverableLocalTypeName(current, expression.text, expressionPosition)
      );
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

    if (expression.type === 'elvis_orelse_expr') {
      const condition = expression.childForFieldName('condition');
      if (!condition) return undefined;

      const conditionType = this.expressionTypeName(
        current,
        condition,
        rangeFromNode(condition).start,
      );

      return conditionType ? normalizeTypeName(conditionType) : undefined;
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
      return indexedType ? collectionElementTypeName(indexedType) : undefined;
    }

    if (expression.type === 'paren_expr') {
      const inner = expression.namedChildren[0];
      return inner
        ? this.expressionTypeName(current, inner, position)
        : undefined;
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
        typeName = collectionElementTypeName(typeName);
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

    return this.expressionTypeName(
      current,
      expression,
      rangeFromNode(node).start,
    );
  }

  private baseExpressionTypeNameFromText(
    current: ParsedDocument,
    expressionText: string,
    position: Position,
  ): string | undefined {
    const text = stripOuterParens(expressionText.trim());
    if (!text) return undefined;

    const orelse = splitTopLevelOrelseExpression(text);
    if (orelse) {
      const conditionType = this.baseExpressionTypeNameFromText(
        current,
        orelse.condition,
        position,
      );
      return conditionType ? normalizeTypeName(conditionType) : undefined;
    }

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
      return baseType ? collectionElementTypeName(baseType) : undefined;
    }

    const call = splitCallExpression(text);
    if (call) {
      return this.resolveSymbol(current.uri, call.functionRef, position)
        .selected?.returnType;
    }

    if (isReferenceText(text)) {
      const resolved = this.resolveSymbol(current.uri, text, position).selected;
      return (
        resolved?.returnType ??
        symbolTypeName(resolved) ??
        this.foreachVariableTypeName(current, text, position) ??
        this.varDeclarationTypeName(current, text, position) ??
        recoverableLocalTypeName(current, text, position)
      );
    }

    return undefined;
  }

  private foreachVariableTypeName(
    current: ParsedDocument,
    ref: string,
    position: Position,
  ): string | undefined {
    if (!/^[A-Za-z_$@][A-Za-z0-9_$@]*$/.test(ref)) return undefined;

    const candidates = foreachVariableCandidatesAt(
      current.tree.rootNode,
      ref,
      position,
    );

    for (const candidate of candidates) {
      const explicitType = directChildOfType(candidate.variable, 'type')?.text;
      if (explicitType) return explicitType;

      if (candidate.role === 'index') return 'usz';

      const collection = candidate.condition.childForFieldName('collection');
      if (!collection) continue;

      const collectionType = this.expressionTypeName(
        current,
        collection,
        rangeFromNode(collection).start,
      );
      if (!collectionType) continue;

      const elementType = collectionElementTypeName(collectionType);
      if (!elementType) continue;

      return foreachVariableByReference(candidate.variable)
        ? `${normalizeTypeName(elementType)}*`
        : elementType;
    }

    return undefined;
  }

  private varDeclarationTypeName(
    current: ParsedDocument,
    ref: string,
    position: Position,
  ): string | undefined {
    if (!/^[A-Za-z_$@][A-Za-z0-9_$@]*$/.test(ref)) return undefined;

    for (const declaration of varDeclarationCandidatesAt(
      current.tree.rootNode,
      ref,
      position,
    )) {
      if (!varDeclarationAllowed(declaration)) continue;

      const right = declaration.childForFieldName('right');
      if (!right || right.text === ref) continue;

      const typeName = this.expressionTypeName(
        current,
        right,
        rangeFromNode(right).start,
      );
      if (typeName) return typeName;
    }

    return undefined;
  }

  private membersForTypeName(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): C3Symbol[] {
    const symbols: C3Symbol[] = [];
    const shadowedNames = new Set<string>();

    for (const expandedTypeName of this.expandTypeAliases(
      current,
      typeName,
      position,
    )) {
      const nominalType = nominalTypeName(expandedTypeName);
      if (!nominalType) continue;

      const typeSymbol = this.resolveTypeSymbol(current, nominalType, position);
      const concreteMembers = [
        ...(typeSymbol?.children ?? []),
        ...this.methodSymbolsForTypeName(current, expandedTypeName, typeSymbol),
      ];
      const expansionMembers = [
        ...concreteMembers,
        ...this.interfaceMemberSymbolsForType(
          current,
          typeSymbol,
          concreteMembers,
        ),
      ];

      symbols.push(
        ...expansionMembers.filter((member) => !shadowedNames.has(member.name)),
      );

      for (const member of expansionMembers) {
        shadowedNames.add(member.name);
      }
    }

    return uniqueSymbols(symbols).sort(compareSymbols);
  }

  private expandTypeAliases(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): string[] {
    const expanded: string[] = [];
    const visited = new Set<string>();
    let currentType: string | undefined = typeName;

    while (currentType) {
      const normalized = normalizeTypeName(currentType);
      if (!normalized || visited.has(normalized)) break;

      visited.add(normalized);
      expanded.push(currentType);
      currentType = this.typeAliasTargetName(current, normalized, position);
    }

    return expanded;
  }

  private typeAliasTargetName(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): string | undefined {
    const candidates = typeName.includes('::')
      ? this.qualifiedSymbolCandidates(current, typeName)
      : this.visibleModuleSymbolCandidates(current, typeName);

    return this.resultFromCandidates(
      candidates.filter((symbol) => symbol.kind === SymbolKind.TypeParameter),
    ).selected?.returnType;
  }

  private methodSymbolsForTypeName(
    current: ParsedDocument,
    typeName: string,
    typeSymbol: C3Symbol | undefined,
  ): C3Symbol[] {
    return uniqueMethodSymbols(
      this.visibleSymbolsForMemberLookup(current).filter(
        (symbol) =>
          symbol.kind === SymbolKind.Method &&
          receiverTypeMatches(symbol.receiverType, typeName, typeSymbol),
      ),
    ).sort(compareSymbols);
  }

  private interfaceMemberSymbolsForType(
    current: ParsedDocument,
    typeSymbol: C3Symbol | undefined,
    concreteMembers: C3Symbol[],
  ): C3Symbol[] {
    if (!typeSymbol?.implementedInterfaces?.length) return [];

    const shadowedNames = new Set(concreteMembers.map((member) => member.name));
    const members: C3Symbol[] = [];

    for (const interfaceSymbol of this.implementedInterfaceSymbolsForType(
      current,
      typeSymbol,
    )) {
      for (const member of interfaceSymbol.children) {
        if (shadowedNames.has(member.name)) continue;

        shadowedNames.add(member.name);
        members.push(member);
      }
    }

    return members;
  }

  private implementedInterfaceSymbolsForType(
    current: ParsedDocument,
    typeSymbol: C3Symbol,
    seen = new Set<string>(),
  ): C3Symbol[] {
    const owner = this.parsedByUri.get(typeSymbol.uri) ?? current;
    const interfaces: C3Symbol[] = [];

    for (const interfaceName of typeSymbol.implementedInterfaces ?? []) {
      const interfaceSymbol = this.resolveTypeSymbol(
        owner,
        interfaceName,
        typeSymbol.selectionRange.start,
      );

      if (!interfaceSymbol || interfaceSymbol.kind !== SymbolKind.Interface) {
        continue;
      }

      const key = [
        interfaceSymbol.uri,
        interfaceSymbol.selectionRange.start.line,
        interfaceSymbol.selectionRange.start.character,
      ].join(':');
      if (seen.has(key)) continue;

      seen.add(key);
      interfaces.push(interfaceSymbol);
      interfaces.push(
        ...this.implementedInterfaceSymbolsForType(
          owner,
          interfaceSymbol,
          seen,
        ),
      );
    }

    return interfaces;
  }

  private resolveTypeSymbol(
    current: ParsedDocument,
    typeName: string,
    position: Position,
  ): C3Symbol | undefined {
    return this.resultFromCandidates(
      this.typeSymbolCandidates(current, typeName, position).filter(
        isConcreteTypeSymbol,
      ),
    ).selected;
  }

  private typeSymbolCandidates(
    current: ParsedDocument,
    typeName: string,
    _position: Position,
  ): C3Symbol[] {
    if (!typeName) return [];

    const candidates = typeName.includes('::')
      ? this.qualifiedSymbolCandidates(current, typeName)
      : [
          ...this.visibleModuleSymbolCandidates(current, typeName),
          ...this.visibleSymbolsForMemberLookup(current).filter(
            (symbol) => symbol.name === typeName,
          ),
        ];

    const typeSymbols = candidates.filter((symbol) =>
      isTypeReferenceSymbol(symbol),
    );

    if (typeSymbols.length > 0) return uniqueSymbols(typeSymbols);

    return this.visibleSymbolsForMemberLookup(current)
      .filter(
        (symbol) =>
          symbol.kind === SymbolKind.Method &&
          receiverTypeMatches(symbol.receiverType, typeName, undefined),
      )
      .slice(0, 1);
  }

  private visibleSymbolsForMemberLookup(current: ParsedDocument): C3Symbol[] {
    const currentModule = this.modulesByName.get(current.moduleName);
    if (!currentModule) return [];

    const symbols = [...currentModule.symbols.values()].flat();
    const visited = new Set([currentModule.name]);

    for (const importedModule of this.visibleImportedAndChildModules(current)) {
      this.collectModuleAndImports(
        importedModule,
        current.moduleName,
        symbols,
        visited,
      );
    }

    return symbols;
  }

  private visibleImportedAndChildModules(
    current: ParsedDocument,
  ): ModuleIndex[] {
    const importedModules = this.visibleImportedModules(current);
    const modules = [...importedModules];
    const seen = new Set(modules.map((mod) => mod.name));

    for (const importedModule of this.explicitImportedModules(current)) {
      for (const childModule of this.directChildModules(importedModule.name)) {
        if (seen.has(childModule.name)) continue;

        seen.add(childModule.name);
        modules.push(childModule);
      }
    }

    return modules;
  }

  private importedChildModuleForPrefix(
    current: ParsedDocument,
    prefix: string,
  ): ModuleIndex | undefined {
    for (const importedModule of this.visibleImportedModules(current)) {
      const childModule = this.modulesByName.get(
        `${importedModule.name}::${prefix}`,
      );
      if (childModule) return childModule;
    }

    return undefined;
  }

  private directChildModules(moduleName: string): ModuleIndex[] {
    const prefix = `${moduleName}::`;

    return [...this.modulesByName.values()]
      .filter((mod) => {
        if (!mod.name.startsWith(prefix)) return false;

        return !mod.name.slice(prefix.length).includes('::');
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private collectModuleAndImports(
    mod: ModuleIndex,
    requesterModuleName: string,
    symbols: C3Symbol[],
    visited: Set<string>,
  ): void {
    if (visited.has(mod.name)) return;

    visited.add(mod.name);
    symbols.push(
      ...[...mod.symbols.values()]
        .flat()
        .filter((symbol) => isVisibleFrom(symbol, requesterModuleName)),
    );

    this.collectImportedSymbols(mod, requesterModuleName, symbols, visited);
  }

  private collectImportedSymbols(
    mod: ModuleIndex,
    requesterModuleName: string,
    symbols: C3Symbol[],
    visited: Set<string>,
  ): void {
    for (const imp of mod.imports) {
      const importedModule = this.resolveImportFromModule(mod.name, imp);
      if (!importedModule) continue;

      this.collectModuleAndImports(
        importedModule,
        requesterModuleName,
        symbols,
        visited,
      );
    }
  }

  private visibleImportedModules(current: ParsedDocument): ModuleIndex[] {
    const modules = this.explicitImportedModules(current);
    const seen = new Set(modules.map((mod) => mod.name));

    for (const implicitModule of this.implicitCoreModules()) {
      if (seen.has(implicitModule.name)) continue;

      seen.add(implicitModule.name);
      modules.push(implicitModule);
    }

    return modules;
  }

  private explicitImportedModules(current: ParsedDocument): ModuleIndex[] {
    const currentModule = this.modulesByName.get(current.moduleName);
    if (!currentModule) return [];

    const modules: ModuleIndex[] = [];
    const seen = new Set<string>();

    for (const imp of currentModule.imports) {
      const importedModule = this.resolveImportedModule(current, imp);
      if (!importedModule || seen.has(importedModule.name)) continue;

      seen.add(importedModule.name);
      modules.push(importedModule);
    }

    return modules;
  }

  private implicitCoreModules(): ModuleIndex[] {
    return [...this.modulesByName.values()]
      .filter((mod) => isImplicitCoreModuleName(mod.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private importedModuleNameSet(current: ParsedDocument): Set<string> {
    return new Set([
      current.moduleName,
      ...this.visibleImportedModules(current).map((mod) => mod.name),
    ]);
  }

  private resolveImportFromModule(
    moduleName: string,
    importPath: string,
  ): ModuleIndex | undefined {
    return (
      this.modulesByName.get(importPath) ??
      this.modulesByName.get(`${moduleName}::${importPath}`)
    );
  }

  private rebuildAffectedModules(
    ...moduleNames: Array<string | undefined>
  ): void {
    for (const moduleName of new Set(moduleNames)) {
      this.rebuildModule(moduleName);
    }
  }

  private rebuildModule(moduleName: string | undefined): void {
    if (moduleName == null) return;

    this.modulesByName.delete(moduleName);

    for (const parsed of this.parsedByUri.values()) {
      if (parsed.moduleName === moduleName) {
        this.addParsedToModule(parsed);
      }
    }
  }

  private addParsedToModule(parsed: ParsedDocument): void {
    if (!this.shouldIndexParsed(parsed)) return;

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

  private shouldIndexParsed(parsed: ParsedDocument): boolean {
    return parsedIsActiveInEnvironment(parsed, this.activeEnvironment);
  }

  private resultFromCandidates(candidates: C3Symbol[]): ResolveResult {
    return resultFromCandidates(candidates);
  }

  private addReferenceLocation(
    parsed: ParsedDocument,
    ref: SyntaxNode,
    target: C3Symbol,
    locations: Location[],
  ): void {
    if (referenceTerminalName(ref.text) !== target.name) return;

    const resolved = this.resolveSymbol(
      parsed.uri,
      ref.text,
      rangeFromNode(ref).start,
    ).selected;

    if (resolved && sameSymbol(resolved, target)) {
      locations.push(
        Location.create(parsed.uri, referenceNameRange(ref, target.name)),
      );
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

function isImplicitCoreModuleName(moduleName: string): boolean {
  return moduleName === 'std::core' || moduleName.startsWith('std::core::');
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

function nearestExpressionNode(
  node: SyntaxNode | null,
): SyntaxNode | undefined {
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
  'elvis_orelse_expr',
]);

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

function uniqueMethodSymbols(symbols: C3Symbol[]): C3Symbol[] {
  const seen = new Set<string>();
  const unique: C3Symbol[] = [];

  for (const symbol of symbols) {
    const key = methodShapeKey(symbol);
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(symbol);
  }

  return unique;
}

function uniqueSymbols(symbols: C3Symbol[]): C3Symbol[] {
  const seen = new Set<string>();
  const unique: C3Symbol[] = [];

  for (const symbol of symbols) {
    const key = [
      symbol.uri,
      symbol.selectionRange.start.line,
      symbol.selectionRange.start.character,
      symbol.selectionRange.end.line,
      symbol.selectionRange.end.character,
      methodShapeKey(symbol),
    ].join(':');

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(symbol);
  }

  return unique;
}

function methodShapeKey(symbol: C3Symbol): string {
  return [
    terminalTypeName(symbol.receiverType ?? ''),
    symbol.name,
    normalizeTypeName(symbol.returnType ?? ''),
    parameterTypes(symbol).map(normalizeTypeName).join(','),
  ].join('|');
}

function compareModulePathCandidates(
  a: { label: string; moduleName: string },
  b: { label: string; moduleName: string },
): number {
  return (
    a.label.localeCompare(b.label) || a.moduleName.localeCompare(b.moduleName)
  );
}

function compareAutoImportCandidates(
  a: { moduleName: string; symbol: C3Symbol },
  b: { moduleName: string; symbol: C3Symbol },
): number {
  return (
    a.symbol.name.localeCompare(b.symbol.name) ||
    a.moduleName.localeCompare(b.moduleName) ||
    compareSymbols(a.symbol, b.symbol)
  );
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

function referenceTerminalName(ref: string): string {
  return ref.split('::').at(-1) ?? ref;
}

function referenceNameRange(ref: SyntaxNode, name: string): Range {
  const offset = Math.max(0, ref.text.lastIndexOf(name));

  return Range.create(
    ref.startPosition.row,
    ref.startPosition.column + offset,
    ref.startPosition.row,
    ref.startPosition.column + offset + name.length,
  );
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

type ForeachVariableCandidate = {
  condition: SyntaxNode;
  variable: SyntaxNode;
  role: 'index' | 'value';
  scopeRange: Range;
};

function foreachVariableCandidatesAt(
  root: SyntaxNode,
  ref: string,
  position: Position,
): ForeachVariableCandidate[] {
  const candidates: ForeachVariableCandidate[] = [];

  function visit(node: SyntaxNode): void {
    if (
      node.type === 'foreach_cond' &&
      foreachConditionVisibleAt(node, position)
    ) {
      for (const variable of directChildrenOfType(node, 'foreach_var')) {
        const name = directChildOfType(variable, 'ident');
        if (name?.text !== ref) continue;

        const owner =
          ancestorOfType(node, 'foreach_stmt') ?? node.parent ?? node;

        candidates.push({
          condition: node,
          variable,
          role: foreachVariableRole(node, variable),
          scopeRange: rangeFromNode(owner),
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  return candidates.sort(
    (a, b) =>
      rangeSize(a.scopeRange) - rangeSize(b.scopeRange) ||
      comparePositions(
        rangeFromNode(b.condition).start,
        rangeFromNode(a.condition).start,
      ),
  );
}

function foreachConditionVisibleAt(
  condition: SyntaxNode,
  position: Position,
): boolean {
  if (comparePositions(rangeFromNode(condition).start, position) > 0) {
    return false;
  }

  const owner = ancestorOfType(condition, 'foreach_stmt') ?? condition.parent;
  if (!owner) return false;

  const body = owner.childForFieldName('body');
  if (body && positionInRange(position, rangeFromNode(body))) return true;

  return positionInRange(position, rangeFromNode(owner));
}

function foreachVariableRole(
  condition: SyntaxNode,
  variable: SyntaxNode,
): 'index' | 'value' {
  const index = condition.childForFieldName('index');
  if (index && sameSyntaxNode(index, variable)) return 'index';

  const value = condition.childForFieldName('value');
  if (value && sameSyntaxNode(value, variable)) return 'value';

  const variables = directChildrenOfType(condition, 'foreach_var');
  return variables.length > 1 && sameSyntaxNode(variables[0], variable)
    ? 'index'
    : 'value';
}

function foreachVariableByReference(variable: SyntaxNode): boolean {
  const name = directChildOfType(variable, 'ident');
  if (!name) return false;

  const prefix = variable.text.slice(
    0,
    Math.max(0, variable.text.lastIndexOf(name.text)),
  );
  return prefix.includes('&');
}

function varDeclarationCandidatesAt(
  root: SyntaxNode,
  ref: string,
  position: Position,
): SyntaxNode[] {
  const candidates: Array<{ declaration: SyntaxNode; scopeRange: Range }> = [];

  function visit(node: SyntaxNode): void {
    if (node.type === 'var_declaration') {
      const name = node.childForFieldName('name');
      const scope =
        ancestorOfType(node, 'compound_stmt') ??
        ancestorOfType(node, 'ERROR') ??
        node.parent;

      if (
        name?.text === ref &&
        scope &&
        varDeclarationAllowed(node) &&
        comparePositions(rangeFromNode(name).end, position) <= 0 &&
        positionInRange(position, rangeFromNode(scope))
      ) {
        candidates.push({
          declaration: node,
          scopeRange: rangeFromNode(scope),
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  return candidates
    .sort(
      (a, b) =>
        rangeSize(a.scopeRange) - rangeSize(b.scopeRange) ||
        comparePositions(
          rangeFromNode(b.declaration).start,
          rangeFromNode(a.declaration).start,
        ),
    )
    .map((candidate) => candidate.declaration);
}

function varDeclarationAllowed(declaration: SyntaxNode): boolean {
  return (
    !!ancestorOfType(declaration, 'macro_declaration') ||
    hasAttribute(declaration, '@safeinfer') ||
    varDeclarationInitializesLambda(declaration)
  );
}

function varDeclarationInitializesLambda(declaration: SyntaxNode): boolean {
  const right = declaration.childForFieldName('right');

  return !!right && right.type.startsWith('lambda_');
}

function hasAttribute(node: SyntaxNode, name: string): boolean {
  for (const attributes of directChildrenOfType(node, 'attributes')) {
    for (const attribute of directChildrenOfType(attributes, 'attribute')) {
      if (attribute.text.split('(')[0] === name) return true;
    }
  }

  return false;
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

function directChildOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function directChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === type);
}

function sameSyntaxNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
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

function splitTopLevelOrelseExpression(
  text: string,
): { condition: string; alternative: string } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = 0; index < text.length - 1; index++) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote !== '`' && char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && text.slice(index, index + 2) === '??') {
      const condition = text.slice(0, index).trim();
      const alternative = text.slice(index + 2).trim();
      if (!condition || !alternative) return undefined;

      return { condition, alternative };
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
    const candidate = match[1].trim();
    if (candidate !== 'var') found = candidate;
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

function symbolTypeName(symbol: C3Symbol | undefined): string | undefined {
  if (!symbol) return undefined;

  if (isTypeSymbol(symbol)) {
    return symbol.name;
  }

  return undefined;
}

function receiverTypeMatches(
  receiverType: string | undefined,
  typeName: string,
  typeSymbol: C3Symbol | undefined,
): boolean {
  if (!receiverType) return false;

  const receiver = nominalTypeName(receiverType);
  const target = nominalTypeName(typeName);

  return (
    receiver === target ||
    receiver === typeSymbol?.name ||
    terminalTypeName(receiver) === terminalTypeName(target)
  );
}

function isTypeSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Struct ||
    symbol.kind === SymbolKind.Enum ||
    symbol.kind === SymbolKind.Interface ||
    isConstdefSymbol(symbol)
  );
}

function isConcreteTypeSymbol(symbol: C3Symbol): boolean {
  return isTypeSymbol(symbol);
}

function isTypeReferenceSymbol(symbol: C3Symbol): boolean {
  return isTypeSymbol(symbol) || symbol.kind === SymbolKind.TypeParameter;
}

function isConstdefSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Constant &&
    symbol.signature.startsWith('constdef ') &&
    symbol.children.length > 0
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
