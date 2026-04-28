import { SymbolKind } from 'vscode-languageserver/node.js';

import type { C3Parameter, C3Symbol } from './types.js';

export function isCallableSymbol(symbol: C3Symbol): boolean {
  return (
    symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method
  );
}

export function callableParameters(
  symbol: C3Symbol,
  options: { methodStyle?: boolean } = {},
): C3Parameter[] {
  const parameters =
    symbol.parameterDetails ??
    symbol.parameters.map((parameter, index) =>
      parameterDetailFromLabel(parameter, index, symbol.receiverType),
    );

  return options.methodStyle && symbol.kind === SymbolKind.Method
    ? parameters.slice(1)
    : parameters;
}

export function parameterDetailFromLabel(
  label: string,
  index: number,
  receiverType?: string,
): C3Parameter {
  const compactLabel = compactText(label);
  const { base, defaultValue } = splitDefault(compactLabel);
  const variadic = /\.\.\./.test(base);
  const receiver = !!receiverType && index === 0;
  const name = parameterNameFromBase(base, receiver);
  const type = parameterTypeFromBase(
    base,
    name,
    receiver ? receiverType : undefined,
  );

  return {
    label: compactLabel,
    name,
    type,
    optional: defaultValue !== undefined,
    variadic,
    defaultValue,
    receiver,
  };
}

function splitDefault(label: string): { base: string; defaultValue?: string } {
  const index = label.indexOf('=');
  if (index < 0) return { base: label.trim() };

  return {
    base: label.slice(0, index).trim(),
    defaultValue: label.slice(index + 1).trim(),
  };
}

function parameterNameFromBase(
  base: string,
  receiver: boolean,
): string | undefined {
  const suffixVariadic = base
    .trim()
    .match(/^([#$@]?[A-Za-z_][A-Za-z0-9_$@]*)\s*\.\.\.$/);
  if (suffixVariadic) return suffixVariadic[1];

  const normalized = base.replace(/\.\.\./g, ' ... ').trim();
  if (normalized === '...' || normalized.length === 0) return undefined;

  if (receiver) {
    const receiverMatch = normalized.match(
      /^&?([#$@]?[A-Za-z_][A-Za-z0-9_$@]*)$/,
    );
    if (receiverMatch) return receiverMatch[1];
  }

  const parts = normalized.split(/\s+/).filter((part) => !part.startsWith('@'));
  const last = parts.at(-1);
  if (!last || last === '...') return undefined;

  const named = last.match(/^&?([#$@]?[A-Za-z_][A-Za-z0-9_$@]*)$/);
  if (named) return named[1];

  return undefined;
}

function parameterTypeFromBase(
  base: string,
  name: string | undefined,
  receiverType: string | undefined,
): string | undefined {
  if (receiverType) return receiverType;
  if (!name) return undefined;

  const normalized = base.replace(/\.\.\./g, ' ... ');
  const nameIndex = normalized.lastIndexOf(name);
  if (nameIndex <= 0) return undefined;

  const type = normalized
    .slice(0, nameIndex)
    .replace(/\.\.\./g, '')
    .replace(/\s+\.\.\.\s*$/, '')
    .trim();

  return type || undefined;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
