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
  export function existsSync(path: string): boolean;
}

declare module 'node:module' {
  export function createRequire(id: string): {
    (id: string): string;
    resolve(id: string): string;
  };
}
