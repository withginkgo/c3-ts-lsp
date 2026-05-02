import { Range, SymbolKind } from 'vscode-languageserver/node.js';

import type { C3Symbol } from './types.js';
import { terminalTypeName } from './type-ref.js';

export const builtinTypeNames = new Set([
  'any',
  'anyfault',
  'bool',
  'bfloat',
  'bfloat16',
  'char',
  'double',
  'float',
  'float16',
  'float128',
  'fault',
  'ichar',
  'int',
  'int128',
  'iptr',
  'isz',
  'long',
  'short',
  'String',
  'sz',
  'typeid',
  'uint',
  'uint128',
  'ulong',
  'untypedlist',
  'uptr',
  'ushort',
  'usz',
  'void',
]);

const builtinUri = 'c3:/builtin/types';
const builtinModuleName = 'std::core::builtin';
const zeroRange = Range.create(0, 0, 0, 0);
const integerTypeNames = new Set([
  'char',
  'ichar',
  'int',
  'int128',
  'iptr',
  'isz',
  'long',
  'short',
  'sz',
  'uint',
  'uint128',
  'ulong',
  'uptr',
  'ushort',
  'usz',
]);

const builtinSymbols = new Map<string, C3Symbol>(
  [
    builtinAggregate('any', [
      builtinField('ptr', 'void*'),
      builtinField('type', 'typeid'),
    ]),
    ...[...builtinTypeNames]
      .filter((name) => name !== 'any')
      .map((name) => builtinType(name)),
  ].map((symbol) => [symbol.name, symbol]),
);

export function isBuiltinTypeName(typeName: string | undefined): boolean {
  return builtinTypeNames.has(terminalTypeName(typeName ?? ''));
}

export function builtinTypeSymbol(
  typeName: string | undefined,
): C3Symbol | undefined {
  return builtinSymbols.get(terminalTypeName(typeName ?? ''));
}

export function builtinOwnerSymbol(symbol: C3Symbol): C3Symbol | undefined {
  if (symbol.uri !== builtinUri) return undefined;

  for (const owner of builtinSymbols.values()) {
    if (owner.children.some((child) => child === symbol)) {
      return owner;
    }
  }

  return undefined;
}

function builtinAggregate(name: string, children: C3Symbol[]): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Struct,
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: `struct ${name}`,
    documentation:
      name === 'any'
        ? 'Builtin fat pointer containing a data pointer and runtime type id.'
        : undefined,
    attributes: ['@builtin'],
    typeInfo: {
      name,
      kind: 'builtin',
      isGeneric: false,
      genericParameterCount: 0,
      range: zeroRange,
      selectionRange: zeroRange,
    },
    implementedInterfaces: [],
    parameters: [],
    children,
  };
}

function builtinType(name: string): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.TypeParameter,
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: name,
    documentation: builtinDocumentation(name),
    attributes: ['@builtin'],
    typeInfo: {
      name,
      kind: 'builtin',
      isGeneric: false,
      genericParameterCount: 0,
      range: zeroRange,
      selectionRange: zeroRange,
    },
    implementedInterfaces: [],
    parameters: [],
    children: [],
  };
}

function builtinDocumentation(name: string): string {
  if (integerTypeNames.has(name)) return 'Builtin integer type.';
  if (name === 'fault') return 'Builtin fault type.';
  return 'Builtin type.';
}

function builtinField(name: string, returnType: string): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Field,
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: `${returnType} ${name};`,
    documentation: undefined,
    attributes: ['@builtin'],
    returnType,
    implementedInterfaces: [],
    parameters: [],
    children: [],
  };
}
