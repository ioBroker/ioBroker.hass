/** Patterns starting with this prefix address ioBroker object paths instead of HASS entity_ids. */
export const OBJECT_PATH_PREFIX = 'entities.';

export interface ExcludeFilter {
    /** Matched against the HASS entity_id, e.g. `sensor.iob_*` */
    entityPatterns: RegExp[];
    /** Matched against the object id without instance prefix, e.g. `entities.*.*.device_class` */
    objectPatterns: RegExp[];
}

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

export function buildExcludeRegexps(patterns: string[]): RegExp[] {
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
export function buildExcludeFilter(patterns: string[], namespace?: string): ExcludeFilter {
    const entityPatterns: string[] = [];
    const objectPatterns: string[] = [];
    for (let pattern of patterns || []) {
        if (namespace && pattern.startsWith(`${namespace}.${OBJECT_PATH_PREFIX}`)) {
            pattern = pattern.substring(namespace.length + 1);
        }
        if (pattern.startsWith(OBJECT_PATH_PREFIX)) {
            objectPatterns.push(pattern);
        } else {
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
export function isEntityIdExcluded(entityId: string, filter: ExcludeFilter): boolean {
    return (
        isExcluded(entityId, filter.entityPatterns) ||
        isExcluded(`${OBJECT_PATH_PREFIX}${entityId}`, filter.objectPatterns)
    );
}

/**
 * Returns true if a single object (state, attribute or service) is excluded.
 * The path is the object id without instance prefix, e.g. `entities.sensor.foo.device_class`.
 */
export function isObjectPathExcluded(path: string, filter: ExcludeFilter): boolean {
    return isExcluded(path, filter.objectPatterns);
}
