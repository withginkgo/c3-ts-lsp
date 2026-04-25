import type { C3Symbol, ModuleIndex, ParsedDocument } from '../shared/types.js';

export class ProjectIndex {
  private readonly parsedByUri = new Map<string, ParsedDocument>();
  private readonly modulesByName = new Map<string, ModuleIndex>();

  getParsed(uri: string): ParsedDocument | undefined {
    return this.parsedByUri.get(uri);
  }

  getModule(name: string): ModuleIndex | undefined {
    return this.modulesByName.get(name);
  }

  moduleCount(): number {
    return this.modulesByName.size;
  }

  upsert(parsed: ParsedDocument, rebuild = true): void {
    this.parsedByUri.set(parsed.uri, parsed);

    if (rebuild) {
      this.rebuild();
    }
  }

  remove(uri: string): void {
    this.parsedByUri.delete(uri);
    this.rebuild();
  }

  rebuild(): void {
    this.modulesByName.clear();

    for (const parsed of this.parsedByUri.values()) {
      if (!parsed.moduleName) continue;

      let mod = this.modulesByName.get(parsed.moduleName);

      if (!mod) {
        mod = {
          name: parsed.moduleName,
          files: [],
          symbols: new Map(),
          imports: new Set(),
        };

        this.modulesByName.set(parsed.moduleName, mod);
      }

      mod.files.push(parsed.uri);

      for (const imp of parsed.imports) {
        mod.imports.add(imp);
      }

      for (const sym of parsed.symbols) {
        const list = mod.symbols.get(sym.name) ?? [];
        list.push(sym);
        mod.symbols.set(sym.name, list);
      }
    }
  }

  findSymbol(currentUri: string, ref: string): C3Symbol | undefined {
    const current = this.parsedByUri.get(currentUri);
    if (!current) return undefined;

    if (ref.includes('::')) {
      return this.resolveQualifiedSymbol(current, ref);
    }

    const currentModule = this.modulesByName.get(current.moduleName);
    const local = currentModule?.symbols.get(ref)?.[0];

    if (local) return local;

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const importedModule = this.modulesByName.get(imp);
        const imported = importedModule?.symbols.get(ref)?.[0];

        if (imported) return imported;
      }
    }

    for (const mod of this.modulesByName.values()) {
      const found = mod.symbols.get(ref)?.[0];
      if (found) return found;
    }

    return undefined;
  }

  resolveModuleFromPrefix(
    current: ParsedDocument,
    prefix: string,
  ): ModuleIndex | undefined {
    const direct = this.modulesByName.get(prefix);
    if (direct) return direct;

    const currentModule = this.modulesByName.get(current.moduleName);

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);

        if (lastSegment === prefix) {
          return this.modulesByName.get(imp);
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
    const parts = ref.split('::');

    if (parts.length < 2) return undefined;

    const symbolName = parts[parts.length - 1];
    const modulePrefix = parts.slice(0, -1).join('::');

    const directModule = this.modulesByName.get(modulePrefix);
    const direct = directModule?.symbols.get(symbolName)?.[0];

    if (direct) return direct;

    const currentModule = this.modulesByName.get(current.moduleName);

    if (currentModule) {
      for (const imp of currentModule.imports) {
        const lastSegment = imp.split('::').at(-1);

        if (lastSegment === modulePrefix) {
          const importedModule = this.modulesByName.get(imp);
          const found = importedModule?.symbols.get(symbolName)?.[0];

          if (found) return found;
        }
      }
    }

    const relativeModuleName = `${current.moduleName}::${modulePrefix}`;
    const relativeModule = this.modulesByName.get(relativeModuleName);
    const relative = relativeModule?.symbols.get(symbolName)?.[0];

    if (relative) return relative;

    return undefined;
  }
}
