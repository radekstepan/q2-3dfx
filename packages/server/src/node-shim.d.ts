// Ambient Node access for asset-gated tests only (BRAIN.md §3).
declare const process: {
  env: Record<string, string | undefined>;
};
declare module 'fs' {
  export function readFileSync(path: string): Uint8Array;
}
