export interface ProposalFrontmatter {
  artifact_id?: string;
  authored_at?: string;
  title?: string;
  [key: string]: string | undefined;
}

export interface PlanIdentityOverrides {
  proposalArtifactId?: string;
  date?: string;
  slug?: string;
  now?: Date | string;
}

export interface PlanIdentity {
  proposalArtifactId: string;
  planArtifactId: string;
  artifactShort: string;
  date: string;
  slug: string;
  planSku: string;
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function parseProposalFrontmatter(markdown: string): ProposalFrontmatter {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter: ProposalFrontmatter = {};
  if (!match) return frontmatter;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (pair) frontmatter[pair[1]] = parseScalar(pair[2]);
  }
  return frontmatter;
}

export function slugifyPlanTitle(title: string): string {
  return String(title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'plan';
}

function utcDate(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function derivePlanIdentity(
  frontmatter: ProposalFrontmatter,
  overrides: PlanIdentityOverrides = {},
): PlanIdentity {
  const proposalArtifactId = String(overrides.proposalArtifactId ?? frontmatter.artifact_id ?? '').trim();
  if (!proposalArtifactId) throw new Error('Proposal frontmatter must contain artifact_id.');
  const artifactHex = proposalArtifactId.replace(/^prop_/, '');
  const planArtifactId = 'plan_' + artifactHex;
  const artifactShort = artifactHex.slice(0, 8);
  const date = overrides.date ?? frontmatter.authored_at?.slice(0, 10) ?? utcDate(overrides.now);
  const slug = overrides.slug ?? slugifyPlanTitle(frontmatter.title ?? 'plan');
  return {
    proposalArtifactId,
    planArtifactId,
    artifactShort,
    date,
    slug,
    planSku: date + '-' + slug + '-' + artifactShort,
  };
}

export function derivePlanIdentityFromMarkdown(
  markdown: string,
  overrides: PlanIdentityOverrides = {},
): PlanIdentity {
  return derivePlanIdentity(parseProposalFrontmatter(markdown), overrides);
}
