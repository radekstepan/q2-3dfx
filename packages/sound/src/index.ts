// @q2/sound — WebAudio mixer, 3D attenuation. M6.1 owns this.
export function attenuation(dist: number): number { return 1 / (1 + dist * 0.01); }
