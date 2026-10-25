// Ambient Node access for tests only (BRAIN.md §3/§10.3). tsconfig sets
// `"types": []`, so @types/node is off; shipped code stays platform-free and
// never imports these. Keep this file import-free so it stays ambient.
declare const process: {
  env: Record<string, string | undefined>;
};
declare module 'fs' {
  export function readFileSync(path: string): Uint8Array;
}
