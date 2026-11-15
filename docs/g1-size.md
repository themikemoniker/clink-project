# G1 size budget

Measured with `npm --prefix builder run size`: the gzip -9 sum of every `.js` and `.css` in `builder/dist/assets`.

| When | Main chunk | QR chunk | CSS | Total gzip |
|---|---|---|---|---|
| Baseline, `origin/main` before G1 (bfdd107) | 61,453 | 4,217 | 1,561 | **67,231** |
| After G1 slice 1 (header, title, step 1, switch) | 62,283 | 4,217 | 1,577 | **68,077** (+846) |
| Before #211, `origin/main` (54c07be) | 71,411 | 4,217 | 1,639 | **77,267** |
| After #211 (six English hints shortened, no `es` change) | 71,077 | 4,217 | 1,639 | **76,933** (−334). Short of the 600 B target: not yet room for the queued Spanish slices. |

**G1.4 ceiling: 77,315 bytes gzip**, which is the baseline plus 15% (67,231 × 1.15, rounded down). Every later G1 slice adds its row here and must stay under that number. #211 did not change the ceiling.
