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

                    if (fields === 'entity_id') {
                        serviceData.entity_id = hassObjects[id].native.entity_id
                    } else {
                        serviceData.entity_id = state.val;
                    }
                }

                hass.callService(hassObjects[id].native.type, undefined, serviceData, function (err) {
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

    var start = Date.now();

    adapter.getForeignObject(obj._id, function (err, oldObj) {
        console.log('getForeignObject: ' + (Date.now()  - start));

        if (err) adapter.log.error(err);

        if (!oldObj) {
            adapter.log.debug('Create "' + obj._id + '"');
            hassObjects[obj._id] = obj;
            start = Date.now();
            adapter.setForeignObject(obj._id, obj, function (err) {
                console.log('setForeignObject: ' + (Date.now()  - start));
                if (err) adapter.log.error(err);

                setImmediate(syncObjects, objects, cb);
            });
        } else {
            hassObjects[obj._id] = oldObj;
            if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                oldObj.native = obj.native;

                adapter.log.debug('Update "' + obj._id + '"');
                start = Date.now();
                adapter.setForeignObject(obj._id, oldObj, function (err) {
                    console.log('ssetForeignObject: ' + (Date.now()  - start));
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

function syncRooms(rooms, cb) {
    for (var r in rooms) {
        if (!rooms.hasOwnProperty(r)) continue;
        if (rooms[r]) {
            syncRoom(r, rooms[r], function () {
                setTimeout(syncRooms, 0, rooms, cb);
            });
            rooms[r] = null;
            return;
        }
    }

    if (cb) cb();
}

//------------------------------------------------------------<<<
function parseObjects(objs, cb) {
    var rooms = {};
    var objects = [];
    var states = [];
    var id;
    var obj;
    var name;
    var ignoreStates = ['getConfig', 'getRegRaw', 'regBulk', 'regSet', 'deviceMsg', 'CommandAccepted'];

    for (var i = 0; i < objs.length; i++) {
        try {
            name = objs[i].Name.replace(/\./g, '_');

            if (objs[i].Attributes && objs[i].Attributes.room === 'hidden') continue;

            id = adapter.namespace + '.' + name;

            objects.push({
                _id: id,
                type: 'channel',
                common: {
                    name: objs[i].Name
                },
                native: objs[i]
            });

            if (objs[i].Attributes && objs[i].Attributes.room) {
                var rrr = objs[i].Attributes.room.split(',');
                for (var r = 0; r < rrr.length; r++) {
                    rrr[r] = rrr[r].trim();
                    rooms[rrr[r]] = rooms[rrr[r]] || [];
                    rooms[rrr[r]].push(adapter.namespace + '.' + name);
                }
            }

            var isOn = false;
            var isOff = false;
            var setStates = {};

            if (objs[i].PossibleSets) {
                var attrs = objs[i].PossibleSets.split(' ');
                for (var a = 0; a < attrs.length; a++) {
                    if (!attrs[a]) continue;
                    var parts = attrs[a].split(':');

                    // ignore some useless "sets"
                    if (ignoreStates.indexOf(parts[0]) !== -1) continue;

                    var stateName = parts[0].replace(/\./g, '_');
                    id = adapter.namespace + '.' + name + '.' + stateName;


                    if (parts[0] === 'off') isOff = true;
                    if (parts[0] === 'on') isOn = true;

                    obj = {
                        _id: id,
                        type: 'state',
                        common: {
                            name: objs[i].Name + ' ' + parts[0],
                            read: false,
                            write: true
                        },
                        native: {
                            Name: objs[i].Name,
                            Attribute: parts[0]
                        }
                    };
                    if (parts[1]) {
                        var _states = parts[1].split(',');
                        // adapter.log.info('LausiD  "' + obj._id  + ' : ' + _states + '"');
                        // obj.common.states = JSON.stringify(_states);
                        obj.common.states = '';

                        if (parseFloat(_states[0]) == _states[0]) {
                            obj.common.type = 'number';
                        }
                    }

                    obj.common.type = obj.common.type || 'string';
                    obj.common.role = 'command';
                    // edit 08.03.17 LausiD
                    // detect pct,Volume,GroupVolume,brightness
                    if (parts[0] === 'pct' || parts[0] === 'Volume' || parts[0] === 'GroupVolume' || parts[0] === 'brightness') {
                        // obj.common.write = true;
                        // obj.common.unit= '%';
                        obj.common.type = 'number';
                        obj.common.min = '0';
                        obj.common.max = '100';
                        obj.common.role = 'command.dim.100';
                    }
                    // detect bri,sat
                    if (parts[0] === 'bri' || parts[0] === 'sat') {
                        // obj.common.write = true;
                        // obj.common.unit = '%';
                        obj.common.type = 'number';
                        obj.common.min = '0';
                        obj.common.max = '254';
                        obj.common.role = 'command.dim.254';
                    }


                    if (parts[0].indexOf('RGB') !== -1) {
                        obj.common.role = 'light.color.rgb';
                        obj.native.rgb = true;
                    }
                    if (parts[0].indexOf('HSV') !== -1) {
                        obj.common.role = 'light.color.hsv';
                        obj.native.hsv = true;
                    }
                    objects.push(obj);
                    setStates[stateName] = obj;
                    //console.log('   ' + obj._id + ': ' + (parts[1] || ''));
                }
            }


            /*
             if (objs[i].Attributes[attr]) {
             //          for (var attr in objs[i].Attributes) {
             adapter.log.info('LausiD  '+ attr);


             }
             }
             */

            /*          if (!objs[i].Readings.hasOwnProperty(attr)) continue;
             // ignore some useless states
             if (ignoreStates.indexOf(attr) !== -1) continue;

             var stateName = attr.replace(/\./g, '_');
             id = adapter.namespace + '.' + name + '.' + stateName;
             //adapter.log.info('LausiD  '+ id);
             var combined = false;
             if (setStates[stateName]) {
             combined = true;
             obj = setStates[stateName];
             obj.common.read = true;
             obj.common.unit = getUnit(attr);
             } else {
             obj = {
             _id: id,
             type: 'state',
             common: {
             name: objs[i].Name + ' ' + attr,
             read: true,
             write: false,
             unit: getUnit(attr)
             },
             native: {
             Name: objs[i].Name,
             Attribute: attr
             }
             };
             }  */


            if (objs[i].Readings) {
                for (var attr in objs[i].Readings) {
                    if (!objs[i].Readings.hasOwnProperty(attr)) continue;
                    // ignore some useless states
                    if (ignoreStates.indexOf(attr) !== -1) continue;

                    var stateName = attr.replace(/\./g, '_');
                    id = adapter.namespace + '.' + name + '.' + stateName;
                    var combined = false;
                    if (setStates[stateName]) {
                        combined = true;
                        obj = setStates[stateName];
                        obj.common.read = true;
                        obj.common.unit = getUnit(attr);
                    } else {
                        obj = {
                            _id: id,
                            type: 'state',
                            common: {
                                name: objs[i].Name + ' ' + attr,
                                read: true,
                                write: false,
                                unit: getUnit(attr)
                            },
                            native: {
                                Name: objs[i].Name,
                                Attribute: attr
                            }
                        };
                    }

                    if (objs[i].Readings[attr]) {
                        var val = convertFhemValue(objs[i].Readings[attr].Value);
                        obj.common.type = obj.common.type || typeof val;
                        obj.common.role = obj.common.role || 'value';

                        states.push({
                            id: obj._id,
                            val: val,
                            ts: objs[i].Readings[attr].Time ? new Date(objs[i].Readings[attr].Time).getTime() : new Date().getTime(),
                            ack: true
                        });

                        // detect pct
                        if (attr === 'pct' || attr === 'Volume' || attr === 'GroupVolume' || attr === 'brightness') {
                            obj.common.unit = '%';
                        }
                        // detect bri,sat
                        if (attr === 'bri' || attr === 'sat') {
                            obj.common.unit = '%';
                        }

                        // detect state
                        if (attr === 'state') {
                            obj.common.write = true;
                            obj.native.onoff = true;
                            obj.common.role = 'switch';
                        }
                        // detect on/off state
                        if (isOff && isOn && attr === 'state') {
                            obj.common.write = true;
                            obj.native.onoff = true;
                            obj.common.role = 'switch';
                        }

                        if (!combined) objects.push(obj);
                    }
                }
                delete objs[i].Readings;
            }
            setStates = null;

            /*id = adapter.namespace + '.' + name + '.lastError';
             obj = {
             _id:  id,
             type: 'state',
             common: {
             name:   objs[i].Name + ' lastError',
             read:   true,
             write:  false,
             def:    '',
             type:   'string',
             role:   'error'
             },
             native: objs[i]
             };
             objects.push(obj);*/

            /*id = adapter.namespace + '.' + objs[i].Name + '.validity';
             obj = {
             _id:  id,
             type: 'state',
             common: {
             name:   objs[i].Name + ' validity',
             read:   true,
             write:  false,
             def:    '',
             type:   'string',
             role:   'state.quality'
             },
             native: objs[i]
             };
             objects.push(obj);*/

        } catch (err) {
            adapter.log.error('Cannot process object: ' + JSON.stringify(objs[i]));
            adapter.log.error('Cannot process object: ' + err);
        }
    }

    syncObjects(objects, function () {
        syncRooms(rooms, function () {
            syncStates(states, cb);
        });
    });
}

function readValue(id, cb) {
    telnetOut.send('get ' + hassObjects[id].native.Name + ' ' + hassObjects[id].native.Attribute, function (err, result) {
        if (err) adapter.log.error('readValue: ' + err);
        // MeinWetter city => Berlin
        if (result) {
            result = convertFhemValue(result.substring(hassObjects[id].native.Name.length + hassObjects[id].native.Attribute + 5));
            if (result !== '') {
                adapter.setForeignState(id, result, true);
            }
        }

        if (cb) cb();
    });
}

function writeValue(id, val, cb) {
    var cmd;
    var val_org = val;
    if (val === undefined || val === null) val = '';
    // edit LausiD 05.03.17
    // May be RGB
    if (hassObjects[id].native.Attribute === 'rgb') val = val.substring(1);

    //    if (typeof val === 'string' && val[0] === '#' && val.length > 3) val = val.substring(1);
    //    if (hassObjects[id].native.rgb) {
    //            }

    if (hassObjects[id].native.Attribute === 'state') {
        if (val === '1' || val === 1 || val === 'on' || val === 'true' || val === true) val = 'on';
        if (val === '0' || val === 0 || val === 'off' || val === 'false' || val === false) val = 'off';
        cmd = 'set ' + hassObjects[id].native.Name + ' ' + val;
        // adapter.log.info(adapter.namespace + '.' + hassObjects[id].native.Name + '.' + hassObjects[id].native.Attribute + '.' + val_org + ' ==> ' + cmd);
    }
    else {
        cmd = 'set ' + hassObjects[id].native.Name + ' ' + hassObjects[id].native.Attribute + ' ' + val;
    }
    adapter.log.info(adapter.namespace + '.' + hassObjects[id].native.Name + '.' + hassObjects[id].native.Attribute + '.' + val_org + ' ==> writeFHEM: ' + cmd);
    // edit end LausiD 05.03.17

    telnetOut.send(cmd, function (err, result) {
        if (err) adapter.log.error('writeValue: ' + err);
        if (cb) cb();
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

        var name = entity.attributes && entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id;
        var desc = entity.attributes && entity.attributes.attribution   ? entity.attributes.attribution   : undefined;

        channel = {
            _id: adapter.namespace  + '.entities.' + entity.entity_id,
            common: {
                name: name
            },
            type: 'channel',
            native: {
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
                    entity_id: entity.entity_id
                }
            };
            objs.push(obj);
            states.push({id: obj._id, lc: lc, ts: ts, val: entity.state, ack: true})
        }

        if (entity.attributes) {
            for (var attr in entity.attributes) {
                if (entity.attributes.hasOwnProperty(attr)) {
                    if (attr === 'friendly_name') continue;

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
                            entity_id: entity.entity_id,
                            attr: attr
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
                            desc: service.description,
                            read: false,
                            write: true
                        },
                        native: {
                            field: service.fields,
                            entity_id: entity.entity_id,
                            attr: s,
                            type: serviceType
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

    /*const ssocket = new WebSocket('ws://' + adapter.config.host + ':' + adapter.config.port + '/api/websocket');
    ssocket.addEventListener('message', function (msg) {
        console.log(JSON.stringify(msg.a));
    });
    ssocket.addEventListener('close', function () {
        console.log('Closed');
    });
    ssocket.addEventListener('error', function (err) {
        console.error(err);
    });

    hass.createConnection('ws://' + adapter.config.host + ':' + adapter.config.port + '/api/websocket').then(function (conn) {
        if (!connected) {
            adapter.log.debug('Connected');
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        socket = conn;
        hass.subscribeEntities(conn, function (entities) {
            console.log('New entities!', entities);
            var attrs = Object.keys(entities);
            for (var a = 0; a < attrs.length; a++) {
                console.log(attrs[a] + ': ' + entities[attrs[a]].state);
            }
        });
        hass.subscribeConfig(conn, function (config) {
            console.log('New config!', config)
        });
        conn.addEventListener('ready', function () {
            if (!connected) {
                adapter.log.debug('Connected');
                connected = true;
                adapter.setState('info.connection', true, true);
            }
        });
        conn.addEventListener('disconnected', function () {
            if (connected) {
                adapter.log.debug('Disconnected');
                connected = false;
                adapter.setState('info.connection', false, true);
            }
        });

        conn.getStates(function (states) {
            console.log('getStates: ', states)
        });

    }).catch(function (err) {
        if (err === 2) {
            adapter.log.error('Invalid password!.');
        } else {
            adapter.log.error('Connection failed with code', ERRORS[err] || err);
        }
        socket = null;

        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });*/
}
