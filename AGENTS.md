# AGENTS.md

Procedural wilderness map generator (Red Blob Games). TypeScript bundled with esbuild; runs in the browser via `embed.html`. No test/lint/typecheck scripts at the root.

## Build & run

`esbuild` is **not** in `package.json` — install it globally first:

```sh
npm install -g esbuild
npm install        # or pnpm install
./build.sh
python3 -m http.server 8000   # then open http://localhost:8000/embed.html
```

`build.sh` runs three steps in order:
1. Bundle `generate-points-file.ts` and execute it with node to write `build/points-${param.spacing}.data` (precomputed Poisson-disc seed points).
2. Bundle `mapgen4.ts` → `build/_bundle.js` (loaded by `embed.html`).
3. Bundle `worker.ts` → `build/_worker.js`.

`mesh.ts` fetches `build/points-${spacing}.data` at runtime via `fetch()`, so a static server is required (`file://` won't work) and the precompute step must succeed before the app loads. `build/` is gitignored — always re-run `./build.sh` after a clean checkout. There is no `index.html` (gitignored); use `embed.html`.

## Type checking

esbuild does **not** typecheck — it strips types. `tsconfig.json` is IDE-only (`allowImportingTsExtensions: true`). Don't expect `tsc` or a typecheck script at the root; the build will succeed with type errors. Verify types in an editor if it matters.

## Architecture

- `mapgen4.ts` — entry point; UI, sliders, dispatches painting.
- `mesh.ts` — builds the Delaunay/Voronoi dual mesh; fetches the precomputed points file.
- `map.ts` — map generation algorithms (elevation, biomes, rivers).
- `painting.ts` — user painting input.
- `render.ts` — WebGL2 renderer (raw WebGL2, **not** regl; uses VAOs, R16F textures, `gl_VertexID`).
- `worker.ts` — web worker running map calculations off the main thread; results sent via `postMessage`.
- `geometry.ts` — calculations shared between worker and renderer.
- `config.js` — shared tunable parameters. `spacing` (default `5.5`) sets mesh resolution; ~`0.7` yields 1M+ cells (rendering is tuned for ~25k cells). Changing `spacing` requires re-running `./build.sh` to regenerate the points file.
- `generate-points.ts` / `generate-points-file.ts` / `serialize-points.ts` — point precomputation and serialization.
- `types.d.ts` — augments `TriangleMesh` with `is_boundary_t` and `length_s`.

## dual-mesh/ subpackage

`@redblobgames/dual-mesh` is a git subrepo (separate `package.json`/`tsconfig.json`, committed `dist/`). Tests:

```sh
cd dual-mesh && node tests.js     # rebuild dist with: npm run dist  (runs tsc)
```

Naming convention is **output-from-input**: `x_name_y` takes input of type `y` (`r`=region, `s`=side, `t`=triangle) and returns type `x`. E.g. `r_begin_s(s)` returns a region from a side.

## Conventions

- ESM (`"type": "module"`); imports use explicit `.ts` extensions — keep them.
- Preview requires a WebGL2-capable browser.
