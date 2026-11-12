# EcoTrust-FLIDS Simulation

An interactive, evidence-backed research demonstrator for EcoTrust-FLIDS.

**Live site:** [https://deepakvermalab.github.io/EcoTrust-FLIDS-Simulation/](https://deepakvermalab.github.io/EcoTrust-FLIDS-Simulation/)

## Explore

- Simulate one federated round under configurable participation, trust, energy, drift, and latency conditions.
- Inspect the deterministic contribution of each controller term.
- Compare recorded Stage-14 policy endpoints and 30-round traces.
- Explore aggregated per-attack binary detection evidence.
- Download compact, checksum-indexed accepted evidence.

## Evidence boundary

- Recorded Stage-14 endpoints and Stage-15 statistical outputs are accepted experiment evidence.
- Interactive custom controls produce deterministic **what-if** scenarios; they do not create new validated F1 results.
- Displayed energy is model-estimated, not direct hardware-energy measurement.
- Controller contribution views explain participation decisions, not neural detector feature attribution.
- Per-attack results are binary intrusion-detection metrics grouped by original attack label, not multiclass classification.

## Static architecture

The demonstrator is a dependency-free static site:

```text
index.html
styles.css
app.js
data.js
downloads/
screenshots/
```

No server, API key, dataset, checkpoint, analytics tracker, or personal data is required.

## Run locally

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

Open `http://127.0.0.1:4174/`.

## Reproducibility

The public evidence bundle is sanitized to replace internal filesystem and Drive paths with portable `project://` references. `downloads/evidence_manifest.json` provides SHA-256 hashes for every downloadable artifact.

## Repository scope

This public repository contains the simulation and compact accepted evidence only. The full training implementation, datasets, checkpoints, and intermediate results are not published here.
