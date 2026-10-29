// Local ambient for the `process` global (tsconfig uses `"types": []`,
// so @types/node globals are off; explicit `node:*` imports still resolve).
declare const process: {
  argv: string[];
  version: string;
  env: Record<string, string | undefined>;
  cwd(): string;
  hrtime: {
    (time?: [number, number]): [number, number];
    bigint(): bigint;
  };
  memoryUsage(): { heapUsed: number; rss: number };
  exit(code?: number): never;
};
