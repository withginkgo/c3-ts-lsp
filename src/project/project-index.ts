import {
  SymbolKind,
  type Position,
  type Range,
} from 'vscode-languageserver/node.js';

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
  const candidates = symbols
    .filter((symbol) => symbol.name === ref)
    .filter((symbol) => scopedSymbolVisibleAt(symbol, position));

  return candidates.sort((a, b) => compareScopedCandidates(a, b, position))[0];
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
