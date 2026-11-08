# G1 size budget

Measured with `npm --prefix builder run size`: the gzip -9 sum of every `.js` and `.css` in `builder/dist/assets`.

| When | Main chunk | QR chunk | CSS | Total gzip |
|---|---|---|---|---|
| Baseline, `origin/main` before G1 (bfdd107) | 61,453 | 4,217 | 1,561 | **67,231** |
| After G1 slice 1 (header, title, step 1, switch) | 62,283 | 4,217 | 1,577 | **68,077** (+846) |

**G1.4 ceiling: 77,315 bytes gzip**, which is the baseline plus 15% (67,231 × 1.15, rounded down). Every later G1 slice adds its row here and must stay under that number.
