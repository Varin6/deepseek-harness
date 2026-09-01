/**
 * Wire types for a SearXNG instance's JSON search API (`GET /search?format=json`).
 * Types only — no runtime code. A JSON-enabled instance returns a flat `results[]`;
 * each entry carries a URL, a title, an optional `content` excerpt, and an optional
 * `publishedAt` string. The top-level `answers[]` carries direct answers from
 * engines that provide them (definitions, calculations), when any.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  url?: string | null
  title?: string | null
  /** The excerpt field; the seam's `snippet` maps from it. */
  content?: string | null
  publishedAt?: string | null
}

/** SearXNG's search response envelope. */
export interface SearxngSearchResponse {
  results?: SearxngResult[]
  /** Direct answers; blank and non-string entries are dropped. */
  answers?: string[]
}
