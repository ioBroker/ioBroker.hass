/**
 * Returns true if entityId matches any of the supplied glob patterns.
 * Glob syntax: `*` is the only wildcard and matches any sequence of characters
 * (including dots). All other characters are matched literally (regex
 * metacharacters are escaped). Matching is case-sensitive and anchored to
 * the full entity_id.
 *
 * An empty patterns array always returns false.
 */
export function isExcluded(entityId: string, patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }
    for (const pattern of patterns) {
        if (globToRegex(pattern).test(entityId)) {
            return true;
        }
    }
    return false;
}

function globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}
