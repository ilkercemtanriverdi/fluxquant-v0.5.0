# Migrating FluxQuant v1.3.1 → v1.5.0 Consolidated Baseline

The safe installer performs an in-place overlay and preserves:

- `data/`
- `.env`
- `.venv`
- `node_modules/`
- `.git/`
- backup history and unrelated local files

Before replacing managed release files it creates a backup. If local validation fails, managed files are restored automatically. The installer does **not** run `npm install`, download market data, access an account, read private keys or place orders/bets.

## After installation

Use the release-level gate:

```bash
npm run audit:full
```

For sports research, new JSONL input must follow the v1.5 contract. In particular, `receivedAtMs` is required for causal paper evidence, and `LICENSED_FEED` / `EXPLICIT_RESEARCH_LICENSE` rows require `sourceContractId`.

Old sports JSONL generated against the staged v1.4 schema should be treated as migration input, not as untouched evidence, because v1.5 intentionally tightened timing, rights, commission and settlement rules.

The historical Polymarket pair-arb checkpoint is not rerun to search for a more attractive parameter set; the failed frozen reference result remains the project checkpoint.
