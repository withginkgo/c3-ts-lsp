export type C3TypeRef = {
  source: string;
  normalized: string;
  nominal: string;
  terminal: string;
  arguments: C3TypeRef[];
};

export function parseTypeRef(typeName: string | undefined): C3TypeRef | undefined {
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
  const actualRef = parseTypeRef(actual);
  const expectedRef = parseTypeRef(expected);
  if (!actualRef || !expectedRef) return false;

  if (actualRef.normalized === expectedRef.normalized) return true;
  if (actualRef.nominal !== expectedRef.nominal) return false;

  return actualRef.arguments.length === 0 || expectedRef.arguments.length === 0;
}

function compactTypeText(typeName: string): string {
  return typeName
    .replace(/\b(?:const|volatile)\s+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{},\[\]*!?~])\s*/g, '$1')
    .trim();
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
