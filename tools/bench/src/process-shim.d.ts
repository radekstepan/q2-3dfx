// Local ambient for the `process` global (tsconfig uses `"types": []`,
// so @types/node globals are off; explicit `node:*` imports still resolve).
declare const process: {
  argv: string[];
  version: string;
  exit(code?: number): never;
};
