---
'web': patch
---

Per-name pak wav decode for live mixer channels (M7.2 follow-up).

`syncMixerToBrowser` no longer plays one preloaded shot for every
weapon-ish channel: each new channel resolves its OWN named pak wav
(`weapons/blastf1a.wav`, `weapons/shotgf1b.wav`, …) via
`findPakSoundEntry` (tries the name as-is, then under `sound/`), decodes it
lazily on first use, and caches the AudioBuffer by entry name (capped at
`MAX_CACHED_SOUNDS = 24`, oldest-first eviction, one in-flight decode per
name). While a decode runs — or when the pak lacks the name (doors, buttons,
pickups, pain/death, melee, generic monster fire) — the channel falls back
to the previous behaviour: preloaded shot buffer for weapon-ish names, synth
blip otherwise. Mixer-driven gains/pans are untouched, everything stays
behind the existing browser guards, and `decodeWav`/`createBrowserMixer`
still come from `@q2/sound` (no `packages/*` changes).

Tests: new `sound.test.ts` covers resolution, cache cap/eviction/recency,
decode success/failure, cache-hit/miss/fallback paths through
`syncMixerToBrowser` with a stub AudioContext, plus a Q2_PAK-gated check
that exact weapon wavs resolve and generic driver names stay on fallback.
