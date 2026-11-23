// @vitest-environment jsdom
// useChatStream 的边缘分支（2/6）：发送守卫早退、非文本帧丢弃、
// HTTP 前置失败（ok=false）、流中 errorEvent、空回答兜底、非 abort 异常。
// composable 用探针组件挂载（useI18n 需要在组件实例里取）。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { chatApi } = vi.hoisted(() => ({ chatApi: {} }))

vi.mock('@/features/chat/api/chat', () => ({
  chatQueryStream: (...args) => chatApi.chatQueryStream(...args)
}))

import { describe, expect, it, beforeEach } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { useChatStream } from '@/features/chat/composables/useChatStream'

/**
 * 探针组件：在 setup 里装配 useChatStream，把 api 与回调记录暴露到外面。
 * 回调全部用可判定的桩（scrollToBottom/flushSession 计数）。
 */
async function setupStream ({ workflowId = 'wf-1', workflowName = '客户问答' } = {}) {
  const apiRef = {}
  const ticks = { autoScroll: 0, flush: 0 }
  const options = {
    workflowId: ref(workflowId),
    workflowName: ref(workflowName),
    conversationId: ref('conv-1'),
    messages: ref([]),
    question: ref(''),
    scrollToBottom: vi.fn(async () => {}),
    autoScroll: () => { ticks.autoScroll += 1 },
    flushSession: () => { ticks.flush += 1 }
  }
  const wrapper = await mountWithPlugins({
    name: 'StreamProbe',
    setup () {
      Object.assign(apiRef, useChatStream(options))
      return () => h('div')
    }
  }, { router: null })
  await flush()
  return { wrapper, api: apiRef, options, ticks }
}

async function sendAndSettle (stream, question = '问题') {
  stream.options.question.value = question
  const promise = stream.api.send()
  await promise
  await flush()
  await nextTick()
}

beforeEach(() => {
  window.localStorage.clear()
  chatApi.chatQueryStream = vi.fn()
})

describe('发送守卫：三种早退', () => {
  it('问题为空：不发请求、不 push 消息', async () => {
    const stream = await setupStream()
    await sendAndSettle(stream, '   ')
    expect(chatApi.chatQueryStream).not.toHaveBeenCalled()
    expect(stream.options.messages.value).toHaveLength(0)
    expect(stream.ticks.flush).toBe(0)
  })

  it('没有选中工作流：早退', async () => {
    const stream = await setupStream({ workflowId: '' })
    await sendAndSettle(stream, '问题')
    expect(chatApi.chatQueryStream).not.toHaveBeenCalled()
    expect(stream.options.messages.value).toHaveLength(0)
  })

  it('正在发送中：再次触发直接早退（并发闸）', async () => {
    const stream = await setupStream()
    // 挂起的流：abort 时以 AbortError 拒绝（与真实 fetch 一致）
    chatApi.chatQueryStream = vi.fn((_p, { signal } = {}) => new Promise((resolve, reject) => {
      signal?.addEventListener?.('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }))
    stream.options.question.value = '第一问'
    const first = stream.api.send()
    await flush()
    expect(stream.api.sending.value).toBe(true)
    // 第二次：sending=true → 早退，问题也没被清空
    stream.options.question.value = '第二问'
    await stream.api.send()
    expect(chatApi.chatQueryStream).toHaveBeenCalledTimes(1)
    expect(stream.options.question.value).toBe('第二问')
    stream.api.stopGenerating()
    await first
    await flush()
    expect(stream.api.sending.value).toBe(false)
    expect(stream.options.messages.value[1].stopped).toBe(true)
  })
})

describe('流帧：非文本帧直接丢弃', () => {
  it('未知事件与空 content 帧都不进正文；随后的文本帧正常渲染', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async (_payload, { onEvent } = {}) => {
      onEvent({ event: 'ping', data: JSON.stringify({ anything: 1 }) }) // 未知类型 → 丢
      onEvent({ event: 'token', data: JSON.stringify({}) }) // text 帧但无 content → 丢
      onEvent({ event: 'token', data: JSON.stringify({ content: '正文' }) })
      return { ok: true, status: 200 }
    })
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.text).toBe('正文')
    expect(reply.firstTokenMs).toBeGreaterThan(0)
    expect(stream.ticks.autoScroll).toBeGreaterThan(0)
  })
})

describe('失败收尾', () => {
  it('ok=false：未进入流式就失败 → error 消息带工作流名', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async () => ({
      ok: false,
      status: 404,
      // 未发布工作流：服务端 detail 是内部 ID，文案用当前选中的工作流名重写
      errorEnvelope: { code: 'published_workflow_not_found', detail: 'RAG_Workflow_ab12' }
    }))
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.error).toBe(true)
    expect(reply.pending).toBe(false)
    expect(reply.totalMs).toBeGreaterThan(0)
    expect(reply.text).toContain('客户问答')

    // 普通失败：带 HTTP 状态；errorEnvelope 缺失时也兜得住
    chatApi.chatQueryStream = vi.fn(async () => ({ ok: false, status: 502 }))
    await sendAndSettle(stream)
    expect(stream.options.messages.value[3].text).toContain('502')
  })

  it('流中 errorEvent：HTTP 200 但终态报错 → error 消息', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async () => ({
      ok: true,
      status: 200,
      errorEvent: { code: 'upstream_error', detail: '上游模型超时' }
    }))
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.error).toBe(true)
    expect(reply.text).toContain('上游模型超时')
  })

  it('流成功但没有正文：给「回答为空」兜底文案', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async () => ({ ok: true, status: 200 }))
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.error).toBe(false)
    expect(reply.text).toContain('空回答')
  })

  it('非 abort 异常：error 消息带错误文案；flush 与滚动仍执行', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async () => { throw new Error('网络断开') })
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.error).toBe(true)
    expect(reply.stopped).toBe(false)
    expect(stream.ticks.flush).toBe(1)
    expect(stream.options.scrollToBottom).toHaveBeenCalled()
  })

  it('证据帧先于正文：挂到回复上并触发 autoScroll', async () => {
    const stream = await setupStream()
    chatApi.chatQueryStream = vi.fn(async (_payload, { onEvent } = {}) => {
      onEvent({ event: 'retrieval', data: JSON.stringify({ evidence: { items: [{ kind: 'vector', source: '文件A', score: 0.5 }], timings: {} } }) })
      return { ok: true, status: 200 }
    })
    await sendAndSettle(stream)
    const reply = stream.options.messages.value[1]
    expect(reply.evidence.items).toHaveLength(1)
    expect(reply.retrievalMs).toBeGreaterThan(0)
  })
})
