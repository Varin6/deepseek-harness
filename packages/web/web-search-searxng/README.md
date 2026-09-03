---
description: "The SearXNG-backed search provider for ctx.web: how deployments mount keyless web search through a self-hosted SearXNG instance with the JSON API enabled."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches the web through a SearXNG instance the deployment runs and gets portable excerpts and publication dates without any API key. Choose it when a deployment does not hold a search vendor credential — SearXNG is keyless, and its results come from the instance's configured upstream engines. An excerpt maps to `snippet` and the instance's direct `answers[]` map to `content`; a source without an excerpt is kept rather than dropped. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `searxng` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: searxng`.

### When to choose it

Choose this backend when a deployment runs a SearXNG instance (or points at one it trusts) and wants keyless search over the instance's upstream engines. SearXNG answers `format=json` only when its settings enable the JSON format, so the instance is the deployment's configuration surface: the provider is available as soon as its endpoint parses, and an instance that does not serve JSON — a stock instance, a bot wall, or a rate limit — fails the call with a structured error at execution.

### Minimal configuration

Load the web service and the provider; the endpoint falls back to `$SEARXNG_BASE_URL` from the launch environment, then to the local docker quickstart port. No credential is read or required.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://10.0.0.5:8080
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL`, else `http://127.0.0.1:8080` | SearXNG endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each SearXNG result maps to a `WebSearchSource`: `url`, `title`, `content` as `snippet`, and `publishedAt`; a result without an excerpt keeps no `snippet` rather than being dropped, because the URL and title stay citeable. The instance's direct `answers[]` join into the result's `content`. SearXNG exposes no wire result-count control, so the seam truncates to the request's `maxResults` on the way back and flags the result.

### Failures and recovery

Provider failures — HTTP errors (including the instance's bot walls and rate limits), network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`, whose message names the configured endpoint and the configuration levers; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over a SearXNG instance's JSON API with three deliberate rules:

- **Keyless by construction.** SearXNG carries no credential, so the provider reads none; the instance is the deployment's trust boundary, and the availability check is a local endpoint parse rather than a liveness probe.
- **Excerpts, not invented snippets.** A source gains a `snippet` only from the instance's `content` excerpt; an excerpt-less source is kept without a placeholder rather than dropped.
- **Direct answers are content.** The instance's `answers[]` are engine-sourced direct answers (definitions, calculations); they map to the result's `content`, and blank or non-string entries are dropped.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types: `SearxngSearchResponse`, `SearxngResult` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` GETs `{baseURL}/search` with the URL-encoded query and `format=json` and `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` map one by one (entries whose URL is not an absolute HTTP(S) URL are dropped) and `answers[]` join into `content`; the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-searxng) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, excerpts, and publication dates or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **The instance must enable the JSON format** — a stock SearXNG instance answers `format=json` with HTML or a 403, and the failure surfaces as `WEB_PROVIDER_ERROR` at execution rather than at load.
- **Instance liveness is not probed** — `available()` is a local endpoint parse; a stopped or misrouted instance fails the call at execution.
- **No wire result-count control** — SearXNG's JSON API carries no count parameter, so `maxResults` is enforced only post-hoc by service truncation.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: instance controls and discovery

A self-hosted SearXNG also exposes categories, language, time-range, and safe-search controls, and a deployment may want instance discovery rather than a fixed endpoint. Both wait on provider-neutral service fields, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
