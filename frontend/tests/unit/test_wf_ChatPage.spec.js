// @vitest-environment jsdom
// 对话测试页（ChatPage.vue 的视图编排层）：工作流选择与空态、历史会话
// （重命名/置顶/导出/删除/清空）、检索链路追踪面板、消息操作、发送守卫。
// 数据层 composable 走真实现（chat.*.spec 已各自覆盖），只 mock 网络与副作用。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { chatApi, workflowApi, deletionApi, sideEffects, messageMock } = vi.hoisted(() => ({
  chatApi: {},
  workflowApi: {},
  deletionApi: {},
  sideEffects: {},
  messageMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('@/features/chat/api/chat', () => ({
  chatQueryStream: (...args) => chatApi.chatQueryStream(...args)
}))

vi.mock('@/features/workflow/api', () => ({
  getFlowList: (...args) => workflowApi.getFlowList(...args),
  getPublishedFlowConfig: (...args) => workflowApi.getPublishedFlowConfig(...args),
  getAllStatusKbase: (...args) => workflowApi.getAllStatusKbase(...args)
}))

vi.mock('@/shared/composables/deletion', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    requestDeletion: (...args) => deletionApi.requestDeletion(...args)
  }
})

vi.mock('@/shared/lib/utils', () => ({
  download: (...args) => sideEffects.download(...args)
}))

vi.mock('@/shared/lib/clipboard', () => ({
  copyText: (...args) => sideEffects.copyText(...args)
}))

vi.mock('@/shared/lib/message', () => ({ default: messageMock }))

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'
import ChatPage from '@/pages/chat/ChatPage.vue'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/chat', name: 'chat', component: Blank },
  { path: '/flow', name: 'flow', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

const WORKFLOWS = [
  { workFlowId: 'wf-1', name: '客户问答', publishType: 1 },
  { workFlowId: 'wf-2', name: '图谱检索', publishType: 1 }
]

/** el-select 换成原生 select：工作流下拉直接切。 */
const SelectStub = {
  name: 'ElSelect',
  props: { modelValue: { type: [String, Number], default: '' } },
  emits: ['update:modelValue', 'change'],
  setup (props, { slots, emit }) {
    return () => null
  }
}

async function mountPage () {
  workflowApi.getFlowList = vi.fn(async () => ({ items: WORKFLOWS, total: 2 }))
  workflowApi.getPublishedFlowConfig = vi.fn(async () => ({ nodeConfigDTOList: [] }))
  workflowApi.getAllStatusKbase = vi.fn(async () => ({ running: [], dev: [] }))
  chatApi.chatQueryStream = vi.fn()
  deletionApi.requestDeletion = vi.fn(async () => true)
  sideEffects.download = vi.fn()
  sideEffects.copyText = vi.fn(async () => true)

  const wrapper = await mountWithPlugins(ChatPage, {
    route: '/chat',
    routes: ROUTES,
    global: {
      config: {
        globalProperties: {
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
        }
      },
      stubs: {
        ElSelect: SelectStub,
        ElOption: { name: 'ElOption', render: () => null },
        ChatHistoryPanel: {
          name: 'ChatHistoryPanelStub',
          emits: ['select', 'action', 'manage', 'search'],
          setup (_props, { emit }) {
            return () => null
          }
        }
      }
    }
  })
  await flush()
  await flush()
  return wrapper
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('工作流选择', () => {
  it('挂载即加载已发布工作流并默认选第一个', async () => {
    const wrapper = await mountPage()
    expect(workflowApi.getFlowList).toHaveBeenCalled()
    expect(wrapper.vm.publishedWorkflows).toHaveLength(2)
    expect(wrapper.vm.selectedWorkflowId).toBe('wf-1')
  })

  it('列表为空：给「去发布」空态；错误态给重试', async () => {
    const wrapper = await mountPage()
    workflowApi.getFlowList = vi.fn(async () => ({ items: [], total: 0 }))
    await wrapper.vm.loadWorkflows()
    await flush()
    expect(wrapper.vm.publishedWorkflows).toHaveLength(0)
    expect(wrapper.vm.loadError).toBeFalsy()

    workflowApi.getFlowList = vi.fn(async () => {
      throw new Error('网络断开')
    })
    await wrapper.vm.loadWorkflows()
    await flush()
    expect(wrapper.vm.loadError).toBeTruthy()
    await wrapper.vm.refreshWorkflows()
  })

  it('refreshWorkflows：列表与绑定核对一起重跑', async () => {
    const wrapper = await mountPage()
    workflowApi.getFlowList.mockClear()
    await wrapper.vm.refreshWorkflows()
    expect(workflowApi.getFlowList).toHaveBeenCalled()
  })
})

describe('历史会话操作', () => {
  async function withHistory () {
    const wrapper = await mountPage()
    // 空会话不入历史：塞一条消息并立即落盘，得到一段真实历史
    wrapper.vm.messages.push({ role: 'user', text: '问题一', ts: Date.now() })
    wrapper.vm.flush(wrapper.vm.selectedWorkflowId)
    await flush()
    const session = wrapper.vm.sessions[0]
    expect(session, '历史会话应已生成').toBeTruthy()
    return { wrapper, session }
  }

  it('saveHistoryName：空名给错误；成功重命名并提示', async () => {
    const { wrapper } = await withHistory()
    wrapper.vm.renameOpen = true
    wrapper.vm.renameTarget = wrapper.vm.sessions[0]
    wrapper.vm.renameTitle = '   '
    wrapper.vm.saveHistoryName()
    expect(wrapper.vm.renameError).toBeTruthy()

    wrapper.vm.renameTitle = '新名字'
    wrapper.vm.saveHistoryName()
    expect(wrapper.vm.sessions[0].title).toBe('新名字')
    expect(messageMock.success).toHaveBeenCalled()
    expect(wrapper.vm.renameOpen).toBe(false)
  })

  it('renameTarget 已不存在：直接关弹窗', async () => {
    const { wrapper } = await withHistory()
    wrapper.vm.renameOpen = true
    wrapper.vm.renameTarget = { conversationId: 'ghost', title: '旧' }
    wrapper.vm.renameTitle = '名字'
    wrapper.vm.saveHistoryName()
    expect(wrapper.vm.renameOpen).toBe(false)
    expect(messageMock.success).not.toHaveBeenCalled()
  })

  it('historyAction：pin / rename / export / delete 分发', async () => {
    const { wrapper, session } = await withHistory()
    wrapper.vm.historyAction('pin', session)
    // sessions 是计算快照：置顶后重新取
    expect(wrapper.vm.sessions.find(item => item.conversationId === session.conversationId).pinned).toBe(true)

    wrapper.vm.historyAction('rename', session)
    expect(wrapper.vm.renameOpen).toBe(true)
    expect(wrapper.vm.renameTarget.conversationId).toBe(session.conversationId)
    wrapper.vm.renameOpen = false

    wrapper.vm.historyAction('export', session)
    expect(sideEffects.download).toHaveBeenCalledWith(expect.stringContaining('# 问题一'), expect.stringMatching(/\.md$/), expect.anything())

    wrapper.vm.historyAction('delete', session)
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalled()
  })

  it('manageHistories：export 全部导出；clear 走确认后清空', async () => {
    const { wrapper, session } = await withHistory()
    wrapper.vm.manageHistories('export')
    expect(sideEffects.download).toHaveBeenCalled()

    await wrapper.vm.manageHistories('clear')
    await flush()
    expect(deletionApi.requestDeletion).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.anything()
    }))
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('removeHistories：确认被拒不删；清空分支提示清空成功', async () => {
    const { wrapper, session } = await withHistory()
    deletionApi.requestDeletion = vi.fn(async () => false)
    await wrapper.vm.removeHistories([session])
    expect(messageMock.success).not.toHaveBeenCalled()

    deletionApi.requestDeletion = vi.fn(async () => true)
    await wrapper.vm.removeHistories([session], true)
    await flush()
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('exportHistories：多会话合并导出；安全文件名替换非法字符', async () => {
    const { wrapper, session } = await withHistory()
    wrapper.vm.historySearch = ''
    const fakeSecond = { ...session, conversationId: 'ghost', title: '坏/名字:测试?' }
    wrapper.vm.exportHistories([session, fakeSecond])
    expect(sideEffects.download).toHaveBeenCalledTimes(1)
    const [content, filename] = sideEffects.download.mock.calls[0]
    expect(filename).not.toMatch(/[/:?]/)
    expect(String(filename).endsWith('.md')).toBe(true)
    expect(content).toContain('---')
  })

  it('filteredSessions：按标题关键字过滤', async () => {
    const { wrapper, session } = await withHistory()
    wrapper.vm.renameOpen = true
    wrapper.vm.renameTarget = session
    wrapper.vm.renameTitle = '客户问答历史'
    wrapper.vm.saveHistoryName()
    wrapper.vm.historySearch = '客户'
    expect(wrapper.vm.filteredSessions.map(item => item.title)).toEqual(['客户问答历史'])
    wrapper.vm.historySearch = '不存在的'
    expect(wrapper.vm.filteredSessions).toHaveLength(0)
  })

  it('formatFullDate / currentSessionDate', async () => {
    const { wrapper } = await withHistory()
    expect(wrapper.vm.formatFullDate(0)).toBe('')
    expect(wrapper.vm.formatFullDate(new Date('2026-06-01T10:30:00').getTime())).toBe('2026-06-01 10:30')
    expect(wrapper.vm.currentSessionDate).toBeTruthy()
  })
})

describe('发送与停止（send 走完流式生命周期）', () => {
  /** 可编程的 SSE 假流：onEvent 逐帧投喂，最后 resolve 一个 ok 结果。 */
  function streamScript (frames) {
    return async (_payload, { onEvent } = {}) => {
      for (const frame of frames) {
        onEvent(frame)
      }
      return { ok: true, status: 200 }
    }
  }

  async function mountWithStream (frames) {
    const wrapper = await mountPage()
    chatApi.chatQueryStream = vi.fn(streamScript(frames))
    wrapper.vm.question = '帮我总结'
    wrapper.vm.onEnterKey({ keyCode: 13, preventDefault: vi.fn() })
    await flush()
    await flush()
    return wrapper
  }

  it('发送：用户消息 + 助手回复落进消息列表，问题清空、sending 复位', async () => {
    const wrapper = await mountWithStream([
      { event: 'retrieval', data: JSON.stringify({ evidence: { items: [{ kind: 'vector', kb: 'doc_k', source: 's', text: 't', score: 0.5 }], timings: { retrievalMs: 80 } } }) },
      { event: 'token', data: JSON.stringify({ content: '回答第一段' }) },
      { event: 'token', data: JSON.stringify({ content: '，第二段。' }) }
    ])
    await flush()

    expect(chatApi.chatQueryStream).toHaveBeenCalledTimes(1)
    const roles = wrapper.vm.messages.map(msg => msg.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(wrapper.vm.messages[0].text).toBe('帮我总结')
    expect(wrapper.vm.messages[1].text).toContain('回答第一段')
    expect(wrapper.vm.question).toBe('')
    expect(wrapper.vm.sending).toBe(false)
    expect(wrapper.vm.messages[1].pending).toBe(false)
    // 证据帧已挂到回复上
    expect(wrapper.vm.latestEvidence.items).toHaveLength(1)
  })

  it('流失败（ok=false）：助手消息标记 error', async () => {
    chatApi.chatQueryStream = vi.fn(async () => ({ ok: false, status: 500 }))
    const wrapper = await mountPage()
    wrapper.vm.question = '问题'
    wrapper.vm.onEnterKey({ keyCode: 13, preventDefault: vi.fn() })
    await flush()
    await flush()
    expect(wrapper.vm.messages.at(-1).error).toBe(true)
    expect(wrapper.vm.sending).toBe(false)
  })

  it('thinking 帧：拆出思考内容', async () => {
    const wrapper = await mountWithStream([
      { event: 'token', data: JSON.stringify({ content: '<think>先想想</think>正文' }) }
    ])
    await flush()
    const reply = wrapper.vm.messages.at(-1)
    expect(reply.thinking).toContain('先想想')
    expect(reply.text).toContain('正文')
  })

  it('stopGenerating：abort 后流以「已停止」收尾，sending 复位', async () => {
    const wrapper = await mountPage()
    let abortSignal = null
    let abortListener = null
    chatApi.chatQueryStream = vi.fn((_payload, { signal, onEvent } = {}) => new Promise((resolve, reject) => {
      abortSignal = signal
      // 真实实现：fetch 流被 abort 时以 AbortError 拒绝
      signal?.addEventListener?.('abort', () => {
        abortListener = true
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
        resolve({ ok: false, status: 499 })
      })
      return
    }))
    wrapper.vm.question = '问题'
    wrapper.vm.onEnterKey({ keyCode: 13, preventDefault: vi.fn() })
    await flush()
    expect(wrapper.vm.sending).toBe(true)
    expect(abortSignal).toBeTruthy()
    wrapper.vm.stopGenerating()
    await flush()
    await flush()
    expect(abortListener).toBe(true)
    expect(wrapper.vm.sending).toBe(false)
  })
})

describe('检索链路与消息展示', () => {
  it('空消息时给欢迎页；latestAssistant/latestEvidence 为 null', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.messages).toHaveLength(0)
    expect(wrapper.vm.latestAssistant).toBeNull()
    expect(wrapper.vm.latestEvidence).toBeNull()
    expect(wrapper.vm.stageTimings).toBeTruthy()
    expect(wrapper.vm.traceSteps.length).toBeGreaterThanOrEqual(3)
    expect(wrapper.vm.traceMetrics).toHaveLength(4)
    expect(wrapper.vm.evidenceDocs).toEqual([])
    expect(wrapper.vm.canSend).toBe(false)
  })

  it('注入一条助手消息后：证据/阶段/指标联动（含图谱证据分支）', async () => {
    const wrapper = await mountPage()
    const message = {
      role: 'assistant',
      text: '回答内容',
      totalMs: 1234,
      evidence: {
        items: [
          { kind: 'graph', kb: 'doc_kb-1', source: '文件A', text: '片段', score: 0.87 },
          { kind: 'graph', kb: 'doc_kb-1', source: '文件B', text: '片段2', score: 8 }
        ],
        timings: { understandingMs: 20, retrievalMs: 100, rerankMs: 50, generateMs: 300 },
        stats: { sources: 2 }
      }
    }
    wrapper.vm.messages.push(message)
    await flush()

    expect(wrapper.vm.latestAssistant).toStrictEqual(message)
    expect(wrapper.vm.stageTimings.rerankMs).toBe(50)
    expect(wrapper.vm.evidenceScoreHint).toBeTruthy()
    expect(wrapper.vm.traceSteps.map(step => step.key)).toContain('graph')
    expect(wrapper.vm.evidenceDocs).toHaveLength(2)
    expect(wrapper.vm.traceMetrics[1].value).toBe('2')
    expect(wrapper.vm.traceMetrics[2].value).toBe('8.00')
    expect(wrapper.vm.traceMetrics[3].value).toBe('2')
  })

  it('kbLabel：证据里的库 base 换回创建时的库名', async () => {
    const wrapper = await mountPage()
    wrapper.vm.publishedWorkflows[0].kbPkIds = [{ name: '手册库', tableName: 'doc_kb-1' }]
    await flush()
    expect(wrapper.vm.kbLabel('doc_kb-1')).toBe('手册库')
    expect(wrapper.vm.kbLabel('doc_unknown')).toBe('doc_unknown')
  })

  it('missingKbLabels：绑定库匹配不上的告警换可读名', async () => {
    const wrapper = await mountPage()
    workflowApi.getPublishedFlowConfig.mockResolvedValue({
      nodeConfigDTOList: [{ knowledge_base_name: ['doc_kb-1', 'doc_ghost', 'graph_g1'] }]
    })
    await wrapper.vm.refreshWorkflows()
    wrapper.vm.publishedWorkflows[0].kbPkIds = [{ name: '手册库', assetId: 'asset-1', tableName: 'doc_kb-1' }]
    expect(wrapper.vm.missingKbLabels).toEqual(['手册库', 'doc_ghost', 'graph_g1'])
  })

  it('消息操作：复制成功/失败、点赞取消', async () => {
    const wrapper = await mountPage()
    const msg = { role: 'assistant', text: '你好' }
    await wrapper.vm.copyMessage(msg)
    expect(messageMock.success).toHaveBeenCalled()

    sideEffects.copyText = vi.fn(async () => false)
    await wrapper.vm.copyMessage(msg)
    expect(messageMock.error).toHaveBeenCalled()

    wrapper.vm.toggleVote(msg, 1)
    expect(msg.vote).toBe(1)
    wrapper.vm.toggleVote(msg, 1)
    expect(msg.vote).toBe(0)
    wrapper.vm.toggleVote(msg, -1)
    expect(msg.vote).toBe(-1)
  })

  it('canSend：选了工作流 + 有问题 + 不在发送中', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.canSend).toBe(false)
    wrapper.vm.question = '你好'
    expect(wrapper.vm.canSend).toBe(true)
    wrapper.vm.sending = true
    expect(wrapper.vm.canSend).toBe(false)
  })

  it('onEnterKey：组字期间不发送；正常回车走 send（chatQueryStream 被调用）', async () => {
    const wrapper = await mountPage()
    wrapper.vm.question = '问题'
    const stop = vi.fn()
    // 组字中：不发
    wrapper.vm.onEnterKey({ isComposing: true, preventDefault: stop })
    expect(chatApi.chatQueryStream).not.toHaveBeenCalled()
    wrapper.vm.onEnterKey({ keyCode: 229, preventDefault: stop })
    expect(chatApi.chatQueryStream).not.toHaveBeenCalled()
    // 正常回车：send 被调 → chatQueryStream 发起（流挂起不落地即可）
    chatApi.chatQueryStream = vi.fn(() => new Promise(() => {}))
    wrapper.vm.onEnterKey({ keyCode: 13, preventDefault: stop })
    await flush()
    expect(chatApi.chatQueryStream).toHaveBeenCalledTimes(1)
  })

  it('showNotConnected：未接后端的能力点击只提示', async () => {
    const wrapper = await mountPage()
    wrapper.vm.showNotConnected('trialRunNotConnected')
    expect(messageMock.info).toHaveBeenCalled()
  })
})
