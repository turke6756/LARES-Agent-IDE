/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) encoder.
 *
 * The encoder accepts only JSON data.  In particular, it rejects values that
 * JSON.stringify would silently omit or replace, because this output is used
 * as cryptographic digest input.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      assertValidUnicode(value);
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('JCS cannot canonicalize NaN or Infinity');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`JCS cannot canonicalize a ${typeof value} value`);
    case 'object':
      return serializeObject(value, ancestors);
    default:
      throw new TypeError('JCS encountered an unsupported value');
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('JCS cannot canonicalize cyclic data');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return serializeArray(value, ancestors);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JCS can only canonicalize plain JSON objects');
    }

    return serializeRecord(value as Record<string, unknown>, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
      throw new TypeError('JCS arrays cannot contain non-index properties');
    }
  }

  const elements: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('JCS cannot canonicalize sparse arrays');
    }
    elements.push(serialize(value[index], ancestors));
  }
  return `[${elements.join(',')}]`;
}

function serializeRecord(
  value: Record<string, unknown>,
  ancestors: Set<object>,
): string {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('JCS objects cannot contain symbol properties');
  }

  const stringKeys = keys as string[];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('JCS objects must contain enumerable data properties');
    }
    assertValidUnicode(key);
  }

  stringKeys.sort();
  const properties = stringKeys.map(
    (key) => `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`,
  );
  return `{${properties.join(',')}}`;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === '') return false;
  const index = Number(key);
  return Number.isInteger(index)
    && index >= 0
    && index < length
    && String(index) === key;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('JCS cannot canonicalize a lone Unicode surrogate');
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('JCS cannot canonicalize a lone Unicode surrogate');
    }
  }
}
