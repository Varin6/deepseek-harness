import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider } from '@deepseek-ai/dsh-web-search-searxng'

/**
 * Real-instance smoke for the SearXNG search provider. Self-skips without
 * `$SEARXNG_BASE_URL` (CI has no self-hosted instance), per the with-credential
 * e2e policy in docs/testing.md — the instance URL is this provider's credential.
 */
const baseURL = process.env.SEARXNG_BASE_URL
const maybe = baseURL !== undefined && baseURL.length > 0 ? describe : describe.skip

maybe('SearxngSearchProvider real instance', () => {
  it('is available and returns sources for a live query', async () => {
    const provider = new SearxngSearchProvider({ baseURL: baseURL! })
    expect(provider.available()).toBe(true)
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
