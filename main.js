/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';

const utils       = require('@iobroker/adapter-core');
const HASS        = require('./lib/hass');
const adapterName = require('./package.json').name.split('.').pop();

let connected = false;
let hass;
let adapter;
const hassObjects = {};
let delayTimeout = null;
let stopped = false;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName, unload: stop});
    adapter = new utils.Adapter(options);

    // is called if a subscribed state changes
    adapter.on('stateChange', (id, state) => {
        // you can use the ack flag to detect if it is status (true) or command (false)
        if (state && !state.ack) {
            if (!connected) {
                return adapter.log.warn('Cannot send command to "' + id + '", because not connected');
            }
            /*if (id === adapter.namespace + '.' + '.info.resync') {
                queue.push({command: 'resync'});
                processQueue();
            } else */
            if (hassObjects[id]) {
                if (!hassObjects[id].common.write) {
                    adapter.log.warn('Object ' + id + ' is not writable!');
                } else {
                    const serviceData = {};
                    const fields = hassObjects[id].native.fields;
                    const target = {};

                    let requestFields = {};
                    if (typeof state.val === 'string') {
                        try {
                            requestFields = JSON.parse(state.val);
                        } catch (err) {
                            adapter.log.info(`Ignore data for service call ${id} is no valid JSON: ${err.message}`);
                            requestFields = {};
                        }
                    }

                    for (const field in fields) {
                        if (!fields.hasOwnProperty(field)) {
                            continue;
                        }

                        if (field === 'entity_id') {
                            target.entity_id = hassObjects[id].native.entity_id
                        } else if (requestFields[field] !== undefined) {
                            serviceData[field] = requestFields[field];
                        }
                    }
                    serviceData.entity_id = hassObjects[id].native.entity_id

                    adapter.log.debug(`Send to HASS for service ${hassObjects[id].native.attr} with ${hassObjects[id].native.domain || hassObjects[id].native.type} and data ${JSON.stringify(serviceData)}`)
                    hass.callService(hassObjects[id].native.attr, hassObjects[id].native.domain || hassObjects[id].native.type, serviceData, target, err =>
                        err && adapter.log.error('Cannot control ' + id + ': ' + err));
                }
            }
        }
    });

    // is called when databases are connected and adapter received configuration.
    // start here!
    adapter.on('ready', main);

    return adapter;
}

function stop(callback) {
    stopped = true;
    delayTimeout && clearTimeout(delayTimeout);
    hass && hass.close();
    callback && callback();
}

function getUnit(name) {
    name = name.toLowerCase();
    if (name.indexOf('temperature') !== -1) {
        return '°C';
    } else if (name.indexOf('humidity') !== -1) {
        return '%';
    } else if (name.indexOf('pressure') !== -1) {
        return 'hPa';
    } else if (name.indexOf('degrees') !== -1) {
        return '°';
    } else if (name.indexOf('speed') !== -1) {
        return 'kmh';
    }
    return undefined;
}

function syncStates(states, cb) {
    if (!states || !states.length) {
        return cb();
    }
    const state = states.shift();
    const id = state.id;
    delete state.id;

    adapter.setForeignState(id, state, err => {
        err && adapter.log.error(err);
        setImmediate(syncStates, states, cb);
    });
}

function syncObjects(objects, cb) {
    if (!objects || !objects.length) {
        return cb();
    }
    const obj = objects.shift();
    hassObjects[obj._id] = obj;

    adapter.getForeignObject(obj._id, (err, oldObj) => {

        err && adapter.log.error(err);

        if (!oldObj) {
            adapter.log.debug('Create "' + obj._id + '": ' + JSON.stringify(obj.common));
            hassObjects[obj._id] = obj;
            adapter.setForeignObject(obj._id, obj, err => {
                err && adapter.log.error(err);
                setImmediate(syncObjects, objects, cb);
            });
        } else {
            hassObjects[obj._id] = oldObj;
            if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                oldObj.native = obj.native;

                adapter.log.debug('Update "' + obj._id + '": ' + JSON.stringify(obj.common));
                adapter.setForeignObject(obj._id, oldObj, err => {
                    err => adapter.log.error(err);
                    setImmediate(syncObjects, objects, cb);
                });
            } else {
                setImmediate(syncObjects, objects, cb);
            }
        }
    });
}

function syncRoom(room, members, cb) {
    adapter.getForeignObject('enum.rooms.' + room, (err, obj) => {
        if (!obj) {
            obj = {
                _id: 'enum.rooms.' + room,
                type: 'enum',
                common: {
                    name: room,
                    members: members
                },
                native: {}
            };
            adapter.log.debug('Update "' + obj._id + '"');
            adapter.setForeignObject(obj._id, obj, err => {
                err && adapter.log.error(err);
                cb();
            });
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            let changed = false;
            for (let m = 0; m < members.length; m++) {
                if (obj.common.members.indexOf(members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(members[m]);
                }
            }
            if (changed) {
                adapter.log.debug('Update "' + obj._id + '"');
                adapter.setForeignObject(obj._id, obj, err => {
                    err && adapter.log.error(err);
                    cb();
                });
            } else {
                cb();
            }
        }
    });
}

const knownAttributes = {
    azimuth:   {write: false, read: true, unit: '°'},
    elevation: {write: false, read: true, unit: '°'}
};


const ERRORS = {
    1: 'ERR_CANNOT_CONNECT',
    2: 'ERR_INVALID_AUTH',
    3: 'ERR_CONNECTION_LOST'
};
const mapTypes = {
    'string': 'string',
    'number': 'number',
    'object': 'mixed',
    'boolean': 'boolean'
};
const skipServices = [
    'persistent_notification'
];

function parseStates(entities, services, callback) {
    const objs   = [];
    const states = [];
    let obj;
    let channel;
    for (let e = 0; e < entities.length; e++) {
        const entity = entities[e];
        if (!entity) continue;

        const name = entity.name || (entity.attributes && entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id);
        const desc = entity.attributes && entity.attributes.attribution   ? entity.attributes.attribution   : undefined;

        channel = {
            _id: `${adapter.namespace}.entities.${entity.entity_id}`,
            common: {
                name: name
            },
            type: 'channel',
            native: {
                object_id: entity.object_id,
                entity_id: entity.entity_id
            }
        };
        if (desc) channel.common.desc = desc;
        objs.push(channel);

        const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;

        if (entity.state !== undefined) {
            obj = {
                _id: `${adapter.namespace}.entities.${entity.entity_id}.state`,
                type: 'state',
                common: {
                    name: `${name} STATE`,
                    type: typeof entity.state,
                    read: true,
                    write: false
                },
                native: {
                    object_id:  entity.object_id,
                    domain:     entity.domain,
                    entity_id:  entity.entity_id
                }
            };
            if (entity.attributes && entity.attributes.unit_of_measurement) {
                obj.common.unit = entity.attributes.unit_of_measurement;
            }
            adapter.log.debug(`Found Entity state ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)
            objs.push(obj);

            let val = entity.state;
            if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                val = JSON.stringify(val);
            }

            states.push({id: obj._id, lc, ts, val, ack: true})
        }

        if (entity.attributes) {
            for (const attr in entity.attributes) {
                if (entity.attributes.hasOwnProperty(attr)) {
                    if (attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') {
                        continue;
                    }

                    let common;
                    if (knownAttributes[attr]) {
                        common = Object.assign({}, knownAttributes[attr]);
                    } else {
                        common = {};
                    }

                    obj = {
                        _id: `${adapter.namespace}.entities.${entity.entity_id}.${attr}`,
                        type: 'state',
                        common: common,
                        native: {
                            object_id:  entity.object_id,
                            domain:     entity.domain,
                            entity_id:  entity.entity_id,
                            attr:       attr
                        }
                    };
                    if (!common.name) {
                        common.name = name + ' ' + attr.replace(/_/g, ' ');
                    }
                    if (common.read === undefined) {
                        common.read = true;
                    }
                    if (common.write === undefined) {
                        common.write = false;
                    }
                    if (common.type === undefined) {
                        common.type = mapTypes[typeof entity.attributes[attr]];
                    }

                    adapter.log.debug(`Found Entity attribute ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)

                    objs.push(obj);

                    let val = entity.attributes[attr];
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }

                    states.push({id: obj._id, lc, ts, val, ack: true});
                }
            }
        }

        const serviceType = entity.entity_id.split('.')[0];

        if (services[serviceType] && !skipServices.includes(serviceType)) {
            const service = services[serviceType];
            for (const s in service) {
                if (service.hasOwnProperty(s)) {
                    obj = {
                        _id: `${adapter.namespace}.entities.${entity.entity_id}.${s}`,
                        type: 'state',
                        common: {
                            desc: service[s].description,
                            read: false,
                            write: true,
                            type: 'mixed'
                        },
                        native: {
                            object_id:  entity.object_id,
                            domain:     entity.domain,
                            fields:     service[s].fields,
                            entity_id:  entity.entity_id,
                            attr:       s,
                            type:       serviceType
                        }
                    };

                    adapter.log.debug(`Found Entity service ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)

                    objs.push(obj);
                }
            }
        }
    }

    syncObjects(objs, () =>
        syncStates(states, callback));
}

function main() {
    adapter.config.host = adapter.config.host || '127.0.0.1';
    adapter.config.port = parseInt(adapter.config.port, 10) || 8123;

    adapter.setState('info.connection', false, true);

    hass = new HASS(adapter.config, adapter.log);

    hass.on('error', err =>
        adapter.log.error(err));

    hass.on('state_changed', entity => {
        adapter.log.debug(`HASS-Message: State Changed: ${JSON.stringify(entity)}`);
        if (!entity || typeof entity.entity_id !== 'string') {
            return;
        }
        const serviceType = entity.entity_id.split('.')[0];

        if (skipServices.includes(serviceType)) {
            return;
        }
        const id = adapter.namespace  + '.entities.' + entity.entity_id + '.';
        const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;
        if (entity.state !== undefined) {
            adapter.setForeignState(id + 'state', {val: entity.state, ack: true, lc: lc, ts: ts});
        }
        if (entity.attributes) {
            for (const attr in entity.attributes) {
                if (!entity.attributes.hasOwnProperty(attr) || attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') {
                    continue;
                }
                let val = entity.attributes[attr];
                if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                    val = JSON.stringify(val);
                }
                adapter.setForeignState(id + attr, {val, ack: true, lc, ts});
            }
        }
    });

    hass.on('connected', () => {
        if (!connected) {
            adapter.log.debug('Connected');
            connected = true;
            adapter.setState('info.connection', true, true);
            hass.getConfig((err, config) => {
                if (err) {
                    adapter.log.error('Cannot read config: ' + err);
                    return;
                }
                //adapter.log.debug(JSON.stringify(config));
                delayTimeout = setTimeout(() => {
                    delayTimeout = null;
                    !stopped && hass.getStates((err, states) => {
                        if (stopped) {
                            return;
                        }
                        if (err) {
                            return adapter.log.error('Cannot read states: ' + err);
                        }
                        //adapter.log.debug(JSON.stringify(states));
                        delayTimeout = setTimeout(() => {
                            delayTimeout = null;
                            !stopped && hass.getServices((err, services) => {
                                if (stopped) {
                                    return;
                                }
                                if (err) {
                                    adapter.log.error('Cannot read states: ' + err);
                                } else {
                                    //adapter.log.debug(JSON.stringify(services));
                                    parseStates(states, services, () => {
                                        adapter.log.debug('Initial parsing of states done, subscribe to ioBroker states');
                                        adapter.subscribeStates('*');
                                    });
                                }
                            })}, 100);
                    })}, 100);
            });
        }
    });

    hass.on('disconnected', () => {
        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });

    hass.connect();
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
