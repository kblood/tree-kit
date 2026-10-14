# Tree Kit

Tree Kit is the reusable runtime boundary for tree recipes and presentation:
asset loading, allometry, family ownership, instanced near/middle rendering,
foliage and bark handling, captured far impostors, and resource accounting.
Atlas supplies resolved species traits, lighting and wind inputs. Planet
population, habitat eligibility, terrain, world time, residency and scene
adapters remain in Universe Atlas.

The versioned source entrypoints are `tree-kit/v1/recipes`,
`tree-kit/v1/presentation`, `tree-kit/v1/assets`, `tree-kit/v1/instances`,
`tree-kit/v1/impostors` and `tree-kit/v1/metrics`. Three.js is pinned to the
Atlas-compatible `super-three` 0.181.0 build so Kit and consumer objects share
the same runtime constructors.

## Development

Use Node.js 24 or newer:

```powershell
npm ci
npm test
npm run build
npm run lab:build
npm run lab:dev
```

The lab accepts one or both local family LOD0/LOD1 pairs and optional foliage
mip manifests/payloads. It does not upload or persist selected assets. It uses
the same `ForestTreeFamilyLibrary` path as Atlas, including structural family
variants, bounded near/middle batches and shared bark ownership. The mixed view
shows near LOD0 and middle LOD1 populations together. When valid mip sidecars
are supplied, the lab can bake the production far atlases incrementally and
render far impostors beside the detailed bands. It can toggle bark sharing by
reloading the selected families, switch coverage/transmission settings, and
record CPU/GPU pass and resource diagnostics.

Lab counters include its ground and shadow passes. They are exploratory until
a quiet-host capture compares fixed poses and isolates near, middle and far
contributions. Atlas's fixed-pose browser benchmark remains the release gate
for production runtime attribution.

The standalone test suite covers deterministic math, shader and capture
contracts, instance ownership, texture lease lifetime, API exports and import
boundaries. Asset-specific tests that read Atlas GLBs remain in Atlas while
redistribution rights for the Atlas-authored material and texture payloads are
unresolved. No production GLB or texture binary is included here.

`npm run bench:instance-update-ranges` runs the paired CPU bookkeeping
microbenchmark. Its 2026-10-14 audit and raw trial data are documented in
[`docs/instance-update-ranges-performance-2026-10-14.md`](docs/instance-update-ranges-performance-2026-10-14.md).

## Provenance and publication

The initial code extraction was copied from Universe Atlas commit
`4e9aa3541334fa67bf4db10ea988f88cfa897e29`. See
[`PROVENANCE.md`](PROVENANCE.md) for source paths, file hashes and excluded
assets. The code repository is marked `UNLICENSED`; public visibility alone
does not grant permission to reuse it. The upstream EZ-Tree MIT notice remains
with Atlas where its derived assets are documented. Atlas-authored tree
materials and textures remain excluded pending an evidenced redistribution
license.
