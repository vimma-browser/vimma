# Release download counts

`downloads.csv` holds the download count of every Vimma release asset, one row per asset per
day (`date,tag,asset,downloads`, the date in UTC). The `downloads.yml` workflow on `main` appends
a day's rows once a day; this branch shares no history with `main` and holds data only.

To summarise it, from a checkout of `main`:

```sh
git show origin/stats:downloads.csv > /tmp/downloads.csv
node tools/stats/downloads.mjs summary --csv /tmp/downloads.csv --assets
```

See `docs/runbook.md`, "Release download counts".
