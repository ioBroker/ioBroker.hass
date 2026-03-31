import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

interface HassOptions {
    host: string;
    port: number;
    password?: string;
    secure?: boolean;
}

interface HassRequest {
    type: string;
    ts: number;
    cb?: (err: boolean | string | null, result?: any) => void;
}

/*
const ERRORS: Record<number, string> = {
    1: 'ERR_CANNOT_CONNECT',
    2: 'ERR_INVALID_AUTH',
    3: 'ERR_CONNECTION_LOST',
};
*/
export default class HASS extends EventEmitter {
    private socket: WebSocket | null = null;
    private readonly options: HassOptions;
    private readonly log: ioBroker.Logger;
    private currentId: number = 1;
    private readonly requests: Record<number, HassRequest> = {};
    private _connected: boolean = false;
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    private closed: boolean = false;

    constructor(options: HassOptions, log: ioBroker.Logger) {
        super();
        this.options = {
            host: options.host || '127.0.0.1',
            port: parseInt(String(options.port), 10) || 8123,
            password: options.password,
            secure: options.secure,
        };
        this.log = log;
    }

    private subscribeEvents(socket: WebSocket, callback?: (err: boolean | string | null) => void): void {
        if (socket && typeof socket.send === 'function') {
            const id = this.currentId++;
            this.requests[id] = { type: 'subscribe_events', ts: Date.now(), cb: callback };
            socket.send(
                JSON.stringify({
                    id,
                    type: 'subscribe_events',
                }),
            );
        } else {
            callback?.('not connected');
        }
    }

    private sendCommand(
        socket: WebSocket | null,
        type: string,
        callback?: (err: boolean | string | null, result?: any) => void,
        extra?: Record<string, any>,
    ): void {
        if (socket && typeof socket.send === 'function') {
            const id = this.currentId++;
            this.requests[id] = { type, cb: callback, ts: Date.now() };
            socket.send(
                JSON.stringify({
                    id,
                    type,
                    ...extra,
                }),
            );
        } else {
            callback?.('not connected');
        }
    }

    private sendAuth(socket: WebSocket, pass: string): void {
        if (socket && typeof socket.send === 'function') {
            socket.send(
                JSON.stringify({
                    type: 'auth',
                    access_token: pass,
                }),
            );
        }
    }

    private initSocket(socket: WebSocket): void {
        socket.on('message', (msg: WebSocket.Data): void => {
            const msgStr = (msg as Buffer).toString();
            this.log.silly(msgStr);

            const response = JSON.parse(msgStr);
            if (response.type === 'event') {
                if (response.event?.data && response.event.event_type === 'system_log_event') {
                    if (response.event.data.level === 'WARNING') {
                        this.log.warn(`EVENT: ${response.event.data.message}`);
                    } else if (response.event.data.level === 'ERROR') {
                        this.log.error(`EVENT: ${response.event.data.message}`);
                    } else {
                        this.log.debug(`EVENT: ${response.event.data.message}`);
                    }
                } else if (response.event?.event_type === 'state_changed') {
                    this.emit('state_changed', response.event.data.new_state);
                }
            } else if (response.type === 'auth_required') {
                if (!this.options.password) {
                    this.emit('error', 'Password required. Connection closed');
                    socket.terminate();
                } else {
                    setTimeout(() => this.sendAuth(socket, this.options.password!), 50);
                }
            } else if (response.type === 'auth_ok') {
                setImmediate(() =>
                    this.subscribeEvents(socket, err => {
                        if (!err) {
                            this._connected = true;
                            this.emit('connected');
                        }
                    }),
                );
            } else if (response.id === undefined) {
                this.log.error(`Invalid answer: ${msgStr}`);
            } else {
                if (response.type === 'result' && this.requests[response.id]) {
                    this.log.debug(
                        `got answer for ${this.requests[response.id].type} success = ${response.success}, result = ${JSON.stringify(response.result)}`,
                    );
                    if (typeof this.requests[response.id].cb === 'function') {
                        this.requests[response.id].cb!(!response.success, response.result);
                        delete this.requests[response.id];
                    }
                }
            }
        });

        socket.on('error', (err: Error) => {
            this.socket = null;
            if (err?.message?.indexOf('RSV2 and RSV3 must be clear') !== -1) {
                // ignore deflate error
            } else {
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

    isConnected(): boolean {
        return this._connected;
    }

    getConfig(callback: (err: boolean | string | null, result?: any) => void): void {
        if (!this._connected) {
            callback('not connected');
        } else {
            this.sendCommand(this.socket, 'get_config', callback);
        }
    }

    getStates(callback: (err: boolean | string | null, result?: any) => void): void {
        if (!this._connected) {
            callback('not connected');
        } else {
            this.sendCommand(this.socket, 'get_states', callback);
        }
    }

    getServices(callback: (err: boolean | string | null, result?: any) => void): void {
        if (!this._connected) {
            callback('not connected');
        } else {
            this.sendCommand(this.socket, 'get_services', callback);
        }
    }

    getPanels(callback: (err: boolean | string | null, result?: any) => void): void {
        if (!this._connected) {
            callback('not connected');
        } else {
            this.sendCommand(this.socket, 'get_panels', callback);
        }
    }

    callService(
        service: string,
        domain: string,
        serviceData: Record<string, any>,
        target: Record<string, any>,
        callback: (err: boolean | string | null, result?: any) => void,
    ): void {
        if (!this._connected) {
            callback('not connected');
        } else {
            this.sendCommand(this.socket, 'call_service', callback, {
                domain: domain || '',
                service,
                service_data: serviceData,
                target,
            });
        }
    }

    connect(): void {
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }

        this.socket = new WebSocket(
            `ws${this.options.secure ? 's' : ''}://${this.options.host}:${this.options.port}/api/websocket`,
            { perMessageDeflate: false },
        );

        this.initSocket(this.socket);
    }

    close(): void {
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
