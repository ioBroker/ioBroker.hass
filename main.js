/* jshint -W097 */
/* jshint strict:false */
/* jslint node: true */

'use strict';

var utils = require(__dirname + '/lib/utils');
var HASS = require(__dirname + '/lib/hass');

var adapter = utils.Adapter('hass');

var connected = false;
var hass;
var hassObjects = {};

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        if (!connected) {
            adapter.log.warn('Cannot send command to "' + id + '", because not connected');
            return;
        }
        /*if (id === adapter.namespace + '.' + '.info.resync') {
            queue.push({command: 'resync'});
            processQueue();
        } else */
        if (hassObjects[id]) {
            if (!hassObjects[id].common.write) {
                adapter.log.warn('Object ' + id + ' is not writable!');
            } else {
                var serviceData = {};
                var fields = hassObjects[id].native.fields;

                for (var field in fields) {
                    if (!fields.hasOwnProperty(field)) continue;

                    if (field === 'entity_id') {
                        serviceData.entity_id = hassObjects[id].native.entity_id
                    } else {
                        serviceData[field] = state.val;
                    }
                }

                hass.callService(hassObjects[id].native.attr, hassObjects[id].native.domain || hassObjects[id].native.type, serviceData, function (err) {
                    if (err) {
                        adapter.log.error('Cannot control ' + id + ': ' + err);
                    }
                });
            }
        }
    }
});

// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', main);

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
        cb();
        return;
    }
    var state = states.shift();
    var id = state.id;
    delete state.id;

    adapter.setForeignState(id, state, function (err) {
        if (err) adapter.log.error(err);
        setImmediate(syncStates, states, cb);
    });
}

function syncObjects(objects, cb) {
    if (!objects || !objects.length) {
        cb();
        return;
    }
    var obj = objects.shift();
    hassObjects[obj._id] = obj;

    adapter.getForeignObject(obj._id, function (err, oldObj) {

        if (err) adapter.log.error(err);

        if (!oldObj) {
            adapter.log.debug('Create "' + obj._id + '"');
            hassObjects[obj._id] = obj;
            adapter.setForeignObject(obj._id, obj, function (err) {
                if (err) adapter.log.error(err);

                setImmediate(syncObjects, objects, cb);
            });
        } else {
            hassObjects[obj._id] = oldObj;
            if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                oldObj.native = obj.native;

                adapter.log.debug('Update "' + obj._id + '"');
                adapter.setForeignObject(obj._id, oldObj, function (err) {
                    if (err) adapter.log.error(err);
                    setImmediate(syncObjects, objects, cb);
                });
            } else {
                setImmediate(syncObjects, objects, cb);
            }
        }
    });
}

function syncRoom(room, members, cb) {
    adapter.getForeignObject('enum.rooms.' + room, function (err, obj) {
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
            adapter.setForeignObject(obj._id, obj, function (err) {
                if (err) adapter.log.error(err);
                cb();
            });
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            var changed = false;
            for (var m = 0; m < members.length; m++) {
                if (obj.common.members.indexOf(members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(members[m]);
                }
            }
            if (changed) {
                adapter.log.debug('Update "' + obj._id + '"');
                adapter.setForeignObject(obj._id, obj, function (err) {
                    if (err) adapter.log.error(err);
                    cb();
                });
            } else {
                cb();
            }
        }
    });
}

var knownAttributes = {
    azimuth: {write: false, read: true, unit: '°'},
    elevation: {write: false, read: true, unit: '°'}
};


var ERRORS = {
    1: 'ERR_CANNOT_CONNECT',
    2: 'ERR_INVALID_AUTH',
    3: 'ERR_CONNECTION_LOST'
};
var mapTypes = {
    'string': 'string',
    'number': 'number',
    'object': 'mixed',
    'boolean': 'boolean'
};
var skipServices = [
    'persistent_notification'
];

function parseStates(entities, services, callback) {
    var objs = [];
    var states = [];
    var obj;
    var channel;
    for (var e = 0; e < entities.length; e++) {
        var entity = entities[e];
        if (!entity) continue;

        var name = entity.name || (entity.attributes && entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id);
        var desc = entity.attributes && entity.attributes.attribution   ? entity.attributes.attribution   : undefined;

        channel = {
            _id: adapter.namespace  + '.entities.' + entity.entity_id,
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

        var lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        var ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;

        if (entity.state !== undefined) {
            obj = {
                _id: adapter.namespace  + '.entities.' + entity.entity_id + '.state',
                type: 'state',
                common: {
                    name: name + ' STATE',
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
            objs.push(obj);
            states.push({id: obj._id, lc: lc, ts: ts, val: entity.state, ack: true})
        }

        if (entity.attributes) {
            for (var attr in entity.attributes) {
                if (entity.attributes.hasOwnProperty(attr)) {
                    if (attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') continue;

                    var common;
                    if (knownAttributes[attr]) {
                        common = Object.assign({}, knownAttributes[attr]);
                    } else {
                        common = {};
                    }

                    obj = {
                        _id: adapter.namespace  + '.entities.' + entity.entity_id + '.' + attr,
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

                    objs.push(obj);
                    states.push({id: obj._id, lc: lc, ts: ts, val: entity.attributes[attr], ack: true});
                }
            }
        }

        var serviceType = entity.entity_id.split('.')[0];

        if (services[serviceType] && skipServices.indexOf(serviceType) === -1) {
            var service = services[serviceType];
            for (var s in service) {
                if (service.hasOwnProperty(s)) {
                    obj = {
                        _id: adapter.namespace  + '.entities.' + entity.entity_id + '.' + s,
                        type: 'state',
                        common: {
                            desc: service[s].description,
                            read: false,
                            write: true
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
                    objs.push(obj);
                }
            }
        }
    }

    syncObjects(objs, function () {
        syncStates(states, callback);
    });
}

function main() {
    adapter.config.host = adapter.config.host || '127.0.0.1';
    adapter.config.port = parseInt(adapter.config.port, 10) || 8123;

    adapter.setState('info.connection', false, true);

    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

    hass = new HASS(adapter.config, adapter.log);

    hass.on('error', function (err) {
        adapter.log.error(err);
    });
    hass.on('state_changed', function (entity) {
        var id = adapter.namespace  + '.entities.' + entity.entity_id + '.';
        var lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        var ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;
        if (entity.state !== undefined) {
            adapter.setForeignState(id + 'state', {val: entity.state, ack: true, lc: lc, ts: ts});
        }
        if (entity.attributes) {
            for (var attr in entity.attributes) {
                if (!entity.attributes.hasOwnProperty(attr) || attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') continue;
                adapter.setForeignState(id + attr, {val: entity.attributes[attr], ack: true, lc: lc, ts: ts});
            }
        }
    });

    hass.on('connected', function () {
        if (!connected) {
            adapter.log.debug('Connected');
            connected = true;
            adapter.setState('info.connection', true, true);
            hass.getConfig(function (err, config) {
                if (err) {
                    adapter.log.error('Cannot read config: ' + err);
                    return;
                }
                //adapter.log.debug(JSON.stringify(config));
                setTimeout(function () {
                    hass.getStates(function (err, states) {
                        if (err) {
                            return adapter.log.error('Cannot read states: ' + err);
                        }
                        //adapter.log.debug(JSON.stringify(states));
                        setTimeout(function () {
                            hass.getServices(function (err, services) {
                                if (err) {
                                    adapter.log.error('Cannot read states: ' + err);
                                } else {
                                    //adapter.log.debug(JSON.stringify(services));
                                    parseStates(states, services, function () {

                                    });
                                }
                            });
                        }, 100);
                    });
                }, 100);
            });
        }
    });

    hass.on('disconnected', function () {
        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });

    hass.connect();
}
