import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import HASS from './lib/hass';

interface HassAdapterConfig {
    host: string;
    port: number;
    password: string;
    secure: boolean;
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

class HassAdapter extends Adapter {
    declare config: HassAdapterConfig;

    private hassConnected: boolean = false;
    private hass: HASS | null = null;
    private readonly hassObjects: Record<string, ioBroker.ChannelObject | ioBroker.StateObject> = {};
    private delayTimeout: ReturnType<typeof setTimeout> | null = null;
    private stopped: boolean = false;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'hass',
            ready: () => this.main(),
            unload: callback => this.onUnload(callback),
            stateChange: (id, state) => this.onStateChange(id, state),
        });
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

        const serviceData: Record<string, any> = {};
        const fields: { entity_id: string } = this.hassObjects[id].native.fields;
        const target: Record<string, any> = {};

        let requestFields: Record<string, any> = {};
        if (typeof state.val === 'string') {
            state.val = state.val.trim();
            if (state.val.startsWith('{') && state.val.endsWith('}')) {
                try {
                    requestFields = JSON.parse(state.val) || {};
                } catch (err) {
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
                    this.log.error(err.toString());
                }
            }
        }
    }

    private async syncObjects(objects: (ioBroker.ChannelObject | ioBroker.StateObject)[]): Promise<void> {
        if (objects?.length) {
            for (const obj of objects) {
                this.hassObjects[obj._id] = obj;

                try {
                    const oldObj = await this.getForeignObjectAsync(obj._id);
                    if (!oldObj) {
                        this.log.debug(`Create "${obj._id}": ${JSON.stringify(obj.common)}`);
                        this.hassObjects[obj._id] = obj;
                        await this.setForeignObjectAsync(obj._id, obj);
                    } else {
                        this.hassObjects[obj._id] = oldObj as ioBroker.StateObject | ioBroker.ChannelObject;
                        if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                            oldObj.native = obj.native;
                            this.log.debug(`Update "${obj._id}": ${JSON.stringify(obj.common)}`);
                            await this.setForeignObjectAsync(obj._id, oldObj);
                        }
                    }
                } catch (err) {
                    this.log.error(err.toString());
                }
            }
        }
    }

    private async parseStates(
        entities: {
            name: string;
            attributes: { friendly_name?: string; attribution?: string; unit_of_measurement?: string };
            entity_id: string;
            object_id: string;
            last_changed?: string;
            last_updated?: string;
            state: ioBroker.StateValue;
            domain: string;
        }[],
        services: Record<string, { [serviceType: string]: { description: string; fields: { entity_id: string } } }>,
    ): Promise<void> {
        const objs: (ioBroker.ChannelObject | ioBroker.StateObject)[] = [];
        const states: { id: string; lc?: number; ts?: number; val: ioBroker.StateValue; ack: boolean }[] = [];

        for (let e = 0; e < entities.length; e++) {
            const entity = entities[e];
            if (!entity) {
                continue;
            }

            const name = entity.name || entity.attributes?.friendly_name || entity.entity_id;
            const desc = entity.attributes?.attribution || undefined;

            const channel: ioBroker.ChannelObject = {
                _id: `${this.namespace}.entities.${entity.entity_id}`,
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
                const obj: ioBroker.StateObject = {
                    _id: `${this.namespace}.entities.${entity.entity_id}.state`,
                    type: 'state',
                    common: {
                        name: `${name} STATE`,
                        type: typeof entity.state as ioBroker.CommonType,
                        role: 'state',
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
                this.log.debug(
                    `Found Entity state ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`,
                );
                objs.push(obj);

                let val = entity.state;
                if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                    val = JSON.stringify(val);
                }

                states.push({ id: obj._id, lc, ts, val, ack: true });
            }

            if (entity.attributes) {
                for (const attr in entity.attributes) {
                    if (Object.prototype.hasOwnProperty.call(entity.attributes, attr)) {
                        if (attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') {
                            continue;
                        }

                        let common: ioBroker.StateCommon;
                        if (knownAttributes[attr]) {
                            common = { ...knownAttributes[attr] } as ioBroker.StateCommon;
                        } else {
                            common = {} as ioBroker.StateCommon;
                        }

                        const attrId = attr.replace(this.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                        const obj: ioBroker.StateObject = {
                            _id: `${this.namespace}.entities.${entity.entity_id}.${attrId}`,
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
                        common.type ??=
                            mapTypes[
                                typeof entity.attributes[
                                    attr as 'friendly_name' | 'attribution' | 'unit_of_measurement'
                                ]
                            ];

                        this.log.debug(
                            `Found Entity attribute ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`,
                        );

                        objs.push(obj);

                        let val: string | null =
                            entity.attributes[attr as 'friendly_name' | 'attribution' | 'unit_of_measurement'] ?? null;
                        if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                            val = JSON.stringify(val);
                        }

                        states.push({ id: obj._id, lc, ts, val, ack: true });
                    }
                }
            }

            const serviceType = entity.entity_id.split('.')[0];

            if (services[serviceType] && !skipServices.includes(serviceType)) {
                const service = services[serviceType];
                for (const s in service) {
                    if (Object.prototype.hasOwnProperty.call(service, s)) {
                        const obj: ioBroker.StateObject = {
                            _id: `${this.namespace}.entities.${entity.entity_id}.${s}`,
                            type: 'state',
                            common: {
                                name: entity.entity_id,
                                desc: service[s].description,
                                read: false,
                                write: true,
                                type: 'mixed' as ioBroker.CommonType,
                                role: 'state',
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

                        this.log.debug(
                            `Found Entity service ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`,
                        );

                        objs.push(obj);
                    }
                }
            }
        }

        await this.syncObjects(objs);
        await this.syncStates(states);
    }

    private async main(): Promise<void> {
        this.config.host ||= '127.0.0.1';
        this.config.port = parseInt(String(this.config.port), 10) || 8123;

        await this.setStateAsync('info.connection', false, true);

        this.hass = new HASS(this.config, this.log);

        this.hass.on('error', err => this.log.error(err));

        this.hass.on('state_changed', entity => {
            this.log.debug(`HASS-Message: State Changed: ${JSON.stringify(entity)}`);
            if (!entity || typeof entity.entity_id !== 'string') {
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
                        `State changed for unknown object ${id}state. Please restart the adapter to resync the objects.`,
                    );
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
                            `State changed for unknown object ${id + attrId}. Please restart the adapter to resync the objects.`,
                        );
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
                                                this.log.error(`Cannot read states: ${err}`);
                                            } else {
                                                await this.parseStates(states, services);
                                                this.log.debug(
                                                    'Initial parsing of states done, subscribe to ioBroker states',
                                                );
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
