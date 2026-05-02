import type { ProjectIndex } from '../project/project-index.js';
import { callableParameters } from '../shared/callable.js';
import { callArgumentValueNode, expressionTypeName } from './type-analysis.js';
import type { C3CallArgument, C3CallTarget } from '../shared/calls.js';
import {
  parseTypeRef,
  typeNamesCompatible,
  type C3TypeRef,
} from '../shared/type-ref.js';
import type { C3Parameter, C3Symbol, ParsedDocument } from '../shared/types.js';

export type InstantiatedCallable = {
  parameters: C3Parameter[];
  unresolvedGenericParams: Set<string>;
  substitution: Map<string, string>;
};

export function callableGenericArgumentMatches(
  candidates: C3Symbol[],
  target: Pick<C3CallTarget, 'genericArgs' | 'genericRange'>,
): C3Symbol[] {
  if (!target.genericRange) return candidates;

  return candidates.filter(
    (symbol) =>
      genericParameterCountForSymbol(symbol) === target.genericArgs.length,
  );
}

export function instantiateCallableForCall(
  symbol: C3Symbol,
  index: ProjectIndex,
  parsed: ParsedDocument,
  target: Pick<C3CallTarget, 'methodStyle' | 'genericArgs' | 'genericRange'>,
  args: C3CallArgument[],
  expectedReturnType: string | undefined,
): InstantiatedCallable {
  const parameters = callableParameters(symbol, {
    methodStyle: target.methodStyle,
  });
  const genericParams = symbol.effectiveGenericParams ?? [];
  const substitution = new Map<string, string>();

  if (genericParams.length === 0) {
    return {
      parameters,
      unresolvedGenericParams: new Set(),
      substitution,
    };
  }

  const genericParamSet = new Set(genericParams);

  if (
    target.genericRange &&
    target.genericArgs.length === genericParams.length
  ) {
    for (let index = 0; index < genericParams.length; index++) {
      substitution.set(genericParams[index]!, target.genericArgs[index]!.text);
    }
  } else {
    collectGenericConstraintsFromExpectedReturnType(
      symbol,
      expectedReturnType,
      genericParamSet,
      substitution,
    );
    collectGenericConstraintsFromArguments(
      index,
      parsed,
      parameters,
      args,
      genericParamSet,
      substitution,
    );
  }

  const unresolvedGenericParams = new Set(
    genericParams.filter((param) => !substitution.has(param)),
  );

  return {
    parameters: parameters.map((parameter) => ({
      ...parameter,
      label: substituteGenericParams(parameter.label, substitution),
      type: parameter.type
        ? substituteGenericParams(parameter.type, substitution)
        : undefined,
    })),
    unresolvedGenericParams,
    substitution,
  };
}

export function callArgumentShapeMatches(
  parameters: C3Parameter[],
  args: C3CallArgument[],
): boolean {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgument(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) return false;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;
  }

  return parameters.every(
    (parameter, index) =>
      parameter.optional || parameter.variadic || supplied.has(index),
  );
}

export function parameterIndexForTargetCallArgument(
  parameters: C3Parameter[],
  args: C3CallArgument[],
  targetArg: C3CallArgument,
): number | undefined {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgument(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) return undefined;
    if (sameCallArgumentNode(arg.node, targetArg.node)) return parameterIndex;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;
  }

  return undefined;
}

export function parameterIndexForCallArgument(
  parameters: C3Parameter[],
  arg: C3CallArgument,
  supplied: Set<number>,
  positionalCursor: number,
  variadicIndex: number,
): number | undefined {
  if (arg.name) {
    const namedIndex = parameters.findIndex(
      (parameter) => parameter.name === arg.name,
    );
    return namedIndex >= 0 && !supplied.has(namedIndex)
      ? namedIndex
      : undefined;
  }

  const positionalIndex = nextPositionalIndex(
    parameters,
    supplied,
    positionalCursor,
    variadicIndex,
  );

  if (variadicIndex >= 0 && positionalIndex >= variadicIndex) {
    return variadicIndex;
  }

  return positionalIndex < parameters.length ? positionalIndex : undefined;
}

export function nextPositionalIndex(
  parameters: C3Parameter[],
  supplied: Set<number>,
  cursor: number,
  variadicIndex: number,
): number {
  let index = cursor;

  while (index < parameters.length && supplied.has(index)) {
    index++;
  }

  if (variadicIndex >= 0 && index >= variadicIndex) return variadicIndex;
  return index;
}

export function genericParameterCountForSymbol(symbol: C3Symbol): number {
  return (
    symbol.effectiveGenericParams?.length ??
    symbol.genericParameterCount ??
    symbol.typeInfo?.effectiveGenericParams?.length ??
    symbol.typeInfo?.genericParameterCount ??
    0
  );
}

export function substituteGenericParams(
  text: string,
  substitution: Map<string, string>,
): string {
  let result = text;

  for (const [param, replacement] of substitution) {
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(^|[^A-Za-z0-9_$@])${escaped}(?=$|[^A-Za-z0-9_$@])`, 'g'),
      `$1${replacement}`,
    );
  }

  return result;
}

function collectGenericConstraintsFromExpectedReturnType(
  symbol: C3Symbol,
  expectedType: string | undefined,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const returnType = symbol.functionType?.returnType ?? symbol.returnType;
  if (!returnType || !expectedType) return;

  const expected = parseTypeRef(expectedType);
  const actual = parseTypeRef(returnType);
  if (!expected || !actual || !sameNominalType(actual, expected)) return;

  unifyTypeRefs(actual, expected, genericParams, substitution);

  if (
    actual.arguments.length === 0 &&
    expected.arguments.length === (symbol.moduleGenericParams?.length ?? 0)
  ) {
    for (let index = 0; index < expected.arguments.length; index++) {
      const param = symbol.moduleGenericParams?.[index];
      const arg = expected.arguments[index];
      if (param && arg && genericParams.has(param)) {
        bindGenericParam(param, arg.source, substitution);
      }
    }
  }
}

function collectGenericConstraintsFromArguments(
  index: ProjectIndex,
  parsed: ParsedDocument,
  parameters: C3Parameter[],
  args: C3CallArgument[],
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const supplied = new Set<number>();
  const variadicIndex = parameters.findIndex((parameter) => parameter.variadic);
  let positionalCursor = 0;

  for (const arg of args) {
    const parameterIndex = parameterIndexForCallArgument(
      parameters,
      arg,
      supplied,
      positionalCursor,
      variadicIndex,
    );
    if (parameterIndex === undefined) continue;

    supplied.add(parameterIndex);
    if (!arg.name) positionalCursor = parameterIndex + 1;

    const parameter = parameters[parameterIndex];
    const value = callArgumentValueNode(arg.node);
    if (!parameter?.type || !value) continue;

    const actualType = expressionTypeName(index, parsed, value);
    if (!actualType) continue;

    unifyTypeNames(parameter.type, actualType, genericParams, substitution);
  }
}

function unifyTypeNames(
  genericType: string,
  concreteType: string,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  const genericRef = parseTypeRef(genericType);
  const concreteRef = parseTypeRef(concreteType);
  if (!genericRef || !concreteRef) return;

  unifyTypeRefs(genericRef, concreteRef, genericParams, substitution);
}

function unifyTypeRefs(
  genericRef: C3TypeRef,
  concreteRef: C3TypeRef,
  genericParams: Set<string>,
  substitution: Map<string, string>,
): void {
  if (genericParams.has(genericRef.normalized)) {
    bindGenericParam(genericRef.normalized, concreteRef.source, substitution);
    return;
  }

  if (!sameNominalType(genericRef, concreteRef)) return;
  if (genericRef.arguments.length !== concreteRef.arguments.length) return;

  for (let index = 0; index < genericRef.arguments.length; index++) {
    const genericArg = genericRef.arguments[index];
    const concreteArg = concreteRef.arguments[index];
    if (!genericArg || !concreteArg) continue;

    unifyTypeRefs(genericArg, concreteArg, genericParams, substitution);
  }
}

function bindGenericParam(
  param: string,
  concreteType: string,
  substitution: Map<string, string>,
): void {
  const existing = substitution.get(param);
  if (!existing) {
    substitution.set(param, concreteType);
    return;
  }

  if (typeNamesCompatible(concreteType, existing)) return;
}

function sameNominalType(a: C3TypeRef, b: C3TypeRef): boolean {
  return a.nominal === b.nominal || a.terminal === b.terminal;
}

function sameCallArgumentNode(
  a: { startIndex: number; endIndex: number },
  b: { startIndex: number; endIndex: number },
): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}
