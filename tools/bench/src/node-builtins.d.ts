// Minimal ambient declaration for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'child_process' {
  export function execSync(cmd: string, opts?: { encoding?: string }): string;
}

interface BenchBuffer extends Uint8Array {
  subarray(begin?: number, end?: number): BenchBuffer;
  toString(encoding?: string): string;
  readUInt32LE(offset: number): number;
}

declare module 'node:fs' {
  export function readFileSync(path: string): BenchBuffer;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function copyFileSync(src: string, dst: string): void;
  export function mkdirSync(path: string, opts?: { recursive: boolean }): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { size: number; mtimeMs: number; mtime: Date; isDirectory(): boolean };
  export function readdirSync(path: string): string[];
}

declare module 'node:os' {
  export function loadavg(): number[];
  export function cpus(): Array<{ model: string }>;
  export function totalmem(): number;
  export function freemem(): number;
  export function platform(): string;
  export function arch(): string;
  export function release(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:module' {
  export function createRequire(id: string): {
    (id: string): string;
    resolve(id: string): string;
  };
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
