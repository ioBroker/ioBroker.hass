"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const ws_1 = __importDefault(require("ws"));
/*
const ERRORS: Record<number, string> = {
    1: 'ERR_CANNOT_CONNECT',
    2: 'ERR_INVALID_AUTH',
    3: 'ERR_CONNECTION_LOST',
};
*/
class HASS extends node_events_1.EventEmitter {
    socket = null;
    options;
    log;
    currentId = 1;
    requests = {};
    _connected = false;
    connectTimeout = null;
    closed = false;
    constructor(options, log) {
        super();
        this.options = {
            host: options.host || '127.0.0.1',
            port: parseInt(String(options.port), 10) || 8123,
            password: options.password,
            secure: options.secure,
        };
        this.log = log;
    }
    subscribeEvents(socket, callback) {
        if (socket && typeof socket.send === 'function') {
            const id = this.currentId++;
            this.requests[id] = { type: 'subscribe_events', ts: Date.now(), cb: callback };
            socket.send(JSON.stringify({
                id,
                type: 'subscribe_events',
            }));
        }
        else {
            callback?.('not connected');
        }
    }
    sendCommand(socket, type, callback, extra) {
        if (socket && typeof socket.send === 'function') {
            const id = this.currentId++;
            this.requests[id] = { type, cb: callback, ts: Date.now() };
            socket.send(JSON.stringify({
                id,
                type,
                ...extra,
            }));
        }
        else {
            callback?.('not connected');
        }
    }
    sendAuth(socket, pass) {
        if (socket && typeof socket.send === 'function') {
            socket.send(JSON.stringify({
                type: 'auth',
                access_token: pass,
            }));
        }
    }
    initSocket(socket) {
        socket.on('message', (msg) => {
            const msgStr = msg.toString();
            this.log.silly(msgStr);
            const response = JSON.parse(msgStr);
            if (response.type === 'event') {
                if (response.event?.data && response.event.event_type === 'system_log_event') {
                    if (response.event.data.level === 'WARNING') {
                        this.log.warn(`EVENT: ${response.event.data.message}`);
                    }
                    else if (response.event.data.level === 'ERROR') {
                        this.log.error(`EVENT: ${response.event.data.message}`);
                    }
                    else {
                        this.log.debug(`EVENT: ${response.event.data.message}`);
                    }
                }
                else if (response.event?.event_type === 'state_changed') {
                    this.emit('state_changed', response.event.data.new_state);
                }
            }
            else if (response.type === 'auth_required') {
                if (!this.options.password) {
                    this.emit('error', 'Password required. Connection closed');
                    socket.terminate();
                }
                else {
                    setTimeout(() => this.sendAuth(socket, this.options.password), 50);
                }
            }
            else if (response.type === 'auth_ok') {
                setImmediate(() => this.subscribeEvents(socket, err => {
                    if (!err) {
                        this._connected = true;
                        this.emit('connected');
                    }
                }));
            }
            else if (response.id === undefined) {
                this.log.error(`Invalid answer: ${msgStr}`);
            }
            else {
                if (response.type === 'result' && this.requests[response.id]) {
                    this.log.debug(`got answer for ${this.requests[response.id].type} success = ${response.success}, result = ${JSON.stringify(response.result)}`);
                    if (typeof this.requests[response.id].cb === 'function') {
                        this.requests[response.id].cb(!response.success, response.result);
                        delete this.requests[response.id];
                    }
                }
            }
        });
        socket.on('error', (err) => {
            this.socket = null;
            if (err?.message?.indexOf('RSV2 and RSV3 must be clear') !== -1) {
                // ignore deflate error
            }
            else {
                this.log.error(err.toString());
            }
        });
        socket.on('open', () => {
            // connection opened
        });
        socket.on('close', () => {
            this.socket = null;
            if (this._connected) {
                this._connected = false;
                this.emit('disconnected');
            }
            if (!this.connectTimeout && !this.closed) {
                this.connectTimeout = setTimeout(() => {
                    this.connectTimeout = null;
                    this.connect();
                }, 3000);
            }
        });
    }
    isConnected() {
        return this._connected;
    }
    getConfig(callback) {
        if (!this._connected) {
            callback('not connected');
        }
        else {
            this.sendCommand(this.socket, 'get_config', callback);
        }
    }
    getStates(callback) {
        if (!this._connected) {
            callback('not connected');
        }
        else {
            this.sendCommand(this.socket, 'get_states', callback);
        }
    }
    getServices(callback) {
        if (!this._connected) {
            callback('not connected');
        }
        else {
            this.sendCommand(this.socket, 'get_services', callback);
        }
    }
    getPanels(callback) {
        if (!this._connected) {
            callback('not connected');
        }
        else {
            this.sendCommand(this.socket, 'get_panels', callback);
        }
    }
    callService(service, domain, serviceData, target, callback) {
        if (!this._connected) {
            callback('not connected');
        }
        else {
            this.sendCommand(this.socket, 'call_service', callback, {
                domain: domain || '',
                service,
                service_data: serviceData,
                target,
            });
        }
    }
    connect() {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        this.socket = new ws_1.default(`ws${this.options.secure ? 's' : ''}://${this.options.host}:${this.options.port}/api/websocket`, { perMessageDeflate: false });
        this.initSocket(this.socket);
    }
    close() {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        this.closed = true;
        if (this.socket) {
            this.socket.close();
        }
    }
}
exports.default = HASS;
//# sourceMappingURL=hass.js.map