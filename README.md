# boss-aggregator

> **BOSS Versioning System — Aggregator Repository**
>
> Reads all 5 microservices, applies tier + label decision matrix, decides BOSS version, writes `version.json`.

---

## Overview

The `boss-aggregator` is the central intelligence of the **BOSS Versioning System**. It runs on a scheduled cron (every Tuesday and Thursday) and can also be triggered manually for the demo.

### What it does:
1. Reads `config/services-config.json` to understand tier assignments
2. Calls GitHub API to get the **latest release from the `uat` branch** of each microservice
3. Reads **PR labels** from the latest merged PR on `uat` of each service
4. Applies the **Tier × Label decision matrix** to determine BOSS version bump
5. Updates `version.json` with the new BOSS version and full service manifest
6. Creates a **GitHub Release** as an audit trail

---

## Repository Structure

```
boss-aggregator/
├── .github/
│   └── workflows/
│       └── aggregate.yml       ← scheduled pipeline (Tue/Thu) + manual trigger
├── config/
│   └── services-config.json   ← tier definitions for all 5 microservices
├── scripts/
│   └── aggregate.js           ← main aggregation logic
└── version.json               ← BOSS version output (auto-updated by pipeline)
```

---

## Decision Matrix

| Service Tier | PR Label | BOSS Version Bump |
|-------------|----------|------------------|
| Tier 1 | `breaking-change` | **MAJOR** (e.g. `2.1.0 → 3.0.0`) |
| Tier 1 | `feature` / `enhancement` | **MINOR** (e.g. `2.1.0 → 2.2.0`) |
| Tier 2 | `feature` / `enhancement` | **MINOR** (e.g. `2.1.0 → 2.2.0`) |
| Tier 1 or 2 | `bugfix` | **PATCH** (e.g. `2.1.0 → 2.1.1`) |
| Tier 3 | any label | **PATCH** (e.g. `2.1.0 → 2.1.1`) |
| No services changed | — | **No bump** |

> **Priority Rule**: If multiple services changed in the same UAT cycle, the **highest impact** outcome wins.

---

## Microservice Tiers

| Repo | Simulates | Tier |
|------|-----------|------|
| `demo-auth-service` | Auth / Identity Service | **Tier 1 — Critical** |
| `demo-payment-service` | Payment / Core API | **Tier 1 — Critical** |
| `demo-order-service` | Order / Inventory | **Tier 2 — Important** |
| `demo-notification-service` | Notification Service | **Tier 2 — Important** |
| `demo-reporting-service` | Reporting / Logging | **Tier 3 — Supporting** |

---

## Pipeline Triggers

- **Scheduled**: Every Tuesday and Thursday at 10 AM UTC (post-UAT deployment window)
- **Manual**: `Actions` tab → `BOSS Aggregator` → `Run workflow`

---

## Version Display (Demo)

The current BOSS version is always visible at:

```
https://raw.githubusercontent.com/Boss-demo-2/boss-aggregator/main/version.json
```

Refresh this URL after the aggregator runs to see the live BOSS version update.
