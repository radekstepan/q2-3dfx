// Minimal WebAssembly ambient declarations for @q2/sw-renderer.
// The package tsconfig lib is ["ES2022"] (no DOM), so the global
// WebAssembly namespace types are unavailable. This file only declares the
// small surface the WASM span backend uses (BRAIN.md §5 allows ambient
// declarations; no hand-written .d.ts beyond this).
declare namespace WebAssembly {
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  var Memory: {
    new (descriptor: MemoryDescriptor): Memory;
  };
  interface Module {
    readonly __brand: 'wasm-module';
  }
  var Module: {
    new (bytes: Uint8Array): Module;
  };
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  var Instance: {
    new (module: Module, importObject?: Record<string, Record<string, unknown>>): Instance;
  };
}
