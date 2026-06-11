# 56-0 College Baseball

Browser prototype for a college-baseball version of the franchise-era draft game.

## Commands

```bash
npm install
npm run fetch:schools
npm run prepare:data
npm run dev
```

## Included data workflow

- `scripts/fetch-schools-index.mjs` pulls NCAA school slugs used for logo rendering.
- `scripts/prepare-data.mjs` ingests the 2026 hitter, pitcher, and advanced sheets; fits hitter `oWAR` and pitcher `pWAR` from the advanced file; and emits app-ready JSON.
- `scripts/fetch-baseball-reference.mjs YEAR bat|pitch` captures Baseball Reference college leader pages as structured JSON.
- `scripts/fetch-thebaseballcube.mjs YEAR` captures Baseball Cube college season team links for a given year.

## Current scope

- Full 2026 draft pool from the supplied CSVs.
- 13-slot roster: `C, 1B, 2B, 3B, SS, LF, CF, RF, SP, SP, SP, RP, RP`.
- Classic mode sorts by estimated value; hard mode sorts alphabetically.
- One respin per pick.

Historical sources are wired in as fetch scripts, but the live player pool currently uses the 2026 CSV set until older-season imports are normalized into the same schema.
