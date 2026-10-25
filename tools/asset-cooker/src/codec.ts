// q2-cook codec: deflate/inflate via node:zlib, lazy so tests can stub.
export async function createDeflate(data: Uint8Array): Promise<Uint8Array> {
  const zlib = await import('zlib');
  return zlib.deflateSync(data);
}

export async function createInflate(data: Uint8Array): Promise<Uint8Array> {
  const zlib = await import('zlib');
  return Uint8Array.from(zlib.inflateSync(data));
}
