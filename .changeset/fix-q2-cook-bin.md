---
"asset-cooker": patch
---

Fix `yarn cook`: expose the `q2-cook` binary (`dist/cli.js` via `bin`, linked through a root devDependency) so `yarn cook <in.pak> [out.q2pkg]` works. CLI moved out of the library entry into `src/cli.ts`; output defaults to `<in>` with the extension swapped to `.q2pkg`. Also copies file bytes out of the Node Buffer pool before parsing.
