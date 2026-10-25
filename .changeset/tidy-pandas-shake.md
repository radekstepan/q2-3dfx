---
"@q2/filesystem": minor
"@q2/formats": minor
---

PAK + PCX + WAL (M1.2): PAK directory parse with case-insensitive slash-normalised `readPakFile`/`PakFile`; WAL 4-mip decode; PCX RLE decode with trailing-palette handling; `buildColormap` fallback generator (reverse-engineered from id's colormap.pcx, 86.95% byte agreement) plus `extractColormap`; SP2 and WAV-header parsers.
