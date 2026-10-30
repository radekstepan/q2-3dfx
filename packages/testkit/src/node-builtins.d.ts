// Minimal ambient declarations for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export interface FsStat {
    size: number;
    mtimeMs: number;
    isDirectory(): boolean;
  }
  export function statSync(path: string): FsStat;
  export function readdirSync(path: string): string[];
}
declare module 'zlib' {
  export function inflateSync(data: Uint8Array): Uint8Array;
}
declare module 'path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export const sep: string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export const sep: string;
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
declare module 'os' {
  export function platform(): string;
  export function arch(): string;
  export function cpus(): Array<{ model: string }>;
  export function loadavg(): number[];
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function accessSync(path: string, mode?: number): void;
  export function readdirSync(path: string): string[];
  export const constants: { X_OK: number };
}
declare module 'node:http' {
  export interface IncomingMessage {
    url?: string;
    method?: string;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(data?: Uint8Array | string): void;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): void;
    close(cb?: () => void): void;
    address(): { port: number } | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}
declare module 'child_process' {
  export function execSync(cmd: string, opts?: { encoding?: string }): string;
}
declare module 'node:child_process' {
  export interface ChildProcess {
    pid?: number;
    stdout: null;
    stderr: { on(event: 'data', listener: (chunk: Uint8Array) => void): void } | null;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
    kill(signal?: string): boolean;
  }
  export function spawn(
    command: string,
    args: string[],
    opts?: { stdio?: Array<string | null> },
  ): ChildProcess;
}
declare module 'node:module' {
  export function createRequire(id: string): {
    (id: string): unknown;
    resolve(id: string): string;
  };
}
declare module 'node:worker_threads' {
  export interface WorkerOptions {
    eval?: boolean;
    workerData?: unknown;
  }
  export class Worker {
    constructor(filename: string | URL, options?: WorkerOptions);
    once(event: 'message', listener: (value: unknown) => void): this;
    once(event: 'error', listener: (err: unknown) => void): this;
    terminate(): Promise<number>;
  }
}
