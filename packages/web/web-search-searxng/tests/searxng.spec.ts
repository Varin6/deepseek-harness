import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  mapSearxngResponse,
  mapSearxngResult,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from '@deepseek-ai/dsh-web-search-searxng'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'

const options = { baseURL: 'http://searxng.test:8080' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SearXNG result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapSearxngResult({
      url: 'https://a.test',
      title: 'A',
      content: 'excerpt',
      publishedAt: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'excerpt', publishedAt: '2026-01-01' })
  })

  it('drops a result without an absolute HTTP(S) URL', () => {
    expect(mapSearxngResult({ title: 'no url' })).toBeUndefined()
    expect(mapSearxngResult({ url: '', title: 'empty url' })).toBeUndefined()
    expect(mapSearxngResult({ url: null })).toBeUndefined()
    expect(mapSearxngResult({ url: 'example.com/a' })).toBeUndefined()
    expect(mapSearxngResult({ url: 'ftp://a.test' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: null, content: null, publishedAt: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', title: '', content: '', publishedAt: '' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('keeps an excerpt-less source without inventing a snippet', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: 'A', content: '  ' }))
      .toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapSearxngResponse({
      results: [
        { url: 'https://a.test', title: 'A', content: 'one' },
        { url: 'https://b.test', title: 'B' },
        { url: 'https://c.test', title: 'C', content: 'three', publishedAt: '2026-02-02' },
        { title: 'dropped' },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://b.test', title: 'B' },
        { url: 'https://c.test', title: 'C', snippet: 'three', publishedAt: '2026-02-02' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('joins direct answers into content and drops blank or non-string entries', () => {
    const result = mapSearxngResponse({
      results: [],
      answers: ['Paris is the capital of France.', '', '   ', 42 as unknown as string],
    })
    expect(result.content).toBe('Paris is the capital of France.')
    expect(result.sources).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('omits content when no usable answer is present', () => {
    expect(mapSearxngResponse({ results: [], answers: ['  '] }).content).toBeUndefined()
    expect(mapSearxngResponse({ results: [] }).content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapSearxngResponse({}).sources).toEqual([])
  })

})

describe('SearxngSearchProvider availability', () => {
  it('is misconfigured when the base URL is unparseable', () => {
    expect(new SearxngSearchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is available with a parseable base URL and no credential', () => {
    expect(new SearxngSearchProvider(options).available()).toBe(true)
    expect(new SearxngSearchProvider({ baseURL: 'https://search.example' }).available()).toBe(true)
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends a GET with the encoded query and json format, and no result-count parameter', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await new SearxngSearchProvider(options).search({ query: 'deep seek café', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      `http://searxng.test:8080/search?${new URLSearchParams({ q: 'deep seek café', format: 'json' }).toString()}`,
    )
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['accept']).toBe('application/json')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('deepseek-harness/0.0.1')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new SearxngSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('maps a JSON error body detail to WEB_PROVIDER_ERROR with the endpoint note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unsupported format' }, { status: 403 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(
        expect.objectContaining({
          code: 'WEB_PROVIDER_ERROR',
          message: expect.stringContaining('unsupported format'),
        }),
      )
  })

  it('maps a JSON error body message field to the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'rate limited' }, { status: 429 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('rate limited') }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('SearXNG API error (HTTP 500)') }))
  })

  it.each([null, [1], 42])('keeps the status-line message for a JSON error body of %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('SearXNG API error (HTTP 502)') }))
  })

  it('keeps the status-line message when the JSON error fields are empty strings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '', message: '' }, { status: 503 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('SearXNG API error (HTTP 503)') }))
  })

  it('surfaces a short plain-text error body as the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too Many Requests', { status: 429 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('Too Many Requests') }))
  })

  it('keeps the status-line message for an overlong plain-text error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(600), { status: 502 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('SearXNG API error (HTTP 502)') }))
  })

  it('keeps the status-line message for an empty error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('SearXNG API error (HTTP 429)') }))
  })

  it('names the configured endpoint in the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'no' }, { status: 403 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('http://searxng.test:8080/search'),
        }),
      )
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it.each([null, [1], 42])('maps a JSON success body of %s to WEB_PROVIDER_ERROR, not an empty result', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, { status: 200 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body read as WEB_ABORTED', async () => {
    const body = {
      text: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      ok: false,
      status: 500,
    }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('keeps a non-abort error-body read failure as WEB_PROVIDER_ERROR', async () => {
    const body = {
      text: () => Promise.reject(new Error('read failed')),
      ok: false,
      status: 500,
    }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new SearxngSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-searxng plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test' }] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, { baseURL: options.baseURL })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://a.test' }],
      truncated: false,
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('exposes no default export (function plugin namespace)', () => {
    expect(Object.hasOwn(searxngPlugin, 'default')).toBe(false)
  })

  it('prefers the configured baseURL over the environment and default', async () => {
    const prev = process.env.SEARXNG_BASE_URL
    process.env.SEARXNG_BASE_URL = 'http://env.test'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await ctx.plugin(searxngPlugin, { baseURL: 'http://config.test' })
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('http://config.test/search?q=q&format=json')
    } finally {
      if (prev === undefined) delete process.env.SEARXNG_BASE_URL
      else process.env.SEARXNG_BASE_URL = prev
    }
  })

  it('falls back to $SEARXNG_BASE_URL when the config omits baseURL', async () => {
    const prev = process.env.SEARXNG_BASE_URL
    process.env.SEARXNG_BASE_URL = 'http://env.test'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await ctx.plugin(searxngPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('http://env.test/search?q=q&format=json')
    } finally {
      if (prev === undefined) delete process.env.SEARXNG_BASE_URL
      else process.env.SEARXNG_BASE_URL = prev
    }
  })

  it('falls back to the local default endpoint when neither config nor env supplies one', async () => {
    const prev = process.env.SEARXNG_BASE_URL
    delete process.env.SEARXNG_BASE_URL
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime)
      await ctx.plugin(searxngPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe(`${SEARXNG_DEFAULT_BASE_URL}/search?q=q&format=json`)
    } finally {
      if (prev !== undefined) process.env.SEARXNG_BASE_URL = prev
    }
  })
})
