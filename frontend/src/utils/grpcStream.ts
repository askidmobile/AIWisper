// Простой gRPC-клиент поверх Unix domain socket / named pipe, эмулирующий WebSocket API.
// Используем json-кодек на сервере, поэтому сериализуем объекты в/из JSON.

const grpc: typeof import('@grpc/grpc-js') = require('@grpc/grpc-js');

export const RPC_READY_STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
} as const;

export interface RpcSocketLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: ((event?: any) => void) | null;
    onerror: ((err: any) => void) | null;
}

const pathStream = '/aiwisper.Control/Stream';
const serialize = (value: any) => Buffer.from(JSON.stringify(value));
const deserialize = (value: Buffer) => JSON.parse(value.toString('utf8'));

function resolveAddress(): string {
    const envAddr = typeof process !== 'undefined' ? process.env.AIWISPER_GRPC_ADDR : undefined;
    if (envAddr && envAddr.trim().length > 0) {
        return envAddr;
    }
    if (typeof process !== 'undefined' && process.platform === 'win32') {
        return 'npipe:\\\\.\\pipe\\aiwisper-grpc';
    }
    return 'unix:///tmp/aiwisper-grpc.sock';
}

class GrpcSocket implements RpcSocketLike {
    public readyState = RPC_READY_STATE.CONNECTING;
    public onopen: (() => void) | null = null;
    public onmessage: ((event: { data: string }) => void) | null = null;
    public onclose: ((event?: any) => void) | null = null;
    public onerror: ((err: any) => void) | null = null;

    private client: import('@grpc/grpc-js').Client | null = null;
    private call: import('@grpc/grpc-js').ClientDuplexStream<any, any> | null = null;
    private readonly address: string;

    constructor(address?: string) {
        this.address = address || resolveAddress();
        this.connect();
    }

    private connect() {
        this.client = new grpc.Client(this.address, grpc.credentials.createInsecure(), {
            'grpc.max_receive_message_length': -1,
            'grpc.max_send_message_length': -1,
        });

        this.call = this.client.makeBidiStreamRequest(
            pathStream,
            serialize,
            deserialize,
        );

        this.readyState = RPC_READY_STATE.OPEN;
        setTimeout(() => {
            this.onopen?.();
        }, 0);

        this.call.on('data', (msg: any) => {
            const payload = JSON.stringify(msg);
            this.onmessage?.({ data: payload });
        });

        this.call.on('end', () => {
            this.readyState = RPC_READY_STATE.CLOSED;
            this.onclose?.();
        });

        this.call.on('error', (err: any) => {
            this.readyState = RPC_READY_STATE.CLOSED;
            this.onerror?.(err);
            this.onclose?.(err);
        });
    }

    send(data: string) {
        if (this.readyState !== RPC_READY_STATE.OPEN || !this.call) {
            throw new Error('gRPC not connected');
        }
        let payload: any = {};
        try {
            payload = JSON.parse(data);
        } catch {
            payload = { raw: data };
        }
        this.call.write(payload);
    }

    close() {
        this.readyState = RPC_READY_STATE.CLOSING;
        if (this.call) {
            this.call.end();
        }
        if (this.client) {
            this.client.close();
        }
        this.readyState = RPC_READY_STATE.CLOSED;
    }
}

export function createGrpcSocket(address?: string): RpcSocketLike {
    return new GrpcSocket(address);
}
