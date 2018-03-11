var util            = require('util');
var EventEmitter    = require('events').EventEmitter;
var WebSocket       = require('ws');

function HASS(options, log) {
    if (!(this instanceof HASS)) return new HASS(options);

    options = options || {};
    options.host = options.host || '127.0.0.1';
    options.port = parseInt(options.port, 10) || 8123;

    var ERRORS = {
        1: 'ERR_CANNOT_CONNECT',
        2: 'ERR_INVALID_AUTH',
        3: 'ERR_CONNECTION_LOST'
    };

    this.socket = null;
    var that = this;
    var currentId = 1;
    var requests = {};
    var connected;
    var connectTimeout = null;

    function subscribeEvents(socket, callback) {
        if (socket && typeof socket.send === 'function') {
            var id = currentId++;
            requests[id] = {type: 'subscribe_events', ts: Date.now(), cb: callback};

            socket.send(JSON.stringify({
                id: id,
                type: 'subscribe_events'
                /*event_type: 'state_changed'*/
            }));
        } else {
            callback && callback('not connected');
        }
    }

    function getConfig(socket, callback) {
        if (socket && typeof socket.send === 'function') {
            var id = currentId++;
            requests[id] = {type: 'get_config', cb: callback, ts: Date.now()};
            socket.send(JSON.stringify({
                id: id,
                type: 'get_config'
            }));
        } else {
            callback && callback('not connected');
        }
    }

    function getStates(socket, callback) {
        if (socket && typeof socket.send === 'function') {
            var id = currentId++;
            requests[id] = {type: 'get_states', cb: callback, ts: Date.now()};
            socket.send(JSON.stringify({
                id: id,
                type: 'get_states'
            }));
        } else {
            callback && callback('not connected');
        }
    }

    function getServices(socket, callback) {
        if (socket && typeof socket.send === 'function') {
            var id = currentId++;
            requests[id] = {type: 'get_services', cb: callback, ts: Date.now()};
            socket.send(JSON.stringify({
                id: id,
                type: 'get_services'
            }));
        } else {
            callback && callback('not connected');
        }
    }

    function callService(socket, service, domain, serviceData, callback) {
        if (socket && typeof socket.send === 'function') {
            var id = currentId++;
            requests[id] = {type: 'call_service', cb: callback, ts: Date.now()};
            socket.send(JSON.stringify({
                id: id,
                type: 'call_service',
                domain: domain || '',
                service: service,
                service_data: serviceData
            }));
        } else {
            callback && callback('not connected');
        }
    }

    function sendAuth(socket, pass) {
        if (socket && typeof socket.send === 'function') {
            socket.send(JSON.stringify({
                type: 'auth',
                api_password: pass
            }));
        }
    }

    function initSocket(socket) {
        socket.on('message', function (msg) {
            log.silly(msg);

            var response = JSON.parse(msg);
            if (response.type === 'event') {
                if (response.event.data && response.event.event_type === 'system_log_event') {
                    if (response.event.data.level === 'WARNING') {
                        log.warn('EVENT: ' + response.event.data.message);
                    } else
                    if (response.event.data.level === 'ERROR') {
                        log.error('EVENT: ' + response.event.data.message);
                    }  else {
                        log.debug('EVENT: ' + response.event.data.message);
                    }
                } else if (response.event && response.event.event_type === 'state_changed') {
                    that.emit('state_changed', response.event.data.new_state);
                }
            } else
            if (response.type === 'auth_required') {
                if (!options.password) {
                    that.emit('error', 'Password required. Connection closed');
                    socket.terminate();
                } else {
                    setTimeout(function () {
                        sendAuth(socket, options.password);
                    }, 50);
                }
            } else
            if (response.type === 'auth_ok') {
                setImmediate(function () {
                    subscribeEvents(socket, function (err) {
                        if (!err) {
                            connected = true;
                            that.emit('connected');
                        }
                    });
                });
            } else if (response.id === undefined) {
                log.error('Invalid answer: ' + msg);
            } else {
                if (response.type === 'result' && requests[response.id]) {
                    log.debug('got answer for ' + requests[response.id].type);
                    if (typeof requests[response.id].cb === 'function') {
                        requests[response.id].cb(!response.success, response.result);
                        delete requests[response.id];
                    }
                }
            }
        });

        socket.on('error', function (err) {
            socket = null;
            if (err && err.message.indexOf('RSV2 and RSV3 must be clear') !== -1) {
                // ignore deflate error
            } else {
                log.error(err);
            }
        });
        socket.on('open', function () {
            if (!connected) {

            }
        });
        socket.on('close', function () {
            that.socket = null;
            if (connected) {
                connected = false;
                that.emit('disconnected');

            }
            if (!connectTimeout) {
                setTimeout(function () {
                    connectTimeout = null;
                    that.connect();
                }, 3000);
            }
        });
    }

    this.isConnected = function () {
        return connected;
    };

    this.getConfig = function (callback) {
        if (!connected) {
            if (typeof callback === 'function') {
                callback('not connected');
            }
        } else {
            getConfig(this.socket, callback);
        }
    };

    this.getStates = function (callback) {
        if (!connected) {
            if (typeof callback === 'function') {
                callback('not connected');
            }
        } else {
            getStates(this.socket, callback);
        }
    };

    this.getServices = function (callback) {
        if (!connected) {
            if (typeof callback === 'function') {
                callback('not connected');
            }
        } else {
            getServices(this.socket, callback);
        }
    };

    this.callService = function (service, domain, serviceData, callback) {
        if (!connected) {
            if (typeof callback === 'function') {
                callback('not connected');
            }
        } else {
            callService(this.socket, service, domain, serviceData, callback);
        }
    };

    this.connect = function () {
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }

        this.socket = new WebSocket('ws' + (options.secure ? 's' : '') + '://' + options.host + ':' + options.port + '/api/websocket', {
            perMessageDeflate: false
        });

        initSocket(this.socket);
    };

    return this;
}

// extend the EventEmitter class using our class
util.inherits(HASS, EventEmitter);

module.exports = HASS;