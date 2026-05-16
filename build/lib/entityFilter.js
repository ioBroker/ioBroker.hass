"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isExcluded = isExcluded;
exports.buildExcludeRegexps = buildExcludeRegexps;
/**
 * Returns true if entityId matches any of the supplied glob patterns.
 * Glob syntax: `*` is the only wildcard and matches any sequence of characters
 * (including dots). All other characters are matched literally (regex
 * metacharacters are escaped). Matching is case-sensitive and anchored to
 * the full entity_id.
 *
 * An empty patterns array always returns false.
 */
function isExcluded(entityId, patterns) {
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
function buildExcludeRegexps(patterns) {
    if (!patterns?.length) {
        return [];
    }
    return patterns.map(pattern => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`);
    });
}
//# sourceMappingURL=entityFilter.js.map