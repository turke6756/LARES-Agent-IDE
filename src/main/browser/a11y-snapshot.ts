// WP2-A task 2 (plans/embedded-browser-implementation-tasks.md) — pure a11y
// snapshot formatting + ref bookkeeping for the embedded browser tools.
//
// `Accessibility.getFullAXTree` (fetched by cdp-driver.ts) is rendered as a
// compact text tree. Interactable nodes get stable numeric refs `[n]` that
// `click(ref)` resolves back to CDP backend DOM node ids. Refs are allocated
// MONOTONICALLY per tab across snapshot generations, so a ref from an older
// snapshot can never collide with a live one — a stale ref always resolves to
// a typed StaleRefError telling the agent to re-read, never to a wrong click.
//
// HARD RULE: no Electron imports. This module is the compiled-node test
// surface for the ref-staleness acceptance test.

/** Structural mirror of the CDP `Accessibility.AXNode` subset we consume. */
export interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
  parentId?: string;
}

/** Output cap so a pathological page can't flood the agent's context. */
export const MAX_SNAPSHOT_CHARS = 100_000;

/** AX roles the agent can usefully click/operate — these get `[n]` refs. */
const INTERACTABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'textfield', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'togglebutton',
  'popupbutton', 'disclosuretriangle',
]);

/** Container/filler roles that add no information when nameless. */
const SILENT_ROLES = new Set([
  'generic', 'none', 'presentation', 'ignored', 'genericcontainer',
  'inlinetextbox', 'linebreak',
]);

export class StaleRefError extends Error {
  readonly code = 'stale-ref';
  constructor(ref: number) {
    super(
      `ref [${ref}] is from a stale snapshot — the page has changed since it was read. ` +
        `Call readPage again and use a ref from the fresh snapshot.`,
    );
    this.name = 'StaleRefError';
  }
}

export class UnknownRefError extends Error {
  readonly code = 'unknown-ref';
  constructor(ref: number) {
    super(
      `ref [${ref}] was never issued for this tab. Call readPage and use one of the ` +
        `[n] refs from its snapshot.`,
    );
    this.name = 'UnknownRefError';
  }
}

/**
 * Per-tab ref bookkeeping. One generation per snapshot; only the latest
 * generation's refs resolve. Monotonic allocation (gen 1: 1..k, gen 2:
 * k+1..m, …) guarantees an old ref is ABSENT from the live map rather than
 * aliased onto a different element.
 */
export class RefRegistry {
  private nextRef = 1;
  private current = new Map<number, number>(); // ref → backendDOMNodeId
  private generationCount = 0;

  /** Start a new snapshot generation; all previously issued refs go stale. */
  newGeneration(): void {
    this.current.clear();
    this.generationCount++;
  }

  /** Issue the next ref for a backend DOM node in the current generation. */
  add(backendDOMNodeId: number): number {
    const ref = this.nextRef++;
    this.current.set(ref, backendDOMNodeId);
    return ref;
  }

  get generation(): number {
    return this.generationCount;
  }

  /** Resolve a ref to its backend DOM node id, or throw the typed error. */
  resolve(ref: number): number {
    const backendId = this.current.get(ref);
    if (backendId !== undefined) return backendId;
    if (Number.isInteger(ref) && ref >= 1 && ref < this.nextRef) {
      throw new StaleRefError(ref);
    }
    throw new UnknownRefError(ref);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/**
 * Render the raw AX node list as a compact indented text tree, registering a
 * fresh generation of refs for interactable nodes. Ignored nodes and nameless
 * filler containers are flattened away (children promoted), so the agent sees
 * `[12] button "Sign in"` lines rather than div soup.
 */
export function buildA11ySnapshot(nodes: RawAXNode[], registry: RefRegistry): string {
  registry.newGeneration();

  const byId = new Map<string, RawAXNode>();
  const referencedAsChild = new Set<string>();
  for (const n of nodes) {
    byId.set(n.nodeId, n);
    for (const c of n.childIds ?? []) referencedAsChild.add(c);
  }
  const roots = nodes.filter((n) => !referencedAsChild.has(n.nodeId));
  // Defensive: a malformed/cyclic node list may have no unreferenced root —
  // fall back to document order so we still render something.
  if (roots.length === 0 && nodes.length > 0) roots.push(nodes[0]);

  const lines: string[] = [];
  let chars = 0;
  let truncated = false;

  const emit = (line: string): boolean => {
    if (chars + line.length + 1 > MAX_SNAPSHOT_CHARS) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  const visit = (node: RawAXNode, depth: number, seen: Set<string>): void => {
    if (truncated || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);

    const role = str(node.role?.value).toLowerCase();
    const name = str(node.name?.value).trim();
    const value = str(node.value?.value).trim();
    const interactable = INTERACTABLE_ROLES.has(role) && node.backendDOMNodeId !== undefined;
    const silent =
      node.ignored === true || ((SILENT_ROLES.has(role) || role === '') && name === '' && !interactable);

    let childDepth = depth;
    if (!silent) {
      const parts: string[] = [];
      if (interactable) parts.push(`[${registry.add(node.backendDOMNodeId!)}]`);
      parts.push(role || 'node');
      if (name !== '') parts.push(JSON.stringify(name));
      if (value !== '') parts.push(`value=${JSON.stringify(value)}`);
      if (!emit(`${'  '.repeat(depth)}${parts.join(' ')}`)) return;
      childDepth = depth + 1;
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, seen);
    }
  };

  const seen = new Set<string>();
  for (const root of roots) visit(root, 0, seen);

  if (truncated) lines.push(`…[snapshot truncated at ${MAX_SNAPSHOT_CHARS} chars]`);
  return lines.join('\n');
}
