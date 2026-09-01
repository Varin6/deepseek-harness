/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a self-hosted SearXNG
 * instance's JSON API. It maps each result's `content` excerpt to `snippet` and
 * its `publishedAt` to `publishedAt`, keeps excerpt-less sources rather than
 * dropping them, and maps the instance's direct `answers[]` to the result's
 * `content`. SearXNG exposes no wire result-count control, so the seam owns the
 * `maxResults` bound. The native `fetch` client is provider-private.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Default endpoint: a local SearXNG instance on the official docker quickstart's
 * host port. A SearXNG instance is a deployment choice — there is no public
 * default endpoint the harness can trust.
 */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Maximum characters of a non-JSON error body surfaced in the provider message. */
const ERROR_BODY_MAX_CHARS = 512

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Endpoint base; `/search` is appended. Must parse for the provider to be available. */
  baseURL: string
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when the entry
 * carries no absolute HTTP(S) URL — the seam's source vocabulary requires one,
 * and inventing a URL would lie. An entry without an excerpt keeps no
 * `snippet` rather than a placeholder.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the URL is unusable.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (typeof result.url !== 'string' || result.url.length === 0) return undefined
  let absolute: URL
  try {
    absolute = new URL(result.url)
  } catch {
    return undefined
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.trim().length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.trim().length > 0 ? { snippet: result.content } : {},
    ...result.publishedAt != null && result.publishedAt.trim().length > 0 ? { publishedAt: result.publishedAt } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result. Direct answers
 * are joined into `content`; `truncated` stays false — the web service owns the
 * final `maxResults` truncation.
 *
 * @param response - the parsed `GET /search` response body.
 * @returns the normalized result.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  const answers = (response.answers ?? []).filter(
    (answer): answer is string => typeof answer === 'string' && answer.trim().length > 0,
  )
  return {
    ...answers.length > 0 ? { content: answers.join('\n') } : {},
    sources,
    truncated: false,
  }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  /**
   * Cheap local usability check: SearXNG carries no credential, so only the
   * endpoint is checked. Instance liveness surfaces as `WEB_PROVIDER_ERROR`
   * at execution.
   */
  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const params = new URLSearchParams()
    params.set('q', request.query)
    params.set('format', 'json')
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search?${params.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const text = (await response.text()).trim()
        if (text.length > 0) message = errorDetail(text) ?? message
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // body that cannot be read can only cost a richer provider message,
        // never the real error.
      }
      throw new WebError(describeEndpointError(message, this.options.baseURL), 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('response body is not a JSON object')
      }
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `SearXNG returned an unprocessable response body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

/**
 * Build the model/user-facing message for a failed SearXNG request: the
 * provider message plus the endpoint it used and the two configuration levers
 * that change it.
 */
function describeEndpointError(message: string, baseURL: string): string {
  return (
    `${message}. The web search request used endpoint "${baseURL}/search". A SearXNG instance `
    + 'answers this only when its settings enable the `json` format (`search.formats`). If the instance '
    + 'is not intended, the user can set SEARXNG_BASE_URL or configure web-search-searxng.baseURL to a '
    + 'reachable SearXNG instance. Only the user should choose or change the endpoint.'
  )
}

/**
 * Extract a provider error detail from a non-2xx body: a JSON `error`/`message`
 * field when the body is JSON, the trimmed body itself when it is short plain
 * text, and `undefined` when neither yields anything (the status-line message
 * stays).
 */
function errorDetail(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A non-JSON body is plain text: a short body surfaces as-is, an overlong
    // one only costs a richer provider message, never the real error.
    return text.length <= ERROR_BODY_MAX_CHARS ? text : undefined
  }
  const record = (parsed === null || typeof parsed !== 'object' ? {} : parsed) as { error?: unknown; message?: unknown }
  return typeof record.error === 'string' && record.error.length > 0
    ? record.error
    : typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : undefined
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
