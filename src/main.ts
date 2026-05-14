import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import HASS from './lib/hass';
import { isExcluded } from './lib/entityFilter';

interface HassAdapterConfig {
    host: string;
    port: number;
    password: string;
    secure: boolean;
    excludePatterns: string;
    verboseFilterLog: boolean;
    cleanupExcludedOnStart: boolean;
}

interface HassEntity {
    name: string;
    attributes: Record<string, any>;
    entity_id: string;
    object_id: string;
    last_changed?: string;
    last_updated?: string;
    state: ioBroker.StateValue;
    domain: string;
}

interface HassServices {
    [domain: string]: {
        [serviceName: string]: {
            description: string;
            fields: Record<string, any>;
        };
    };
}

const knownAttributes: Record<string, { write: boolean; read: boolean; unit: string }> = {
    azimuth: { write: false, read: true, unit: '°' },
    elevation: { write: false, read: true, unit: '°' },
};

const mapTypes: Record<string, ioBroker.CommonType> = {
    string: 'string',
    number: 'number',
    object: 'mixed',
    boolean: 'boolean',
};

const skipServices: string[] = ['persistent_notification'];

function getRoleForState(entity: HassEntity): string {
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

function getRoleForAttribute(attr: string, value: ioBroker.StateValue, type: ioBroker.CommonType): string {
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

class HassAdapter extends Adapter {
    declare config: HassAdapterConfig;

    private hassConnected: boolean = false;
    private hass: HASS | null = null;
    private readonly hassObjects: Record<string, ioBroker.ChannelObject | ioBroker.StateObject> = {};
    private delayTimeout: ReturnType<typeof setTimeout> | null = null;
    private syncDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
    private stopped: boolean = false;
    private excludePatterns: string[] = [];
    private initialSyncCompleted: boolean = false;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'hass',
            ready: () => this.main(),
            unload: callback => this.onUnload(callback),
            stateChange: (id, state) => this.onStateChange(id, state),
        });
    }

    private debouncedSync(callback?: () => void): void {
        if (this.syncDebounceTimeout) {
            clearTimeout(this.syncDebounceTimeout);
        }
        this.syncDebounceTimeout = setTimeout(() => {
            this.syncDebounceTimeout = null;
            this.hass!.getStates((err, states) => {
                if (err) {
                    this.log.error(`Cannot read states during resync: ${err}`);
                    return;
                }
                this.hass!.getServices(async (err, services) => {
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

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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

        if (!(this.hassObjects[id] as ioBroker.StateObject).common.write) {
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
            this.log.debug(
                `Domain: ${domain}, Entity: ${this.hassObjects[id].native.entity_id}, Service: ${service}, Value: ${state.val}`,
            );

            if (domain) {
                const serviceData = { entity_id: this.hassObjects[id].native.entity_id };
                this.hass!.callService(service, domain, serviceData, {}, err => {
                    if (err) {
                        this.log.error(`Cannot control ${id}: ${err}`);
                    } else {
                        this.log.debug(`Successfully sent command to HASS for ${id}`);
                    }
                });
                return;
            }
            this.log.warn(`No domain found for ${id}`);
        }

        const serviceData: Record<string, any> = {};
        const fields: Record<string, any> = this.hassObjects[id].native.fields;
        const target: Record<string, any> = {};

        let requestFields: Record<string, any> = {};
        if (typeof state.val === 'string') {
            state.val = state.val.trim();
            if (state.val.startsWith('{') && state.val.endsWith('}')) {
                try {
                    requestFields = JSON.parse(state.val) || {};
                } catch (err) {
                    this.log.info(`Ignore data for service call ${id} is no valid JSON: ${(err as Error).message}`);
                    requestFields = {};
                }
            }
        }

        // If a non-JSON value was set, and we only have one relevant field, use this field as value
        if (fields && !Object.keys(requestFields).length) {
            const fieldList = Object.keys(fields);
            if (fieldList.length === 1 && fieldList[0] !== 'entity_id') {
                requestFields[fieldList[0]] = state.val;
            } else if (fieldList.length === 2 && fields.entity_id) {
                requestFields[fieldList[1 - fieldList.indexOf('entity_id')]] = state.val;
            }
        }

        this.log.debug(
            `Prepare service call for ${id} with (mapped) request parameters ${JSON.stringify(requestFields)} from value: ${JSON.stringify(state.val)}`,
        );

        if (fields) {
            for (const field in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, field)) {
                    continue;
                }
                if (field === 'entity_id') {
                    target.entity_id = this.hassObjects[id].native.entity_id;
                } else if (requestFields[field] !== undefined) {
                    serviceData[field] = requestFields[field];
                }
            }
        }

        const noFields = Object.keys(serviceData).length === 0;
        serviceData.entity_id = this.hassObjects[id].native.entity_id;

        this.log.debug(
            `Send to HASS for service ${this.hassObjects[id].native.attr} with ${this.hassObjects[id].native.domain || this.hassObjects[id].native.type} and data ${JSON.stringify(serviceData)}`,
        );

        this.hass!.callService(
            this.hassObjects[id].native.attr,
            this.hassObjects[id].native.domain || this.hassObjects[id].native.type,
            serviceData,
            target,
            err => {
                if (err) {
                    this.log.error(`Cannot control ${id}: ${err}`);
                }
                if (err && fields && noFields) {
                    this.log.warn(
                        `Please make sure to provide a stringified JSON as value to set relevant fields! Please refer to the Readme for details!`,
                    );
                    this.log.warn(`Allowed field keys are: ${Object.keys(fields).join(', ')}`);
                }
            },
        );
    }

    private onUnload(callback?: () => void): void {
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

    private async syncStates(
        states: { id?: string; lc?: number; ts?: number; val: ioBroker.StateValue; ack: boolean }[],
    ): Promise<void> {
        if (states?.length) {
            for (const state of states) {
                const id = state.id!;
                delete state.id;

                try {
                    await this.setForeignStateAsync(id, state);
                } catch (err) {
                    this.log.error((err as Error).toString());
                }
            }
        }
    }

    private async syncObjects(objects: (ioBroker.ChannelObject | ioBroker.StateObject)[]): Promise<{
        newCount: number;
        updatedCount: number;
    }> {
        const stats = { newCount: 0, updatedCount: 0 };
        if (objects?.length) {
            for (const obj of objects) {
                this.hassObjects[obj._id] = obj;

                try {
                    const oldObj = await this.getForeignObjectAsync(obj._id);
                    if (!oldObj) {
                        this.log.debug(`Create "${obj._id}": ${JSON.stringify(obj.common)}`);
                        this.hassObjects[obj._id] = obj;
                        await this.setForeignObjectAsync(obj._id, obj);
                        stats.newCount++;
                    } else {
                        this.hassObjects[obj._id] = oldObj as ioBroker.StateObject | ioBroker.ChannelObject;
                        if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                            oldObj.native = obj.native;
                            this.log.debug(`Update "${obj._id}": ${JSON.stringify(obj.common)}`);
                            await this.setForeignObjectAsync(obj._id, oldObj);
                            stats.updatedCount++;
                        }
                    }
                } catch (err) {
                    this.log.error((err as Error).toString());
                }
            }
        }
        return stats;
    }

    private async deleteStaleObjects(expectedObjects: Set<string>): Promise<number> {
        const objectsToDelete: string[] = [];
        let knownCount = 0;
        for (const id in this.hassObjects) {
            if (
                Object.prototype.hasOwnProperty.call(this.hassObjects, id) &&
                id.startsWith(`${this.namespace}.entities.`)
            ) {
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
            this.log.warn(
                `Skipping deletion of ${objectsToDelete.length}/${knownCount} stale objects — HASS likely returned an incomplete state list. Will retry on next sync.`,
            );
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
                const custom = (existing?.common as { custom?: Record<string, unknown> } | undefined)?.custom;
                if (custom && Object.keys(custom).length) {
                    this.log.debug(`Keeping "${id}" despite being stale: object holds custom adapter configuration`);
                    continue;
                }
                await this.delObjectAsync(id);
                delete this.hassObjects[id];
                deletedCount++;
            } catch (err) {
                this.log.error(`Error deleting object ${id}: ${err}`);
            }
        }

        return deletedCount;
    }

    private async parseStates(entities: HassEntity[], services: HassServices): Promise<void> {
        const objs: (ioBroker.ChannelObject | ioBroker.StateObject)[] = [];
        const states: { id: string; lc?: number; ts?: number; val: ioBroker.StateValue; ack: boolean }[] = [];
        const expectedObjects = new Set<string>();
        let excludedCount = 0;
        const excludedIds: string[] = [];

        for (let e = 0; e < entities.length; e++) {
            const entity = entities[e];
            if (!entity) {
                continue;
            }

            if (isExcluded(entity.entity_id, this.excludePatterns)) {
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

            const channel: ioBroker.ChannelObject = {
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
                expectedObjects.add(stateId);

                const obj: ioBroker.StateObject = {
                    _id: stateId,
                    type: 'state',
                    common: {
                        name: `${name} STATE`,
                        type: typeof entity.state as ioBroker.CommonType,
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

                // Create boolean state for on/off entities
                const boolStateId = `${channelId}.state_boolean`;
                expectedObjects.add(boolStateId);

                if (!objs.find(o => o._id === boolStateId)) {
                    const booleanObj: ioBroker.StateObject = {
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
                    if (
                        !Object.prototype.hasOwnProperty.call(entity.attributes, attr) ||
                        attr === 'friendly_name' ||
                        attr === 'unit_of_measurement' ||
                        attr === 'icon' ||
                        !attr.length
                    ) {
                        continue;
                    }

                    let common: ioBroker.StateCommon;
                    if (knownAttributes[attr]) {
                        common = { ...knownAttributes[attr] } as ioBroker.StateCommon;
                    } else {
                        common = {} as ioBroker.StateCommon;
                    }

                    const attrId = attr.replace(this.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                    const fullAttrId = `${channelId}.${attrId}`;
                    expectedObjects.add(fullAttrId);

                    const obj: ioBroker.StateObject = {
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
                        expectedObjects.add(serviceId);

                        const obj: ioBroker.StateObject = {
                            _id: serviceId,
                            type: 'state',
                            common: {
                                name: entity.entity_id,
                                desc: service[s].description,
                                read: false,
                                write: true,
                                type: 'mixed' as ioBroker.CommonType,
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
            const changes: string[] = [];
            if (syncStats.newCount > 0) {
                changes.push(`${syncStats.newCount} created`);
            }
            if (deletedCount > 0) {
                changes.push(`${deletedCount} deleted`);
            }
            this.log.info(`Synchronization completed: ${changes.join(', ')}`);
        }

        if (excludedCount > 0) {
            this.log.info(
                `Entity filter excluded ${excludedCount} entit${excludedCount === 1 ? 'y' : 'ies'} from sync`,
            );
        }

        if (excludedIds.length > 0) {
            for (const id of excludedIds) {
                this.log.info(`Entity filter excluded: ${id}`);
            }
        }

        this.initialSyncCompleted = true;
    }

    private async cleanupExcludedObjects(): Promise<void> {
        if (!this.config.cleanupExcludedOnStart) {
            return;
        }
        if (this.excludePatterns.length === 0) {
            this.log.info('Cleanup skipped: no exclude patterns configured');
            return;
        }

        let allObjects: Record<string, ioBroker.Object>;
        try {
            allObjects = (await this.getAdapterObjectsAsync()) as Record<string, ioBroker.Object>;
        } catch (err) {
            this.log.error(`Cleanup: failed to load adapter objects: ${err}`);
            return;
        }

        const prefix = `${this.namespace}.entities.`;

        // Group every object under entities.* by its derived entity_id. We extract
        // the entity_id from the object id (first two path components after the
        // prefix) instead of native.entity_id — older objects from previous adapter
        // versions may have been written as flat states without a parent channel
        // and without native.entity_id, but their id still encodes the entity.
        const matchedByEntity = new Map<string, string[]>();

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
            if (!isExcluded(entityId, this.excludePatterns)) {
                continue;
            }
            const ids = matchedByEntity.get(entityId);
            if (ids) {
                ids.push(id);
            } else {
                matchedByEntity.set(entityId, [id]);
            }
        }

        if (matchedByEntity.size === 0) {
            this.log.info('Cleanup: no existing objects matched exclude patterns');
            return;
        }

        let deletedEntityCount = 0;
        let deletedIdCount = 0;
        let keptForCustomCount = 0;

        for (const [entityId, ids] of matchedByEntity) {
            // Custom-config protection: scan all ids of the group; if any holds
            // common.custom (history/influxdb/sql) keep the whole entity.
            let hasCustom = false;
            for (const id of ids) {
                const custom = (allObjects[id].common as { custom?: Record<string, unknown> } | undefined)
                    ?.custom;
                if (custom && Object.keys(custom).length) {
                    hasCustom = true;
                    break;
                }
            }
            if (hasCustom) {
                keptForCustomCount++;
                this.log.warn(
                    `Cleanup: keeping entity "${entityId}" — has custom adapter config (history/influxdb/sql); remove it manually if you really want to drop it`,
                );
                continue;
            }

            // Delete sub-states first (longest ids), then any parent channel last.
            const sortedIds = [...ids].sort((a, b) => b.length - a.length);
            let entityFullyDeleted = true;
            for (const id of sortedIds) {
                try {
                    await this.delObjectAsync(id);
                    delete this.hassObjects[id];
                    deletedIdCount++;
                } catch (err) {
                    entityFullyDeleted = false;
                    this.log.error(`Cleanup: failed to delete "${id}": ${err}`);
                }
            }
            if (entityFullyDeleted) {
                deletedEntityCount++;
                if (this.config.verboseFilterLog) {
                    this.log.info(
                        `Cleanup: deleted entity "${entityId}" (${ids.length} object${ids.length === 1 ? '' : 's'})`,
                    );
                }
            }
        }

        this.log.info(
            `Cleanup: deleted ${deletedEntityCount} excluded entit${deletedEntityCount === 1 ? 'y' : 'ies'} (${deletedIdCount} object${deletedIdCount === 1 ? '' : 's'} total)` +
                (keptForCustomCount > 0
                    ? `, kept ${keptForCustomCount} entit${keptForCustomCount === 1 ? 'y' : 'ies'} with custom config (see warnings above)`
                    : ''),
        );
    }

    private async main(): Promise<void> {
        this.config.host ||= '127.0.0.1';
        this.config.port = parseInt(String(this.config.port), 10) || 8123;

        const rawPatterns = (this.config.excludePatterns || '').toString();
        this.excludePatterns = rawPatterns
            .split('\n')
            .map(s => s.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));

        if (this.excludePatterns.length === 0) {
            this.log.info('Entity filter inactive (no exclude patterns configured)');
        } else {
            this.log.info(
                `Entity filter active: ${this.excludePatterns.length} pattern(s) loaded: ${this.excludePatterns.join(', ')}`,
            );
        }

        await this.cleanupExcludedObjects();

        await this.setStateAsync('info.connection', false, true);

        this.hass = new HASS(this.config, this.log);

        this.hass.on('error', err => this.log.error(err));

        this.hass.on('state_changed', entity => {
            this.log.debug(`HASS-Message: State Changed: ${JSON.stringify(entity)}`);
            if (!entity || typeof entity.entity_id !== 'string') {
                return;
            }

            if (isExcluded(entity.entity_id, this.excludePatterns)) {
                this.log.debug(`Entity filter: ignored state_changed for ${entity.entity_id}`);
                return;
            }

            const id = `entities.${entity.entity_id}.`;
            const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
            const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;

            if (entity.state !== undefined) {
                if (this.hassObjects[`${this.namespace}.${id}state`]) {
                    this.setState(`${id}state`, { val: entity.state, ack: true, lc, ts });
                } else {
                    this.log.info(
                        `State changed for unknown object ${id}state. Triggering synchronization to resync the objects.`,
                    );
                    this.debouncedSync();
                }
                // Update boolean state
                if (this.hassObjects[`${this.namespace}.${id}state_boolean`]) {
                    this.setState(`${id}state_boolean`, {
                        val: entity.state === 'on',
                        ack: true,
                        lc: lc || Date.now(),
                        ts: ts || Date.now(),
                    });
                }
            }

            if (entity.attributes) {
                for (const attr in entity.attributes) {
                    if (
                        !Object.prototype.hasOwnProperty.call(entity.attributes, attr) ||
                        attr === 'friendly_name' ||
                        attr === 'unit_of_measurement' ||
                        attr === 'icon' ||
                        !attr.length
                    ) {
                        continue;
                    }
                    let val = entity.attributes[attr];
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }
                    const attrId = attr.replace(this.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                    if (this.hassObjects[`${this.namespace}.${id}state`]) {
                        this.setState(id + attrId, { val, ack: true, lc, ts });
                    } else {
                        this.log.info(
                            `State changed for unknown object ${id + attrId}. Triggering synchronization to resync the objects.`,
                        );
                        this.debouncedSync();
                    }
                }
            }
        });

        this.hass.on('connected', () => {
            if (!this.hassConnected) {
                this.log.debug('Connected');
                this.hassConnected = true;
                this.setState('info.connection', true, true);
                this.hass!.getConfig(err => {
                    if (err) {
                        this.log.error(`Cannot read config: ${err}`);
                        return;
                    }
                    this.delayTimeout = setTimeout(() => {
                        this.delayTimeout = null;
                        if (!this.stopped) {
                            this.hass!.getStates((err, states) => {
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
                                        this.hass!.getServices(async (err, services): Promise<void> => {
                                            if (this.stopped) {
                                                return;
                                            }
                                            if (err) {
                                                this.log.error(`Cannot read services: ${err}`);
                                            } else {
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
                this.setState('info.connection', false, true);
            }
        });

        this.hass.connect();
    }
}

export default HassAdapter;

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new HassAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new HassAdapter())();
}
