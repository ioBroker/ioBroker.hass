"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const hass_1 = __importDefault(require("./lib/hass"));
const entityFilter_1 = require("./lib/entityFilter");
const knownAttributes = {
    azimuth: { write: false, read: true, unit: '°' },
    elevation: { write: false, read: true, unit: '°' },
};
const mapTypes = {
    string: 'string',
    number: 'number',
    object: 'mixed',
    boolean: 'boolean',
};
const skipServices = ['persistent_notification'];
function getRoleForState(entity) {
    const domain = entity.domain || entity.entity_id.split('.')[0];
    const state = entity.state;
    switch (domain) {
        case 'light':
            return 'switch';
        case 'switch':
            return 'switch';
        case 'binary_sensor':
            return 'sensor.binary';
        case 'sensor':
            if (typeof state === 'number' || !isNaN(parseFloat(String(state)))) {
                if (entity.attributes?.unit_of_measurement) {
                    const unit = entity.attributes.unit_of_measurement;
                    if (unit === '°C' || unit === '°F' || unit === 'K') {
                        return 'value.temperature';
                    }
                    if (unit === '%') {
                        return 'value.humidity';
                    }
                    if (unit === 'hPa' || unit === 'mbar') {
                        return 'value.pressure';
                    }
                    if (unit === 'W' || unit === 'kW') {
                        return 'value.power';
                    }
                    if (unit === 'V') {
                        return 'value.voltage';
                    }
                    if (unit === 'A') {
                        return 'value.current';
                    }
                    if (unit.indexOf('m/s') !== -1 || unit.indexOf('km/h') !== -1) {
                        return 'value.speed';
                    }
                }
                return 'value';
            }
            return 'text';
        case 'climate':
            return 'thermostat';
        case 'cover':
            return 'blind';
        case 'lock':
            return 'state';
        case 'input_boolean':
            return 'switch';
        case 'input_number':
            return 'level';
        case 'input_text':
            return 'text';
        case 'input_select':
            return 'text';
        case 'media_player':
            return 'media.state';
        case 'device_tracker':
            return 'state';
        case 'scene':
            return 'button';
        case 'script':
            return 'button';
        case 'automation':
            return 'switch';
        case 'vacuum':
            return 'state';
        case 'weather':
            return 'weather';
        default:
            if (state === 'on' || state === 'off') {
                return 'switch';
            }
            if (typeof state === 'number' || !isNaN(parseFloat(String(state)))) {
                return 'value';
            }
            if (typeof state === 'boolean') {
                return 'indicator';
            }
            return 'state';
    }
}
function getRoleForAttribute(attr, value, type) {
    const attrLower = attr.toLowerCase();
    if (attrLower.includes('temperature')) {
        return 'value.temperature';
    }
    if (attrLower.includes('humidity')) {
        return 'value.humidity';
    }
    if (attrLower.includes('pressure')) {
        return 'value.pressure';
    }
    if (attrLower === 'brightness' || attrLower === 'current_position') {
        return 'level.dimmer';
    }
    if (attrLower === 'rgb_color' || attrLower === 'xy_color') {
        return 'level.color.rgb';
    }
    if (attrLower === 'color_temp') {
        return 'level.color.temperature';
    }
    if (attrLower === 'battery_level' || attrLower === 'battery') {
        return 'value.battery';
    }
    if (attrLower === 'locked') {
        return 'indicator';
    }
    if (attrLower === 'volume_level') {
        return 'level.volume';
    }
    if (attrLower === 'position') {
        return 'level';
    }
    if (attrLower === 'speed' || attrLower === 'percentage') {
        return 'level';
    }
    if (attrLower === 'mode' || attrLower === 'preset_mode') {
        return 'text';
    }
    switch (type) {
        case 'number':
            return 'value';
        case 'boolean':
            return 'indicator';
        case 'string':
            return 'text';
        case 'object':
        case 'mixed':
        case 'array':
            return 'json';
        default:
            return 'state';
    }
}
class HassAdapter extends adapter_core_1.Adapter {
    static DEFAULT_OBJECTS_WARN_LIMIT = 30000;
    hassConnected = false;
    hass = null;
    hassObjects = {};
    delayTimeout = null;
    syncDebounceTimeout = null;
    stopped = false;
    excludePatterns = [];
    initialSyncCompleted = false;
    constructor(options = {}) {
        super({
            ...options,
            name: 'hass',
            ready: () => this.main(),
            unload: callback => this.onUnload(callback),
            stateChange: (id, state) => this.onStateChange(id, state),
        });
    }
    debouncedSync(callback) {
        if (this.syncDebounceTimeout) {
            clearTimeout(this.syncDebounceTimeout);
        }
        this.syncDebounceTimeout = setTimeout(() => {
            this.syncDebounceTimeout = null;
            this.hass.getStates((err, states) => {
                if (err) {
                    this.log.error(`Cannot read states during resync: ${err}`);
                    return;
                }
                this.hass.getServices(async (err, services) => {
                    if (err) {
                        this.log.error(`Cannot read services during resync: ${err}`);
                        return;
                    }
                    await this.parseStates(states, services);
                    callback?.();
                });
            });
        }, 3000);
    }
    isEntityExcluded(entityId) {
        return (0, entityFilter_1.isAnyExcluded)([entityId, `entities.${entityId}`, `${this.namespace}.entities.${entityId}`], this.excludePatterns);
    }
    isObjectIdExcluded(id) {
        const idWithoutNamespace = id.startsWith(`${this.namespace}.`) ? id.substring(this.namespace.length + 1) : id;
        return (0, entityFilter_1.isAnyExcluded)([idWithoutNamespace, id], this.excludePatterns);
    }
    onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        if (!this.hassConnected) {
            this.log.warn(`Cannot send command to "${id}", because not connected`);
            return;
        }
        if (!this.hassObjects[id]) {
            return;
        }
        if (!this.hassObjects[id].common.write) {
            this.log.warn(`Object ${id} is not writable!`);
            return;
        }
        // Handle boolean state toggle
        if (id.endsWith('.state_boolean')) {
            const entityId = this.hassObjects[id].native.entity_id;
            const domain = entityId
                ? entityId.split('.')[0]
                : this.hassObjects[id].native.domain || this.hassObjects[id].native.type;
            const service = state.val ? 'turn_on' : 'turn_off';
            this.log.debug(`Processing boolean state change for ${id}`);
            this.log.debug(`Domain: ${domain}, Entity: ${this.hassObjects[id].native.entity_id}, Service: ${service}, Value: ${state.val}`);
            if (domain) {
                const serviceData = { entity_id: this.hassObjects[id].native.entity_id };
                this.hass.callService(service, domain, serviceData, {}, err => {
                    if (err) {
                        this.log.error(`Cannot control ${id}: ${err}`);
                    }
                    else {
                        this.log.debug(`Successfully sent command to HASS for ${id}`);
                    }
                });
                return;
            }
            this.log.warn(`No domain found for ${id}`);
        }
        const serviceData = {};
        const fields = this.hassObjects[id].native.fields;
        const target = {};
        let requestFields = {};
        if (typeof state.val === 'string') {
            state.val = state.val.trim();
            if (state.val.startsWith('{') && state.val.endsWith('}')) {
                try {
                    requestFields = JSON.parse(state.val) || {};
                }
                catch (err) {
                    this.log.info(`Ignore data for service call ${id} is no valid JSON: ${err.message}`);
                    requestFields = {};
                }
            }
        }
        // If a non-JSON value was set, and we only have one relevant field, use this field as value
        if (fields && !Object.keys(requestFields).length) {
            const fieldList = Object.keys(fields);
            if (fieldList.length === 1 && fieldList[0] !== 'entity_id') {
                requestFields[fieldList[0]] = state.val;
            }
            else if (fieldList.length === 2 && fields.entity_id) {
                requestFields[fieldList[1 - fieldList.indexOf('entity_id')]] = state.val;
            }
        }
        this.log.debug(`Prepare service call for ${id} with (mapped) request parameters ${JSON.stringify(requestFields)} from value: ${JSON.stringify(state.val)}`);
        if (fields) {
            for (const field in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, field)) {
                    continue;
                }
                if (field === 'entity_id') {
                    target.entity_id = this.hassObjects[id].native.entity_id;
                }
                else if (requestFields[field] !== undefined) {
                    serviceData[field] = requestFields[field];
                }
            }
        }
        const noFields = Object.keys(serviceData).length === 0;
        serviceData.entity_id = this.hassObjects[id].native.entity_id;
        this.log.debug(`Send to HASS for service ${this.hassObjects[id].native.attr} with ${this.hassObjects[id].native.domain || this.hassObjects[id].native.type} and data ${JSON.stringify(serviceData)}`);
        this.hass.callService(this.hassObjects[id].native.attr, this.hassObjects[id].native.domain || this.hassObjects[id].native.type, serviceData, target, err => {
            if (err) {
                this.log.error(`Cannot control ${id}: ${err}`);
            }
            if (err && fields && noFields) {
                this.log.warn(`Please make sure to provide a stringified JSON as value to set relevant fields! Please refer to the Readme for details!`);
                this.log.warn(`Allowed field keys are: ${Object.keys(fields).join(', ')}`);
            }
        });
    }
    onUnload(callback) {
        this.stopped = true;
        if (this.delayTimeout) {
            clearTimeout(this.delayTimeout);
            this.delayTimeout = null;
        }
        if (this.syncDebounceTimeout) {
            clearTimeout(this.syncDebounceTimeout);
            this.syncDebounceTimeout = null;
        }
        this.hass?.close();
        callback?.();
    }
    async syncStates(states) {
        if (states?.length) {
            for (const state of states) {
                const id = state.id;
                delete state.id;
                if (!this.hassObjects[id]) {
                    this.log.debug(`Skip state sync for "${id}": object does not exist`);
                    continue;
                }
                try {
                    await this.setForeignStateAsync(id, state);
                }
                catch (err) {
                    this.log.error(err.toString());
                }
            }
        }
    }
    async syncObjects(objects) {
        const stats = { newCount: 0, updatedCount: 0 };
        if (objects?.length) {
            for (const obj of objects) {
                try {
                    const oldObj = await this.getForeignObjectAsync(obj._id);
                    if (!oldObj) {
                        this.log.debug(`Create "${obj._id}": ${JSON.stringify(obj.common)}`);
                        this.hassObjects[obj._id] = obj;
                        await this.setForeignObjectAsync(obj._id, obj);
                        stats.newCount++;
                    }
                    else {
                        this.hassObjects[obj._id] = oldObj;
                        if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                            oldObj.native = obj.native;
                            this.log.debug(`Update "${obj._id}": ${JSON.stringify(obj.common)}`);
                            await this.setForeignObjectAsync(obj._id, oldObj);
                            stats.updatedCount++;
                        }
                    }
                }
                catch (err) {
                    delete this.hassObjects[obj._id];
                    this.log.error(err.toString());
                }
            }
        }
        return stats;
    }
    async deleteStaleObjects(expectedObjects) {
        const objectsToDelete = [];
        let knownCount = 0;
        for (const id in this.hassObjects) {
            if (Object.prototype.hasOwnProperty.call(this.hassObjects, id) &&
                id.startsWith(`${this.namespace}.entities.`)) {
                knownCount++;
                if (!expectedObjects.has(id)) {
                    objectsToDelete.push(id);
                }
            }
        }
        // Sanity guard: if HASS returned a drastically smaller entity set than what we
        // know (e.g. mid-startup after a restart), assume the data is incomplete and
        // skip deletion. The next sync will retry.
        if (knownCount > 10 && objectsToDelete.length > knownCount / 2) {
            this.log.warn(`Skipping deletion of ${objectsToDelete.length}/${knownCount} stale objects — HASS likely returned an incomplete state list. Will retry on next sync.`);
            return 0;
        }
        let deletedCount = 0;
        for (const id of objectsToDelete) {
            try {
                // Never auto-delete objects that hold user configuration like
                // common.custom (history/influxdb/sql adapter settings) — losing
                // those silently on a transient HASS hiccup would force the user
                // to recreate them. See issue #165.
                const existing = await this.getForeignObjectAsync(id);
                const custom = existing?.common?.custom;
                if (custom && Object.keys(custom).length) {
                    this.log.debug(`Keeping "${id}" despite being stale: object holds custom adapter configuration`);
                    continue;
                }
                await this.delObjectAsync(id);
                delete this.hassObjects[id];
                deletedCount++;
            }
            catch (err) {
                this.log.error(`Error deleting object ${id}: ${err}`);
            }
        }
        return deletedCount;
    }
    async parseStates(entities, services) {
        const objs = [];
        const states = [];
        const expectedObjects = new Set();
        let excludedCount = 0;
        const excludedIds = [];
        for (let e = 0; e < entities.length; e++) {
            const entity = entities[e];
            if (!entity) {
                continue;
            }
            if (this.isEntityExcluded(entity.entity_id)) {
                excludedCount++;
                if (this.config.verboseFilterLog && !this.initialSyncCompleted) {
                    excludedIds.push(entity.entity_id);
                }
                continue;
            }
            const name = entity.name || entity.attributes?.friendly_name || entity.entity_id;
            const desc = entity.attributes?.attribution || undefined;
            const channelId = `${this.namespace}.entities.${entity.entity_id}`;
            expectedObjects.add(channelId);
            const channel = {
                _id: channelId,
                common: {
                    name,
                },
                type: 'channel',
                native: {
                    object_id: entity.object_id,
                    entity_id: entity.entity_id,
                },
            };
            if (desc) {
                channel.common.desc = desc;
            }
            objs.push(channel);
            const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
            const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;
            if (entity.state !== undefined) {
                const stateId = `${channelId}.state`;
                if (!this.isObjectIdExcluded(stateId)) {
                    expectedObjects.add(stateId);
                    const obj = {
                        _id: stateId,
                        type: 'state',
                        common: {
                            name: `${name} STATE`,
                            type: typeof entity.state,
                            role: getRoleForState(entity),
                            read: true,
                            write: false,
                        },
                        native: {
                            object_id: entity.object_id,
                            domain: entity.domain,
                            entity_id: entity.entity_id,
                        },
                    };
                    if (entity.attributes?.unit_of_measurement) {
                        obj.common.unit = entity.attributes.unit_of_measurement;
                    }
                    objs.push(obj);
                    let val = entity.state;
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }
                    states.push({ id: obj._id, lc, ts, val, ack: true });
                }
                // Create boolean state for on/off entities
                const boolStateId = `${channelId}.state_boolean`;
                if (!this.isObjectIdExcluded(boolStateId) && !objs.find(o => o._id === boolStateId)) {
                    expectedObjects.add(boolStateId);
                    const booleanObj = {
                        _id: boolStateId,
                        type: 'state',
                        common: {
                            name: `${name} STATE_BOOLEAN`,
                            type: 'boolean',
                            read: true,
                            write: true,
                            role: 'switch',
                        },
                        native: {
                            object_id: entity.object_id,
                            domain: entity.domain,
                            entity_id: entity.entity_id,
                            attr: 'state',
                            type: entity.domain,
                        },
                    };
                    objs.push(booleanObj);
                    states.push({
                        id: boolStateId,
                        lc: lc || Date.now(),
                        ts: ts || Date.now(),
                        val: entity.state === 'on',
                        ack: true,
                    });
                }
            }
            if (entity.attributes) {
                for (const attr in entity.attributes) {
                    if (!Object.prototype.hasOwnProperty.call(entity.attributes, attr) ||
                        attr === 'friendly_name' ||
                        attr === 'unit_of_measurement' ||
                        attr === 'icon' ||
                        !attr.length) {
                        continue;
                    }
                    let common;
                    if (knownAttributes[attr]) {
                        common = { ...knownAttributes[attr] };
                    }
                    else {
                        common = {};
                    }
                    const attrId = attr.replace(this.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                    const fullAttrId = `${channelId}.${attrId}`;
                    if (this.isObjectIdExcluded(fullAttrId)) {
                        continue;
                    }
                    expectedObjects.add(fullAttrId);
                    const obj = {
                        _id: fullAttrId,
                        type: 'state',
                        common,
                        native: {
                            object_id: entity.object_id,
                            domain: entity.domain,
                            entity_id: entity.entity_id,
                            attr,
                        },
                    };
                    common.name ||= `${name} ${attr.replace(/_/g, ' ')}`;
                    common.read ??= true;
                    common.write ??= false;
                    common.type ??= mapTypes[typeof entity.attributes[attr]];
                    common.role ??= getRoleForAttribute(attr, entity.attributes[attr], common.type);
                    objs.push(obj);
                    let val = entity.attributes[attr];
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }
                    states.push({ id: obj._id, lc, ts, val, ack: true });
                }
            }
            const serviceType = entity.entity_id.split('.')[0];
            if (services[serviceType] && !skipServices.includes(serviceType)) {
                const service = services[serviceType];
                for (const s in service) {
                    if (Object.prototype.hasOwnProperty.call(service, s)) {
                        const serviceId = `${channelId}.${s}`;
                        if (this.isObjectIdExcluded(serviceId)) {
                            continue;
                        }
                        expectedObjects.add(serviceId);
                        const obj = {
                            _id: serviceId,
                            type: 'state',
                            common: {
                                name: entity.entity_id,
                                desc: service[s].description,
                                read: false,
                                write: true,
                                type: 'mixed',
                                role: 'button',
                            },
                            native: {
                                object_id: entity.object_id,
                                domain: entity.domain,
                                fields: service[s].fields,
                                entity_id: entity.entity_id,
                                attr: s,
                                type: serviceType,
                            },
                        };
                        objs.push(obj);
                    }
                }
            }
        }
        const deletedCount = await this.deleteStaleObjects(expectedObjects);
        const syncStats = await this.syncObjects(objs);
        await this.syncStates(states);
        if (syncStats.newCount > 0 || deletedCount > 0) {
            const changes = [];
            if (syncStats.newCount > 0) {
                changes.push(`${syncStats.newCount} created`);
            }
            if (deletedCount > 0) {
                changes.push(`${deletedCount} deleted`);
            }
            this.log.info(`Synchronization completed: ${changes.join(', ')}`);
        }
        if (excludedCount > 0) {
            this.log.info(`Entity filter excluded ${excludedCount} entit${excludedCount === 1 ? 'y' : 'ies'} from sync`);
        }
        if (excludedIds.length > 0) {
            for (const id of excludedIds) {
                this.log.info(`Entity filter excluded: ${id}`);
            }
        }
        this.initialSyncCompleted = true;
    }
    async cleanupExcludedObjects() {
        if (!this.config.cleanupExcludedOnStart) {
            return;
        }
        if (this.excludePatterns.length === 0) {
            this.log.info('Cleanup skipped: no exclude patterns configured');
            return;
        }
        let allObjects;
        try {
            allObjects = await this.getAdapterObjectsAsync();
        }
        catch (err) {
            this.log.error(`Cleanup: failed to load adapter objects: ${err}`);
            return;
        }
        const prefix = `${this.namespace}.entities.`;
        // Collect every object under entities.* whose entity_id or concrete object
        // path matches an exclude pattern. This supports both broad entity filters
        // like `device_tracker.*` and narrow object filters like
        // `entities.sensor.foo.device_class`.
        const idsToDelete = new Set();
        for (const id in allObjects) {
            if (!Object.prototype.hasOwnProperty.call(allObjects, id) || !id.startsWith(prefix)) {
                continue;
            }
            const rest = id.substring(prefix.length);
            const parts = rest.split('.');
            if (parts.length < 2) {
                continue;
            }
            const entityId = `${parts[0]}.${parts[1]}`;
            if (this.isEntityExcluded(entityId) || this.isObjectIdExcluded(id)) {
                idsToDelete.add(id);
            }
        }
        if (idsToDelete.size === 0) {
            this.log.info('Cleanup: no existing objects matched exclude patterns');
            return;
        }
        let deletedIdCount = 0;
        let keptForCustomCount = 0;
        const sortedIds = [...idsToDelete].sort((a, b) => b.length - a.length);
        for (const id of sortedIds) {
            const custom = allObjects[id].common?.custom;
            if (custom && Object.keys(custom).length) {
                keptForCustomCount++;
                this.log.warn(`Cleanup: keeping object "${id}" — has custom adapter config (history/influxdb/sql); remove it manually if you really want to drop it`);
                continue;
            }
            try {
                await this.delObjectAsync(id);
                delete this.hassObjects[id];
                deletedIdCount++;
                if (this.config.verboseFilterLog) {
                    this.log.info(`Cleanup: deleted object "${id}"`);
                }
            }
            catch (err) {
                this.log.error(`Cleanup: failed to delete "${id}": ${err}`);
            }
        }
        this.log.info(`Cleanup: deleted ${deletedIdCount} excluded object${deletedIdCount === 1 ? '' : 's'}${keptForCustomCount > 0
            ? `, kept ${keptForCustomCount} object${keptForCustomCount === 1 ? '' : 's'} with custom config (see warnings above)`
            : ''}`);
    }
    async ensureObjectsWarnLimit() {
        const id = 'objectsWarnLimit';
        await this.extendObjectAsync(id, {
            type: 'state',
            common: {
                role: 'state',
                name: 'Object warning limit for this adapter instance',
                type: 'number',
                read: true,
                write: true,
                def: HassAdapter.DEFAULT_OBJECTS_WARN_LIMIT,
            },
            native: {},
        });
        const current = await this.getStateAsync(id);
        if (typeof current?.val !== 'number' || current.val < HassAdapter.DEFAULT_OBJECTS_WARN_LIMIT) {
            await this.setStateAsync(id, HassAdapter.DEFAULT_OBJECTS_WARN_LIMIT, true);
            this.log.info(`Object warning limit set to ${HassAdapter.DEFAULT_OBJECTS_WARN_LIMIT}`);
        }
    }
    async main() {
        this.config.host ||= '127.0.0.1';
        this.config.port = parseInt(String(this.config.port), 10) || 8123;
        await this.ensureObjectsWarnLimit();
        const rawPatterns = (this.config.excludePatterns || '').toString();
        const stringPatterns = rawPatterns
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));
        this.excludePatterns = (0, entityFilter_1.buildExcludeRegexps)(stringPatterns);
        if (this.excludePatterns.length === 0) {
            this.log.info('Entity filter inactive (no exclude patterns configured)');
        }
        else {
            this.log.info(`Entity filter active: ${this.excludePatterns.length} pattern(s) loaded: ${stringPatterns.join(', ')}`);
        }
        await this.cleanupExcludedObjects();
        await this.setStateAsync('info.connection', false, true);
        this.hass = new hass_1.default(this.config, this.log);
        this.hass.on('error', err => this.log.error(err));
        this.hass.on('state_changed', async (entity) => {
            this.log.debug(`HASS-Message: State Changed: ${JSON.stringify(entity)}`);
            if (!entity || typeof entity.entity_id !== 'string') {
                return;
            }
            if (!this.initialSyncCompleted) {
                this.log.debug(`Ignoring state_changed for ${entity.entity_id} before initial sync completed`);
                return;
            }
            if (this.isEntityExcluded(entity.entity_id)) {
                this.log.debug(`Entity filter: ignored state_changed for ${entity.entity_id}`);
                return;
            }
            const id = `entities.${entity.entity_id}.`;
            const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
            const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;
            if (entity.state !== undefined) {
                const stateObjectId = `${this.namespace}.${id}state`;
                if (this.isObjectIdExcluded(stateObjectId)) {
                    this.log.debug(`Entity filter: ignored state_changed for ${id}state`);
                }
                else if (this.hassObjects[stateObjectId]) {
                    await this.setStateAsync(`${id}state`, { val: entity.state, ack: true, lc, ts });
                }
                else {
                    this.log.info(`State changed for unknown object ${id}state. Triggering synchronization to resync the objects.`);
                    this.debouncedSync();
                }
                // Update boolean state
                const booleanObjectId = `${this.namespace}.${id}state_boolean`;
                if (this.isObjectIdExcluded(booleanObjectId)) {
                    this.log.debug(`Entity filter: ignored state_changed for ${id}state_boolean`);
                }
                else if (this.hassObjects[booleanObjectId]) {
                    await this.setStateAsync(`${id}state_boolean`, {
                        val: entity.state === 'on',
                        ack: true,
                        lc: lc || Date.now(),
                        ts: ts || Date.now(),
                    });
                }
            }
            if (entity.attributes) {
                for (const attr in entity.attributes) {
                    if (!Object.prototype.hasOwnProperty.call(entity.attributes, attr) ||
                        attr === 'friendly_name' ||
                        attr === 'unit_of_measurement' ||
                        attr === 'icon' ||
                        !attr.length) {
                        continue;
                    }
                    let val = entity.attributes[attr];
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }
                    const attrId = attr.replace(this.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                    const fullAttrId = `${this.namespace}.${id}${attrId}`;
                    if (this.isObjectIdExcluded(fullAttrId)) {
                        this.log.debug(`Entity filter: ignored state_changed for ${id}${attrId}`);
                        continue;
                    }
                    if (this.hassObjects[`${this.namespace}.${id}state`]) {
                        if (!this.hassObjects[fullAttrId]) {
                            // Attribute appeared after initial sync — create object dynamically
                            const common = {
                                ...knownAttributes[attr],
                                name: attr.replace(/_/g, ' '),
                                read: true,
                                write: false,
                                role: 'state',
                                type: mapTypes[typeof entity.attributes[attr]] ?? 'mixed',
                            };
                            const newObj = {
                                _id: fullAttrId,
                                type: 'state',
                                common,
                                native: { entity_id: entity.entity_id, attr },
                            };
                            this.log.debug(`Creating missing attribute object ${fullAttrId}`);
                            await this.setForeignObjectAsync(fullAttrId, newObj);
                            this.hassObjects[fullAttrId] = newObj;
                        }
                        await this.setStateAsync(id + attrId, { val, ack: true, lc, ts });
                    }
                    else {
                        this.log.info(`State changed for unknown object ${id + attrId}. Triggering synchronization to resync the objects.`);
                        this.debouncedSync();
                    }
                }
            }
        });
        this.hass.on('connected', () => {
            if (!this.hassConnected) {
                this.log.debug('Connected');
                this.hassConnected = true;
                void this.setState('info.connection', true, true);
                this.hass.getConfig(err => {
                    if (err) {
                        this.log.error(`Cannot read config: ${err}`);
                        return;
                    }
                    this.delayTimeout = setTimeout(() => {
                        this.delayTimeout = null;
                        if (!this.stopped) {
                            this.hass.getStates((err, states) => {
                                if (this.stopped) {
                                    return;
                                }
                                if (err) {
                                    this.log.error(`Cannot read states: ${err}`);
                                    return;
                                }
                                this.delayTimeout = setTimeout(() => {
                                    this.delayTimeout = null;
                                    if (!this.stopped) {
                                        this.hass.getServices(async (err, services) => {
                                            if (this.stopped) {
                                                return;
                                            }
                                            if (err) {
                                                this.log.error(`Cannot read services: ${err}`);
                                            }
                                            else {
                                                await this.parseStates(states, services);
                                                this.log.info('Initialization completed');
                                                await this.subscribeStatesAsync('*');
                                            }
                                        });
                                    }
                                }, 100);
                            });
                        }
                    }, 100);
                });
            }
        });
        this.hass.on('disconnected', () => {
            if (this.hassConnected) {
                this.log.debug('Disconnected');
                this.hassConnected = false;
                void this.setState('info.connection', false, true);
            }
        });
        this.hass.connect();
    }
}
exports.default = HassAdapter;
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new HassAdapter(options);
}
else {
    // otherwise start the instance directly
    (() => new HassAdapter())();
}
//# sourceMappingURL=main.js.map