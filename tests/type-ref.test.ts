import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canImplicitlyConvertType,
  collectionElementTypeName,
  isSliceTypeName,
  nominalTypeName,
  normalizeTypeName,
  parseTypeRef,
  typeNamesCompatible,
} from '../src/shared/type-ref.js';

test('parseTypeRef extracts nominal type from generic containers', () => {
  const type = parseTypeRef('HashMap{NativeSocket, List{Poll}}*');

  assert.equal(type?.normalized, 'HashMap{NativeSocket,List{Poll}}');
  assert.equal(type?.nominal, 'HashMap');
  assert.equal(type?.arguments[0]?.normalized, 'NativeSocket');
  assert.equal(type?.arguments[1]?.nominal, 'List');
  assert.equal(type?.arguments[1]?.arguments[0]?.normalized, 'Poll');
});

test('type helpers preserve generic identity for member and element lookup', () => {
  assert.equal(
    nominalTypeName('std::collections::HashMap{NativeSocket, Handlers}'),
    'std::collections::HashMap',
  );
  assert.equal(collectionElementTypeName('List{Poll}'), 'Poll');
  assert.equal(
    collectionElementTypeName('HashMap{NativeSocket, Handlers}'),
    'Handlers',
  );
  assert.equal(collectionElementTypeName('Poll[]'), 'Poll');
  assert.equal(collectionElementTypeName('Poll[4]'), 'Poll');
  assert.equal(normalizeTypeName('const List { Poll } *'), 'List{Poll}');
});

test('typeNamesCompatible accepts concrete generic instances for nominal receivers', () => {
  assert.equal(typeNamesCompatible('List{Poll}', 'List'), true);
  assert.equal(typeNamesCompatible('List{Poll}', 'List{Poll}'), true);
  assert.equal(typeNamesCompatible('List{Poll}', 'HashMap'), false);
  assert.equal(typeNamesCompatible('List{Poll}', 'List{Handler}'), false);
});

test('type helpers model slices and pointer conversions structurally', () => {
  assert.equal(isSliceTypeName('Poll[]'), true);
  assert.equal(typeNamesCompatible('Poll[]', 'Poll'), false);
  assert.equal(typeNamesCompatible('Poll[]', 'Poll[]'), true);
  assert.equal(canImplicitlyConvertType('Poll[]', 'Poll*'), true);
  assert.equal(canImplicitlyConvertType('Poll[]', 'void*'), true);
  assert.equal(canImplicitlyConvertType('Poll*', 'void*'), true);
  assert.equal(canImplicitlyConvertType('Poll', 'void*'), false);
});
