import { EventEmitter } from 'node:events'

export class Client extends EventEmitter {
    connect(): void {
        throw new Error('SSH Docker hosts are not supported in this bundled action build.')
    }

    end(): void {
        // No-op for shim implementation.
    }
}
