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
    const current = this.parsedByUri.get(currentUri);
    if (!current) return [];

    const receiver = this.resolveSymbol(
      currentUri,
      receiverRef,
      position,
    ).selected;
    const typeName = receiver?.returnType;
    if (!typeName) return [];

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
      return resultFromCandidates(this.qualifiedSymbolCandidates(current, ref));
    }

    const declared = findDeclaredSymbolAt(current.symbols, ref, position);
    if (declared) return resultFromCandidates([declared]);

    const scoped = findScopedSymbolAt(current.scopedSymbols, ref, position);
    if (scoped) return resultFromCandidates([scoped]);

    const moduleCandidates = this.visibleModuleSymbolCandidates(current, ref);
    if (moduleCandidates.length > 0) {
      return resultFromCandidates(moduleCandidates);
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
    if (expression.type === 'ident_expr') {
      const resolved = this.resolveSymbol(
        current.uri,
        expression.text,
        rangeFromNode(expression).start,
      ).selected;

      return resolved?.returnType ?? symbolTypeName(resolved);
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

    return undefined;
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

function normalizeTypeName(typeName: string): string {
  return typeName
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
