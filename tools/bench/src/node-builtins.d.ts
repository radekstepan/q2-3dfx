// Minimal ambient declaration for Node builtins (tsconfig uses
// `"types": []`, so @types/node is intentionally off in this repo).
declare module 'child_process' {
  export function execSync(cmd: string, opts?: { encoding?: string }): string;
}
