// Type stubs for @grpc/grpc-js (optional dependency)
// This file allows TypeScript to compile without @grpc/grpc-js installed

declare module '@grpc/grpc-js' {
    export class Client {
        constructor(address: string, credentials: any, options?: any);
        makeBidiStreamRequest(path: string, serialize: any, deserialize: any): any;
        close(): void;
    }
    
    export namespace credentials {
        function createInsecure(): any;
    }
    
    export interface ClientDuplexStream<T, U> {
        write(data: T): void;
        end(): void;
        on(event: string, handler: (data: any) => void): void;
    }
}
