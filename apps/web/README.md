# @voltedge/web

The VoltEdge terminal — a Vite + React + TypeScript single-page app that
renders live DeepBook Predict data: SVI surface, no-arbitrage monitor,
edge heatmap, the bit-exactness Proof tab, PLP vault Monte-Carlo, oracle
health, and the live bot console.

Read-only and zero-setup — it polls the public testnet indexer and does
read-only `devInspect` calls; no wallet, keys, or tokens required.

```bash
# from the repo root
npm install
npm run dev        # http://localhost:5173
```

See the root [README](../../README.md) and
[RUNBOOK](../../docs/RUNBOOK.md) for the full project.
