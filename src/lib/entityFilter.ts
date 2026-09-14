/**
 * Returns true if entityId matches any of the supplied glob patterns.
 * Glob syntax: `*` is the only wildcard and matches any sequence of characters
 * (including dots). All other characters are matched literally (regex
 * metacharacters are escaped). Matching is case-sensitive and anchored to
 * the full entity_id.
 *
 * An empty patterns array always returns false.
 */
export function isExcluded(entityId: string, patterns: RegExp[]): boolean {
    if (!patterns?.length) {
        return false;
    }
    for (const pattern of patterns) {
        if (pattern.test(entityId)) {
            return true;
        }
    }
    return false;
}

export function isAnyExcluded(candidates: string[], patterns: RegExp[]): boolean {
    if (!patterns?.length) {
        return false;
    }
    return candidates.some(candidate => isExcluded(candidate, patterns));
}

export function buildExcludeRegexps(patterns: string[]): RegExp[] {
    if (!patterns?.length) {
        return [];
    }
    return patterns.map(pattern => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`);
    });
}
