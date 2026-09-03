# Agent Note: SearXNG search provider for the web seam

Status: implemented

English | [中文](2026-08-30-web-search-searxng.zh.md)

## Problem

Every shipped search backend for the [web capability seam](../architecture/2026-06-24-web-capability-seam.md) requires a vendor credential: Exa and Perplexity take API keys, and DeepSeek native search spends a full auxiliary model turn per search on a paid endpoint. A deployment that wants web search without holding any of those — or that wants its upstream engine mix, privacy posture, and rate budget under its own control — has no keyless backend to mount.

Public SearXNG instances are not a candidate default: most disable the JSON API, sit behind bot challenges, or rate-limit aggressively, and no public instance is a trust or availability commitment the product can pin. The workable shape is the instance the deployment already runs.

## Decision

`@deepseek-ai/dsh-web-search-searxng` (`packages/web/web-search-searxng`) is a fourth search provider on `ctx.web`, registered as `searxng`. It is the Exa adapter's shape without the credential: a thin client over a SearXNG instance's JSON API (`GET /search?q=<query>&format=json`), native `fetch` with `redirect: 'error'`, `WEB_ABORTED`/`WEB_PROVIDER_ERROR` mapping, and the seam's `maxResults` truncation as the only result-count enforcement (the SearXNG JSON API has no count parameter).

Mapping rules, each chosen against the seam's "never invent" discipline:

- A source's `snippet` comes only from the instance's `content` excerpt; an excerpt-less source is **kept** (URL and title stay citeable) rather than dropped, unlike Exa's highlight rule.
- The instance's direct `answers[]` join into the result's `content`; blank and non-string entries are dropped.
- A result whose URL is not an absolute HTTP(S) URL is dropped.
- `available()` is a local endpoint parse only — no credential to check and no liveness probe.

Configuration is one field: `baseURL` (config → `$SEARXNG_BASE_URL` → `http://127.0.0.1:8080`, the docker quickstart port). The base bundle ships the row **disabled**: mounting it without a reachable JSON-enabled instance would only turn a misconfiguration into an execution-time error, and with DeepSeek search already pinned as `web.searchProvider`, an auto-enabled `searxng` could never win selection. A deployment with an instance enables the row and pins `searchProvider: searxng` in a later patch layer.

The non-2xx provider message names the configured endpoint and the two configuration levers (`SEARXNG_BASE_URL`, `web-search-searxng.baseURL`), and leaves the endpoint choice to the user — the same guidance shape the DeepSeek provider's message carries.

## Alternatives considered

**A public SearXNG instance as the default endpoint.** Rejected because JSON-format availability, bot walls, and rate limits make public instances an untrustworthy default, and the product would then depend on third-party uptime for a free feature it could not fix.

**An HTML-scraping fallback for instances without JSON.** Rejected: the seam's provider discipline is structured results, never prose scraping, and a stock instance's HTML response would otherwise masquerade as data.

**A settings-page card next to the DeepSeek one.** Deferred: the settings card family renders credential-bearing providers; SearXNG's one non-secret field is fully covered by config/env, and the Plugins page inventory surfaces the row.

## Consequences

Keyless search is a deployment overlay, not a shipped default: the base bundle's row stays disabled, the DeepSeek pin is untouched, and `web_search` keeps its stable schema in every mode. A deployment enables the row, points `baseURL` at its instance (or sets `SEARXNG_BASE_URL`), enables the instance's `json` format, and pins `searchProvider: searxng`; provider-specific failures surface through `WEB_PROVIDER_ERROR` with an endpoint-named message. Unit and integration tests cover mapping, error and abort classification, the redirect regression through real HTTP, HMR-safe disposal, and the tool path end-to-end; the e2e suite self-skips without `$SEARXNG_BASE_URL`.
