import { Range, SymbolKind } from 'vscode-languageserver/node.js';

import type { C3Symbol } from './types.js';
import { isArrayLikeTypeName, terminalTypeName } from './type-ref.js';

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
export const C3_REFLECTION_TYPE_PARAMETER_TYPE = '$c3_lsp_reflect_type';
export const C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE = '$c3_lsp_reflect_member';
export const C3_REFLECTION_MEMBER_SEQUENCE_TYPE = `${C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE}[]`;
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

const reflectionTypeMembers = [
  builtinField(
    'members',
    C3_REFLECTION_MEMBER_SEQUENCE_TYPE,
    'Iterable compile-time reflection descriptors for the members of this type.',
  ),
];
const reflectionMemberDescriptorMemberSymbols = [
  builtinField(
    'name',
    'String',
    'The compile-time name of the current reflected member.',
  ),
  builtinField('type', 'typeid', 'The compile-time type of the current reflected member.'),
  builtinField('offset', 'usz', 'The byte offset of the current reflected member.'),
  builtinField(
    'alignment',
    'usz',
    'The byte alignment of the current reflected member.',
  ),
  builtinMethod(
    'has_tag',
    'bool',
    ['String name'],
    'Checks whether the current member has a compile-time custom attribute/tag with the given name.',
  ),
  builtinMethod(
    'get_tag',
    'String',
    ['String name'],
    'Retrieves the compile-time tag value associated with the given name.',
  ),
];
const compileTimeEvalSelector = builtinFunction(
  '$eval',
  'any',
  ['String name'],
  'Resolves a compile-time string or name into the corresponding dynamic field/member selector, as in `obj.$eval($member.name)`.',
);

const builtinSymbols = new Map<string, C3Symbol>(
  [
    builtinAggregate('any', [
      builtinField('ptr', 'void*'),
      builtinField('type', 'typeid'),
    ]),
    builtinAggregate(C3_REFLECTION_TYPE_PARAMETER_TYPE, reflectionTypeMembers),
    builtinAggregate(
      C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE,
      reflectionMemberDescriptorMemberSymbols,
    ),
    ...[...builtinTypeNames]
      .filter((name) => name !== 'any')
      .map((name) => builtinType(name)),
  ].map((symbol) => [symbol.name, symbol]),
);
const arrayLikeBuiltinMembers = [builtinField('len', 'usz')];

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

export function builtinMembersForTypeName(typeName: string): C3Symbol[] {
  if (isArrayLikeTypeName(typeName)) return arrayLikeBuiltinMembers;
  return builtinTypeSymbol(typeName)?.children ?? [];
}

export function isReflectionTypeParameterTypeName(
  typeName: string | undefined,
): boolean {
  return terminalTypeName(typeName ?? '') === C3_REFLECTION_TYPE_PARAMETER_TYPE;
}

export function isReflectionMemberDescriptorTypeName(
  typeName: string | undefined,
): boolean {
  return terminalTypeName(typeName ?? '') === C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE;
}

export function reflectionTypeAccessMembers(): C3Symbol[] {
  return reflectionTypeMembers;
}

export function reflectionMemberDescriptorMembers(): C3Symbol[] {
  return reflectionMemberDescriptorMemberSymbols;
}

export function compileTimeEvalSelectorSymbol(): C3Symbol {
  return compileTimeEvalSelector;
}

function builtinAggregate(name: string, children: C3Symbol[]): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Struct,
    symbolType: 'struct',
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
    symbolType: 'type',
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

function builtinFunction(
  name: string,
  returnType: string,
  parameters: string[],
  documentation: string,
): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Function,
    symbolType: 'function',
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: `macro ${name}(${parameters.join(', ')})`,
    documentation,
    attributes: ['@builtin'],
    returnType,
    implementedInterfaces: [],
    parameters,
    parameterDetails: parameters.map((label) => ({
      label,
      name: label.split(/\s+/).at(-1),
      type: label.split(/\s+/).slice(0, -1).join(' ') || undefined,
      optional: false,
      variadic: false,
    })),
    children: [],
  };
}

function builtinDocumentation(name: string): string {
  if (integerTypeNames.has(name)) return 'Builtin integer type.';
  if (name === 'fault') return 'Builtin fault type.';
  return 'Builtin type.';
}

function builtinField(
  name: string,
  returnType: string,
  documentation?: string,
): C3Symbol {
  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Field,
    symbolType: 'field',
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: `${returnType} ${name};`,
    documentation,
    attributes: ['@builtin'],
    returnType,
    valueType: returnType,
    implementedInterfaces: [],
    parameters: [],
    children: [],
  };
}

function builtinMethod(
  name: string,
  returnType: string,
  parameters: string[],
  documentation?: string,
): C3Symbol {
  const receiver = `${C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE} self`;

  return {
    name,
    moduleName: builtinModuleName,
    kind: SymbolKind.Method,
    symbolType: 'method',
    uri: builtinUri,
    range: zeroRange,
    selectionRange: zeroRange,
    signature: `fn ${returnType} ${C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE}.${name}(${parameters.join(', ')})`,
    documentation,
    attributes: ['@builtin'],
    returnType,
    receiverType: C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE,
    implementedInterfaces: [],
    parameters: [receiver, ...parameters],
    parameterDetails: [
      {
        label: receiver,
        name: 'self',
        type: C3_REFLECTION_MEMBER_DESCRIPTOR_TYPE,
        optional: false,
        variadic: false,
        receiver: true,
      },
      ...parameters.map((label) => ({
        label,
        name: label.split(/\s+/).at(-1),
        type: label.split(/\s+/).slice(0, -1).join(' ') || undefined,
        optional: false,
        variadic: false,
      })),
    ],
    children: [],
  };
}
