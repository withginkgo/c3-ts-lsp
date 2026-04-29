import type { ParsedDocument } from '../shared/types.js';

export function parsedIsActiveInEnvironment(
  parsed: ParsedDocument,
  activeEnvironment: Set<string>,
): boolean {
  for (const attribute of parsed.moduleAttributes) {
    const condition = ifAttributeCondition(attribute);
    if (!condition) continue;

    const value = evaluateCondition(condition, activeEnvironment);
    if (value === false) return false;
  }

  return true;
}

export function normalizeC3Environment(values: Iterable<string>): Set<string> {
  const normalized = new Set<string>();

  for (const value of values) {
    const name = normalizeEnvironmentName(value);
    if (name) normalized.add(name);
  }

  addEnvironmentImplications(normalized);
  return normalized;
}

export function defaultC3Environment(): string[] {
  const environment = new Set<string>();

  switch (process.platform) {
    case 'win32':
      environment.add('WIN32');
      break;
    case 'darwin':
      environment.add('DARWIN');
      environment.add('MACOS');
      break;
    case 'freebsd':
      environment.add('FREEBSD');
      break;
    case 'openbsd':
      environment.add('OPENBSD');
      break;
    case 'netbsd':
      environment.add('NETBSD');
      break;
    case 'linux':
    default:
      environment.add('LINUX');
      break;
  }

  switch (process.arch) {
    case 'x64':
      environment.add('X86_64');
      break;
    case 'ia32':
      environment.add('X86');
      break;
    case 'arm64':
      environment.add('AARCH64');
      break;
  }

  return [...environment];
}

function ifAttributeCondition(attribute: string): string | undefined {
  const match = attribute.match(/^@if\s*\((.*)\)$/);
  return match?.[1]?.trim();
}

function evaluateCondition(
  source: string,
  activeEnvironment: Set<string>,
): boolean | undefined {
  const tokens = tokenizeCondition(source);
  let index = 0;

  const parseOr = (): boolean | undefined => {
    let value = parseAnd();

    while (tokens[index] === '||') {
      index++;
      value = orValue(value, parseAnd());
    }

    return value;
  };

  const parseAnd = (): boolean | undefined => {
    let value = parseUnary();

    while (tokens[index] === '&&') {
      index++;
      value = andValue(value, parseUnary());
    }

    return value;
  };

  const parseUnary = (): boolean | undefined => {
    if (tokens[index] === '!') {
      index++;
      return notValue(parseUnary());
    }

    return parsePrimary();
  };

  const parsePrimary = (): boolean | undefined => {
    const token = tokens[index++];
    if (!token) return undefined;

    if (token === '(') {
      const value = parseOr();
      if (tokens[index] !== ')') return undefined;

      index++;
      return value;
    }

    if (token === ')' || token === '==' || token === '!=') return undefined;

    return environmentValue(token, activeEnvironment);
  };

  const value = parseOr();
  return index === tokens.length ? value : undefined;
}

function tokenizeCondition(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    const triple = source.slice(index, index + 3);
    if (triple === '&&&' || triple === '|||') {
      tokens.push(triple === '&&&' ? '&&' : '||');
      index += 3;
      continue;
    }

    const pair = source.slice(index, index + 2);
    if (['&&', '||', '==', '!='].includes(pair)) {
      tokens.push(pair);
      index += 2;
      continue;
    }

    if (char === '(' || char === ')' || char === '!') {
      tokens.push(char);
      index++;
      continue;
    }

    if (char === '$') {
      const end = skipFunctionLikeToken(source, index);
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }

    const ident = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_:]*/)?.[0];
    if (ident) {
      tokens.push(ident);
      index += ident.length;
      continue;
    }

    tokens.push(source.slice(index));
    break;
  }

  return tokens;
}

function skipFunctionLikeToken(source: string, start: number): number {
  let index = start;

  while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
    index++;
  }

  if (source[index] !== '(') return index;

  let depth = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return index + 1;
    }
    index++;
  }

  return source.length;
}

function environmentValue(
  token: string,
  activeEnvironment: Set<string>,
): boolean | undefined {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token.startsWith('$')) return undefined;

  const name = normalizeEnvironmentName(token);
  if (!name) return undefined;

  return activeEnvironment.has(name);
}

function andValue(
  left: boolean | undefined,
  right: boolean | undefined,
): boolean | undefined {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return undefined;
}

function orValue(
  left: boolean | undefined,
  right: boolean | undefined,
): boolean | undefined {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return undefined;
}

function notValue(value: boolean | undefined): boolean | undefined {
  return value == null ? undefined : !value;
}

function normalizeEnvironmentName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  return trimmed
    .split('::')
    .at(-1)
    ?.replace(/^env\./, '')
    .toUpperCase();
}

function addEnvironmentImplications(environment: Set<string>): void {
  if (
    ['LINUX', 'DARWIN', 'FREEBSD', 'NETBSD', 'OPENBSD', 'ANDROID'].some(
      (name) => environment.has(name),
    )
  ) {
    environment.add('POSIX');
  }

  if (
    ['DARWIN', 'FREEBSD', 'NETBSD', 'OPENBSD'].some((name) =>
      environment.has(name),
    )
  ) {
    environment.add('BSD_FAMILY');
  }

  if (!environment.has('NO_LIBC')) {
    environment.add('LIBC');
  }

  if (environment.has('POSIX') || environment.has('WIN32')) {
    environment.add('NATIVE_THREADING');
    environment.add('SUPPORTS_INET');
  }
}
