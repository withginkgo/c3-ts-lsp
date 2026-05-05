export type C3TypeRef = {
  source: string;
  normalized: string;
  nominal: string;
  terminal: string;
  arguments: C3TypeRef[];
};

export function parseTypeRef(
  typeName: string | undefined,
): C3TypeRef | undefined {
  if (!typeName) return undefined;

  const normalized = normalizeTypeName(typeName);
  if (!normalized) return undefined;

  const generic = outerGeneric(normalized);
  const nominal = generic
    ? normalized.slice(0, generic.start).trim()
    : normalized;
  const args = generic
    ? splitTopLevel(generic.content)
        .map((arg) => parseTypeRef(arg))
        .filter((arg): arg is C3TypeRef => !!arg)
    : [];

  return {
    source: typeName,
    normalized,
    nominal,
    terminal: terminalTypeName(nominal),
    arguments: args,
  };
}

export function normalizeTypeName(typeName: string): string {
  return compactTypeText(typeName)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[*!?~]+/g, '')
    .trim();
}

export function isArrayLikeTypeName(typeName: string | undefined): boolean {
  const shape = typeShape(typeName);
  return !!shape?.postfixes[0]?.startsWith('[');
}

export function isSliceTypeName(typeName: string | undefined): boolean {
  const shape = typeShape(typeName);
  return shape?.postfixes[0] === '[]';
}

export function arrayLikeElementTypeName(
  typeName: string | undefined,
): string | undefined {
  const shape = typeShape(typeName);
  if (!shape?.postfixes[0]?.startsWith('[')) return undefined;

  return typeNameFromShape(shape.base, shape.postfixes.slice(1));
}

export function isPointerTypeName(typeName: string | undefined): boolean {
  return typeShape(typeName)?.postfixes[0] === '*';
}

export function pointerTargetTypeName(
  typeName: string | undefined,
): string | undefined {
  const shape = typeShape(typeName);
  if (shape?.postfixes[0] !== '*') return undefined;

  return typeNameFromShape(shape.base, shape.postfixes.slice(1));
}

export function isVoidPointerTypeName(typeName: string | undefined): boolean {
  const target = pointerTargetTypeName(typeName);
  return target !== undefined && normalizeTypeName(target) === 'void';
}

export function isOptionalTypeName(typeName: string | undefined): boolean {
  const text = compactTypeText(typeName ?? '');
  if (!text) return false;

  const marker = outerOptionalMarker(text);
  return marker === '?' || marker === '~' || marker === '!';
}

export function nonOptionalTypeName(typeName: string): string {
  return normalizeTypeName(removeOuterOptionalMarker(typeName));
}

export function optionalTypeName(typeName: string): string {
  const base = removeOuterOptionalMarker(typeName).trim();
  if (!base) return typeName;
  return `${base}?`;
}

export function nominalTypeName(typeName: string): string {
  return parseTypeRef(typeName)?.nominal ?? '';
}

export function terminalTypeName(typeName: string): string {
  const normalized = normalizeTypeName(typeName);
  const nominal = outerGeneric(normalized)
    ? normalized.slice(0, outerGeneric(normalized)!.start).trim()
    : normalized;

  return nominal.split('::').at(-1) ?? nominal;
}

export function collectionElementTypeName(typeName: string): string {
  const arrayElement = arrayLikeElementTypeName(typeName);
  if (arrayElement) return arrayElement;

  const ref = parseTypeRef(typeName);
  if (!ref) return '';

  if (ref.arguments.length > 0) {
    return ref.arguments.at(-1)!.normalized;
  }

  return ref.normalized;
}

export function typeNamesCompatible(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  const actualShape = typeShape(actual);
  const expectedShape = typeShape(expected);
  if (!actualShape || !expectedShape) return false;

  if (
    typeNameFromShape(actualShape.base, actualShape.postfixes) ===
    typeNameFromShape(expectedShape.base, expectedShape.postfixes)
  ) {
    return true;
  }

  if (!samePostfixShape(actualShape.postfixes, expectedShape.postfixes)) {
    return false;
  }

  const actualRef = parseTypeRef(actualShape.base);
  const expectedRef = parseTypeRef(expectedShape.base);
  if (!actualRef || !expectedRef) return false;

  if (actualRef.normalized === expectedRef.normalized) return true;
  if (actualRef.nominal !== expectedRef.nominal) return false;

  return actualRef.arguments.length === 0 || expectedRef.arguments.length === 0;
}

export function canImplicitlyConvertType(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) return false;
  if (isOptionalTypeName(actual) || isOptionalTypeName(expected)) {
    return (
      isOptionalTypeName(actual) === isOptionalTypeName(expected) &&
      canImplicitlyConvertType(
        nonOptionalTypeName(actual),
        nonOptionalTypeName(expected),
      )
    );
  }

  if (typeNamesCompatible(actual, expected)) return true;

  if (isArrayLikeTypeName(actual)) {
    const elementType = arrayLikeElementTypeName(actual);
    if (elementType && canImplicitlyConvertType(`${elementType}*`, expected)) {
      return true;
    }
  }

  return isPointerTypeName(actual) && isVoidPointerTypeName(expected);
}

function compactTypeText(typeName: string): string {
  return typeName
    .replace(/\b(?:const|volatile)\s+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{},\[\]*!?~])\s*/g, '$1')
    .trim();
}

function removeOuterOptionalMarker(typeName: string): string {
  const text = compactTypeText(typeName);
  if (!outerOptionalMarker(text)) return text;

  return text.slice(0, -1).trim();
}

function outerOptionalMarker(typeName: string): string | undefined {
  const text = compactTypeText(typeName);
  if (!text) return undefined;

  const marker = text.at(-1);
  if (marker !== '?' && marker !== '~' && marker !== '!') return undefined;

  return marker;
}

type TypeShape = {
  base: string;
  postfixes: string[];
};

function typeShape(typeName: string | undefined): TypeShape | undefined {
  let text = removeOuterOptionalMarker(typeName ?? '');
  if (!text) return undefined;

  const postfixes: string[] = [];

  while (text) {
    if (text.endsWith('*')) {
      postfixes.push('*');
      text = text.slice(0, -1).trim();
      continue;
    }

    const array = outerArraySuffix(text);
    if (array) {
      postfixes.push(array.suffix);
      text = array.element.trim();
      continue;
    }

    break;
  }

  return text ? { base: text, postfixes } : undefined;
}

function typeNameFromShape(base: string, postfixes: string[]): string {
  return `${base}${[...postfixes].reverse().join('')}`;
}

function samePostfixShape(a: string[], b: string[]): boolean {
  return (
    a.length === b.length && a.every((postfix, index) => postfix === b[index])
  );
}

function outerArraySuffix(
  typeName: string,
): { element: string; suffix: string } | undefined {
  if (!typeName.endsWith(']')) return undefined;

  let depth = 0;

  for (let index = typeName.length - 1; index >= 0; index--) {
    const char = typeName[index];

    if (char === ']') {
      depth++;
      continue;
    }

    if (char !== '[') continue;

    depth--;
    if (depth !== 0) continue;

    return {
      element: typeName.slice(0, index),
      suffix: typeName.slice(index),
    };
  }

  return undefined;
}

function outerGeneric(
  typeName: string,
): { start: number; end: number; content: string } | undefined {
  const start = typeName.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;

  for (let index = start; index < typeName.length; index++) {
    const char = typeName[index];

    if (char === '{') {
      depth++;
      continue;
    }

    if (char !== '}') continue;

    depth--;

    if (depth === 0) {
      return {
        start,
        end: index,
        content: typeName.slice(start + 1, index),
      };
    }
  }

  return undefined;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];

    if (char === '{') {
      depth++;
      continue;
    }

    if (char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char !== ',' || depth !== 0) continue;

    parts.push(source.slice(start, index).trim());
    start = index + 1;
  }

  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}
