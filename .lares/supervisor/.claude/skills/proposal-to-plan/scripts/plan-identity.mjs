// GENERATED from src/shared/plan-identity.ts — DO NOT EDIT.
function parseScalar(raw) {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value);
        }
        catch {
            return value.slice(1, -1);
        }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}
export function parseProposalFrontmatter(markdown) {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const frontmatter = {};
    if (!match)
        return frontmatter;
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (pair)
            frontmatter[pair[1]] = parseScalar(pair[2]);
    }
    return frontmatter;
}
export function slugifyPlanTitle(title) {
    return String(title).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'plan';
}
function utcDate(value) {
    if (value instanceof Date)
        return value.toISOString().slice(0, 10);
    if (typeof value === 'string')
        return value.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
}
export function derivePlanIdentity(frontmatter, overrides = {}) {
    const proposalArtifactId = String(overrides.proposalArtifactId ?? frontmatter.artifact_id ?? '').trim();
    if (!proposalArtifactId)
        throw new Error('Proposal frontmatter must contain artifact_id.');
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
export function derivePlanIdentityFromMarkdown(markdown, overrides = {}) {
    return derivePlanIdentity(parseProposalFrontmatter(markdown), overrides);
}
