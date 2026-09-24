# Xor serving decision (2026-09-24)

The protected production app uses one A100-80GB with the pinned BF16 release,
SGLang image, and upstream decision wrapper. No quantization was applied.

All runs used Xor revision `679decd4c669e5c37f4ac29dbd9957997424c876`
and the 231 public JEVBench cases at commit
`fd51755eb0c0b546ca206d764faf3302feca913e`. Each candidate also ran
fixed binary, ordinal-score, and red-image fixtures and maximum supported
image and long-text requests. The quality gate required valid schemas, no more
than one percentage point accuracy loss, mean absolute probability drift at
most 0.01 on the public cases and fixed fixtures, Brier increase at most 0.01,
warm p95 under five seconds, and at least 10% free VRAM after maximum requests.

| GPU configuration | Valid | Accuracy | Brier | Public-case drift | Fixed-fixture drift | Warm p95 | Memory finding | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 × RTX PRO 6000 reference | 231/231 | 87.88% | 0.1961 | reference | reference | 0.225 s | 9.4% free on fuller GPU after smoke | baseline |
| 1 × RTX PRO 6000 | 231/231 | 89.18% | 0.1950 | 0.0094 | 0.0217 | 0.202 s | 10.85% free after smoke | rejected: score-fixture drift |
| 1 × A100-80GB, CUDA graphs | 231/231 | 90.04% | 0.1937 | 0.0087 | 0.0048 | 0.337 s | 9.11% free at sampled peak | rejected: peak headroom |
| 1 × A100-80GB, no CUDA graphs | 231/231 | 90.04% | 0.1937 | 0.0086 | 0.0048 | 0.515 s | 11.31% free at sampled peak | selected |

The RTX score fixture changed one level probability by 0.0679 relative to the
reference. The A100's largest change on that fixture was 0.0103. Both
single-GPU configurations used tensor parallelism one, a 16,384-token context,
and a 16,384-token maximum prefill budget. Requests exceeding the proxy's
12,000-token aggregate budget are rejected before inference. The A100 retains
the original 0.85 static-memory fraction for its hybrid attention cache and
disables CUDA graph capture to meet peak headroom. The final smoke exercised
eight 2-megapixel images, near-5-MiB decoded images, long text, 26 options,
16 questions, and 16 questions with eight images.

At [Modal's published per-second rates](https://modal.com/pricing), including
four CPU cores and 16 GiB memory, allocation costs are approximately $0.001772
for the two-GPU reference, $0.000930 for one RTX, and $0.000782 for one A100 per
second. Mean warm inference cost on this suite was $0.000187 for the reference,
$0.000101 for the RTX, and $0.000351 for the selected no-graph A100 per
successful case. These are allocated-container cost estimates, not member
usage charges or billed totals. The no-graph A100 reached readiness after 20
ten-second health polls in its cold trial. A 120-second idle period costs about
$0.094 on that A100, versus $0.213 on the reference. With scale-to-zero and
231 calls per cold session, the measured startup/idle savings outweigh the
selected configuration's higher warm-call cost. Startup and idle are excluded
from the member GPU-seconds ledger. At most one candidate container was
allocated at a time; the experiments and final validation stayed below the
$25 allocation-time cap, with more than $5 reserved for final checks.

Reproduce the quality comparison with `benchmark_xor.py`, `smoke_xor.py`, and
`compare_xor.py`. The published app defaults to the selected A100. Do not
replace it with the cheaper warm RTX configuration without resolving its
calibration drift and rerunning the full gate.
