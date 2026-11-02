# `public/demo/` — optional same-origin shareware demo mirror

The landing's **Play shareware demo** button tries these URLs in order
(see `src/demo.ts` `DEMO_EXE_URLS`):

1. `/demo/q2-314-demo-x86.exe` (this directory — CORS-free when present)
2. `https://deponie.yamagi.org/quake2/idstuff/q2-314-demo-x86.exe`
3. `http://tastyspleen.net/quake/downloads/q2-314-demo-x86.exe`

To enable (1), drop the **unmodified** original demo archive here:

```
cp ~/downloads/q2-314-demo-x86.exe public/demo/
```

Expected identity (`src/demo.ts` verifies it in-browser before unpacking):

- size `39015499`, SHA-256 `7ace5a43…89b4a04a1e`
- the page extracts `Install/Data/baseq2/pak0.pak` (SHA-256 `cae25718…408b48d09`)
  locally — nothing is uploaded, nothing here is committed.

Do NOT commit the `.exe` (git-ignored) and never commit an extracted
`pak0.pak` (id data, `*.pak` is git-ignored repo-wide).
