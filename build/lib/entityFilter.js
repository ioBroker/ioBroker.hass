"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OBJECT_PATH_PREFIX = void 0;
exports.isExcluded = isExcluded;
exports.buildExcludeRegexps = buildExcludeRegexps;
exports.buildExcludeFilter = buildExcludeFilter;
exports.isEntityIdExcluded = isEntityIdExcluded;
exports.isObjectPathExcluded = isObjectPathExcluded;
/** Patterns starting with this prefix address ioBroker object paths instead of HASS entity_ids. */
exports.OBJECT_PATH_PREFIX = 'entities.';
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
/**
 * Splits the configured glob patterns into entity_id patterns and object path patterns.
 * Only patterns starting with `entities.` (optionally with the instance prefix, e.g.
 * `hass.0.entities.`) are matched against object paths. This way entity_id patterns
 * like `*battery*` keep excluding entities only and never drop attributes of other entities.
 */
function buildExcludeFilter(patterns, namespace) {
    const entityPatterns = [];
    const objectPatterns = [];
    for (let pattern of patterns || []) {
        if (namespace && pattern.startsWith(`${namespace}.${exports.OBJECT_PATH_PREFIX}`)) {
            pattern = pattern.substring(namespace.length + 1);
        }
        if (pattern.startsWith(exports.OBJECT_PATH_PREFIX)) {
            objectPatterns.push(pattern);
        }
        else {
            entityPatterns.push(pattern);
        }
    }
    return {
        entityPatterns: buildExcludeRegexps(entityPatterns),
        objectPatterns: buildExcludeRegexps(objectPatterns),
    };
}
/**
 * An entity is excluded if an entity_id pattern matches or an object path pattern
 * matches its channel `entities.<entity_id>` (e.g. `entities.device_tracker.*`).
 */
function isEntityIdExcluded(entityId, filter) {
    return (isExcluded(entityId, filter.entityPatterns) ||
        isExcluded(`${exports.OBJECT_PATH_PREFIX}${entityId}`, filter.objectPatterns));
}
/**
 * Returns true if a single object (state, attribute or service) is excluded.
 * The path is the object id without instance prefix, e.g. `entities.sensor.foo.device_class`.
 */
function isObjectPathExcluded(path, filter) {
    return isExcluded(path, filter.objectPatterns);
}
//# sourceMappingURL=entityFilter.js.map