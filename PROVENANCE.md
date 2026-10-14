# Extraction provenance

This standalone source snapshot was copied from Universe Atlas commit
`4e9aa3541334fa67bf4db10ea988f88cfa897e29` on 2026-10-14. Source code is in
`src/`; focused, asset-independent tests are in `tests/`. The copied public
facades are `src/tree-kit-v1/` and expose API version 1.0.0.

The extraction contains no Atlas GLB, PNG, mip sidecar, generated review
render, or other binary tree asset. Atlas' two runtime families contain
Atlas-authored bark and foliage materials whose redistribution rights are not
established. Their family manifests currently say `NOASSERTION`; that is not
a license grant. Asset-dependent tests remain in Atlas until the rights and
portable provenance references are resolved. EZ-Tree's MIT license covers
only the upstream geometry contribution, not Atlas-authored materials.

Before adding assets, record a rights determination and portable source
references, preserve the upstream notices, replace workstation-absolute
manifest paths, regenerate hashes, and validate the package sidecars. Until
then this repository remains `UNLICENSED` and is not a redistributable asset
bundle.

## Source checksums

SHA-256 for the extracted TypeScript source files at this snapshot:

| Path | SHA-256 |
| --- | --- |
| `/src/compact-instance-slots.ts` | `99362cb0636b13ff896298d83194861068f6fb0752d84ba148c34c3a9e60c093` |
| `/src/forest-coverage.ts` | `0db75b783a6f3ec2fb9796b8ee2577a42cc1ce35ae6e1fe1e1e0af5ba3762a9d` |
| `/src/forest-dirty-blocks.ts` | `f710fed0d64278520beada3740f162af7868f517ae8b0385db0fd96e3b64936a` |
| `/src/forest-far-atlas.ts` | `8b59f68e6c8b39b62928459e67bf4b7b2343ebbc3f4d028c21458d91c08804a4` |
| `/src/forest-foliage-lobe.ts` | `7b67460d44fc5c0923978436144c1fc6b7bd89f4cbf136430f703b1f318407f8` |
| `/src/forest-impostor.ts` | `5787c4758ef42241dd6d12147ac8abfd1f769f4c0e4b00b11693dcd397af32b1` |
| `/src/forest-material.ts` | `d32a96c520264d42d04a34e360608c38f2cd1c7ccb1e3424a70e1480c2ed708e` |
| `/src/forest-presentation.ts` | `b05a9ec9074be64e3bac8fe18c4682e138cd18f0415dec6e468d618dde69e5ea` |
| `/src/forest-resource-accounting.ts` | `0ca84ded9a2a52d3fd6596bf5adf8448a08af42ac695e6d433730de857c8fe4b` |
| `/src/forest-tree-family-library.ts` | `e919873a77f288f320f455b362c9038524a488a5e21086e444a8f82e77957f0a` |
| `/src/instance-update-ranges.ts` | `6ee7fd00142af2e3938fd8480c0bf46b80f7fb71c5492538f7c63c704631ac29` |
| `/src/render-profile.ts` | `8e58e474ca0dc87a90b23edbf5bf6fbe6faa254a4ecdcec8d6acecf69a926188` |
| `/src/tree-allometry.ts` | `2c1ea7351f273e0258da41537c9de45e076b50047ebe8a00ec45bdaffaa62e32` |
| `/src/tree-asset-lab.ts` | `8d21914103793b35ddc346ec8f861a86a4e8664c4375b8ce9f2fedff86a07637` |
| `/src/tree-asset.ts` | `37831fe464f55822184d774bbded0bccb473a2032dcdf2e27173b6840edf0d9c` |
| `/src/tree-bark-texture-pool.ts` | `b73aa456e580723f53880d4e1c5a8e0fc3c4eafa52c24fb1b8ada4536abedc3f` |
| `/src/tree-canopy-bounds.ts` | `cc82927d9d59c198fc61d06884244293f03836a02c6e49f521eec6b673f8a693` |
| `/src/tree-canopy-profile.ts` | `2f9ded37a996562602b4c3dacd198164e0c8b847f97908f22cd5a47a516be414` |
| `/src/tree-captured-impostor.ts` | `fd50312e9a43d2181331cdf6d77d1c0f1bdcb2e2a43f6939eba6bccaba90bfd4` |
| `/src/tree-diffuse-transfer-shader.ts` | `389f8899b724af3e90ea39766bead20e945e96dd0e8d267e7ebcf20d2f0f5e8e` |
| `/src/tree-diffuse-transfer.ts` | `04cd3de2c90eab635d322d7e59d2fa550361498549f2917536c358a91b2b634b` |
| `/src/tree-foliage-cutoff.ts` | `0078d87efa25ee848ec26cd982a9ed4e0ef5aaf9a0aa30b9233a937fca6553ff` |
| `/src/tree-foliage-mips.ts` | `b35ff28275ad5e9e888ada56d8764168627af2a1c8200a99b70761cb7bf038da` |
| `/src/tree-foliage-sidecar.ts` | `0f57590b1f40c52ebccfd9d408b55ca54ada32628783407418e90c17869e8684` |
| `/src/tree-forest-coverage.ts` | `e74c0ad07873b1c201880a091e0bfc8ecfcf6e352203fea8496ab1fb574304fd` |
| `/src/tree-impostor-filter.ts` | `87a4d1030bc5dec1a7f7081d79389cd2a08a47c806e6311d686918d5063c7394` |
| `/src/tree-impostor-reference-shader.ts` | `08be44cbb1aaf730898f677d49ed32cd4c1341256d2a1245a582c8cc6272090f` |
| `/src/tree-impostor-views.ts` | `c869606567f97f12a8d14b14ae1f9d5472b8d938e8d893e437d2265a7ee173cf` |
| `/src/tree-instance-passes.ts` | `6c50a0204357af611c8d0d80489afc77d4458a72286b5c783c811904dc86f0ee` |
| `/src/tree-kit-v1/assets.ts` | `152518f6d21f8862a2786958222ae60fe138790f5c852a8dd054bfb7c27d2347` |
| `/src/tree-kit-v1/impostors.ts` | `23796cc16f99bd160e2f914fd6d8a3c7a3496ad0589aeae0c2c9ac6d1d45b78d` |
| `/src/tree-kit-v1/instances.ts` | `a1c0c55debd7fbb982e1bef876a455ec5e4929dafa5f4dd01875c5f5d420a41c` |
| `/src/tree-kit-v1/metrics.ts` | `75bd3f67ef15939699dd36390a2ca2a5c1cbb3955a51d66e446f11b4a3817e15` |
| `/src/tree-kit-v1/presentation.ts` | `d8799ffd741952b4ff12e5448063297fa161cd0773b46f53b51d019f31cb5c46` |
| `/src/tree-kit-v1/recipes.ts` | `901fbef559baf8b4f907023a63fd0f9a9874100705b5f691d96ce9d6292fe924` |
| `/src/tree-kit-v1/version.ts` | `89d2f2ead77de568ff6159be0a9dda145074c1a693d7df7861de424f65db3218` |
| `/src/tree-leaf-transmission.ts` | `6f161c4ec513838f5516120288592855ec4f6ed4ccc8d7de5c83ae54a4c502d0` |
| `/src/tree-lod-coverage.ts` | `05cb93196ab312f38755251025593176d1435ba72db245bac9c2145ed86d9b6d` |
| `/src/tree-shape.ts` | `f429c36b11aca98439cb4a3b3cbe7251c09083910c974c452d0ac603594d74fe` |
| `/src/tree-species-recipe.ts` | `af7e16b71866b312791c127c283ed5bfd26db61b02ca3406d7d776492e37e5da` |
| `/src/tree-structural-variant.ts` | `b6864e120bbc7f859d72f485f3c219afae45d31e13e289844d4eb8a50b3cd089` |
