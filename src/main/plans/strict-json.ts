import { parseTree, type Node, type ParseError } from 'jsonc-parser';

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

function rejectDuplicateKeys(node: Node): void {
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      const key = keyNode?.value;
      if (typeof key !== 'string') {
        throw new StrictJsonError('Strict JSON object contains a malformed property.');
      }
      if (seen.has(key)) {
        throw new StrictJsonError(`Strict JSON object contains duplicate key ${JSON.stringify(key)}.`);
      }
      seen.add(key);
      if (valueNode) rejectDuplicateKeys(valueNode);
    }
    return;
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

/** Parse JSON with JSONC extensions disabled and duplicate object keys rejected. */
export function parseStrictJson(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!tree || errors.length > 0) {
    const first = errors[0];
    throw new StrictJsonError(first
      ? `Invalid strict JSON at offset ${first.offset} (error ${first.error}).`
      : 'Invalid strict JSON.');
  }
  rejectDuplicateKeys(tree);
  // parseTree has already enforced the strict grammar and duplicate-key walk;
  // JSON.parse supplies ordinary-prototype objects to downstream validators.
  return JSON.parse(text) as unknown;
}
