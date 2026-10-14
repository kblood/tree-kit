# Instance update range CPU audit (2026-10-14)

This audit compared the Tree Kit implementation at baseline commit
`4a05bacd960bbb6dc9e5f77201c8294e486cdd86` with an experimental in-place fast
path for the case where one pending range overlaps a new edit. The candidate
mutated that range instead of splicing, allocating, pushing and sorting. A
differential test exercised the exact baseline and candidate across Float32 and
Uint16 attributes, item widths 1/2/3/4/16, delayed upload consumption, range
caps/ties and historically unchecked numeric inputs. All 24 focused cases
passed; the full Kit suite passed 110 tests.

The benchmark used identical precomputed workloads, four alternating warmup
pairs, eleven alternating measured pairs and 200 iterations per pair on Node
24.7.0, Three 0.181.0, Windows x64 and a Ryzen 9 9950X3D. Timed sections cover
CPU `include`/`flush` bookkeeping and simulated attribute-range consumption;
they do not measure rendering or GPU work. The raw paired timings and hashes
are in [`instance-update-ranges-benchmark-2026-10-14.json`](./instance-update-ranges-benchmark-2026-10-14.json).

| Workload | Baseline median | Candidate median | Paired change |
| --- | ---: | ---: | ---: |
| Sequential immediate flush | 91.1734 ms | 72.1308 ms | −20.83% |
| Sparse immediate flush | 157.7002 ms | 161.7819 ms | **+2.27%** |
| Multiple includes / row swaps | 108.9262 ms | 109.0726 ms | +0.18% |
| Hidden frames retaining uploads | 67.1073 ms | 54.6685 ms | −19.04% |
| Zero-work retained upload | 2.6550 ms | 2.6548 ms | +0.74% |

The sparse workload was slower in all eleven paired trials and in three
revised-candidate runs. A 200-iteration baseline-versus-restored-baseline
control measured a −0.012% sparse delta, so the repeatable sparse regression
was not accepted as timing noise. The production implementation remains
unchanged. The benchmark and differential suite are retained so this cost
center can be revisited with representative Atlas traces. The result supports
CPU bookkeeping conclusions only; it does not close the separate integrated
near/middle/far Atlas GPU and runtime acceptance gate.
