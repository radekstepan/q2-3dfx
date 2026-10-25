// Minimal ambient declarations for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'fs' {
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readFileSync(path: string): Uint8Array;
}
declare module 'zlib' {
  export function deflateSync(data: Uint8Array): Uint8Array;
  export function inflateSync(data: Uint8Array): Uint8Array;
}
