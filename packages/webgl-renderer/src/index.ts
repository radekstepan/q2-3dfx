// @q2/webgl-renderer — WebGL2 backend, GPU-PROOF-2 boundary (scene selection +
// capability report + renderer resource ownership). No scene drawing yet:
// renderFrame proves context/target ownership with a clear; real scene
// buffers land in PROOF-3, Voodoo appearance in PROOF-4 (see README.md).
export * from './scene.js';
export * from './capability.js';
export * from './renderer.js';
