// Minimal ambient declarations for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
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
}
declare module 'os' {
  export function platform(): string;
  export function arch(): string;
  export function cpus(): Array<{ model: string }>;
  export function loadavg(): number[];
}
declare module 'child_process' {
  export function execSync(cmd: string, opts?: { encoding?: string }): string;
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
