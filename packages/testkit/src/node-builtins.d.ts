// Minimal ambient declarations for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readFileSync(path: string): Uint8Array;
}
declare module 'path' {
  export function join(...parts: string[]): string;
}
declare module 'os' {
  export function platform(): string;
  export function arch(): string;
  export function cpus(): Array<{ model: string }>;
}
