import { streamPost } from '@/shared/api/stream'
import { setUnauthorizedHandler } from '@/shared/api/unauthorized'

// 补 `src/shared/api/stream.js` 既有 api.stream.spec.js 没碰到的分支：
//   - SSE `id:` 字段的解析（帧元信息要带给 onEvent）；
//   - 流**自然结束**时残留帧恰好是终态（done / error）的收尾返回；
//   - error 事件的 data 不是对象 JSON / 是空串时 parseProblem 的回落；
//   - 首字节前 HTTP 401 → 交给会话层处理器（与 axios 路径同一套）。
// 全程假 fetch + 真 ReadableStream，不打网络。
vi.mock('@/shared/api/client', () => ({
  buildRequestHeaders: () => ({ 'X-Auth-Value': 'test-token' })
}))

const encoder = new TextEncoder()

function sseResponse (chunks, { status = 200, headers = { 'content-type': 'text/event-stream' } } = {}) {
  const queue = chunks.slice()
  const body = new ReadableStream({
    pull (controller) {
      if (!queue.length) {
        controller.close()
        return
      }
      const next = queue.shift()
      controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next)
    }
  })
  return new Response(body, { status, headers })
}

function mockFetch (response) {
  const fetchMock = vi.fn(() => Promise.resolve(response))
  globalThis.fetch = fetchMock
  return fetchMock
}

describe('streamPost（补充分支）', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('SSE 帧元信息', () => {
    it('id: 字段解析出来随帧一起交付（断线重连要靠它做 Last-Event-ID）', async () => {
      mockFetch(sseResponse(['event: token\nid: 42\ndata: {"content":"你好"}\n\n']))
      const frames = []

      await streamPost('/api/query', {}, { onEvent: f => frames.push(f) })

      expect(frames).toEqual([{ event: 'token', data: '{"content":"你好"}', id: '42' }])
    })

    it('data: 后带规范允许的一个空格、以及无冒号的裸行都不炸解析', async () => {
      mockFetch(sseResponse(['event: token\ndata:plain\ngarbage\n\n']))
      const frames = []

      await streamPost('/api/query', {}, { onEvent: f => frames.push(f) })

      expect(frames).toEqual([{ event: 'token', data: 'plain', id: undefined }])
    })

    it('只有注释/空行的帧不产生事件', async () => {
      mockFetch(sseResponse([': keep-alive\n\n', 'event: token\ndata: 1\n\n']))
      const frames = []

      const result = await streamPost('/api/query', {}, { onEvent: f => frames.push(f) })

      expect(frames).toEqual([{ event: 'token', data: '1', id: undefined }])
      expect(result.ok).toBe(true)
    })
  })

  describe('流自然结束时残留帧是终态', () => {
    it('末帧 done 没带尾随空行：仍判 done=true 收尾', async () => {
      mockFetch(sseResponse(['event: token\ndata: a\n\n', 'event: done\ndata: {"finish_reason":"stop"}']))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.done).toBe(true)
      expect(result.errorEvent).toBeNull()
    })

    it('末帧 error 没带尾随空行：终态 errorEvent 带出，done=false', async () => {
      mockFetch(sseResponse(['event: token\ndata: a\n\n', 'event: error\ndata: {"code":"x","detail":"炸了"}']))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.ok).toBe(true)
      expect(result.done).toBe(false)
      expect(result.errorEvent).toEqual({ code: 'x', detail: '炸了' })
    })
  })

  describe('error 事件的 data 形态回落', () => {
    it('data 是空串：parseProblem 返回 null，回落成 { detail: "" }（调用方拿得到终态）', async () => {
      mockFetch(sseResponse(['event: error\ndata: \n\n']))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.done).toBe(false)
      expect(result.errorEvent).toEqual({ detail: '' })
    })

    it('data 是标量 JSON（非对象）：parseProblem 返回 null，保留原文', async () => {
      mockFetch(sseResponse(['event: error\ndata: 123\n\n']))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.errorEvent).toEqual({ detail: '123' })
    })

    it('data 是 null 字面量：同样回落保留原文', async () => {
      mockFetch(sseResponse(['event: error\ndata: null\n\n']))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.errorEvent).toEqual({ detail: 'null' })
    })
  })

  describe('首字节前的 401', () => {
    it('有会话处理器时交给它（与 axios 拦截器同一套），不再读流', async () => {
      const handler = vi.fn()
      setUnauthorizedHandler(handler)
      try {
        mockFetch(new Response(JSON.stringify({ code: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        }))

        const result = await streamPost('/api/query', {}, { onEvent: () => {} })

        expect(handler).toHaveBeenCalledTimes(1)
        expect(handler.mock.calls[0][0]).toMatchObject({ status: 401, code: 'unauthorized' })
        expect(result.ok).toBe(false)
        expect(result.status).toBe(401)
        expect(result.errorEnvelope).toEqual({ code: 'unauthorized' })
      } finally {
        setUnauthorizedHandler(null)
      }
    })

    it('没有处理器时（极早期请求）不炸，仍按普通错误信封返回', async () => {
      mockFetch(new Response('denied', { status: 401 }))

      const result = await streamPost('/api/query', {}, { onEvent: () => {} })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(401)
      expect(result.errorEnvelope).toBeNull()
    })
  })
})
