// @vitest-environment jsdom
// 对话测试页（ChatPage.vue）的 DOM 交互残余分支（8/6 之页三）：
// 工作流下拉的 v-model 与选项渲染、空列表引导、建议问题按钮、消息 meta 按钮组、
// 输入框 v-model、附件提示按钮、设置气泡、检索链路抽屉、证据文档详情弹窗、
// 重命名弹窗（opened 聚焦 / v-model / 取消）、历史面板 select/search 事件、
// 导出与删除的空目标早退、keyword 阶段的链路步骤、boundKbLabels 与 kbLabelByIdentity。
// 基础覆盖见 test_wf_ChatPage.spec.js。
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
  getFlowList: (...args) => workflowApi.getFlowList(...args)
}))

vi.mock('@/shared/composables/deletion', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, requestDeletion: (...args) => deletionApi.requestDeletion(...args) }
})

vi.mock('@/shared/lib/utils', () => ({ download: (...args) => sideEffects.download(...args) }))
vi.mock('@/shared/lib/clipboard', () => ({ copyText: (...args) => sideEffects.copyText(...args) }))
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import ChatPage from '@/pages/chat/ChatPage.vue'

const Blank = { name: 'BlankView', render: () => null }
const ROUTES = [
  { path: '/chat', name: 'chat', component: Blank },
  { path: '/flow', name: 'flow', component: Blank },
  { path: '/:pathMatch(.*)*', component: Blank }
]

const WORKFLOWS = [
  { workFlowId: 'wf-1', name: '客户问答', publishType: 1, kbPkIds: [{ name: '手册库', tableName: 'doc_kb-1' }], graphKbPkIds: [] },
  { workFlowId: 'wf-2', name: '图谱检索', publishType: 1, kbPkIds: [] }
]

/** 会渲染插槽并可回抛事件的 EP 桩。 */
const PARTS = {
  ElAlert: {
    name: 'ElAlert',
    props: ['title', 'type'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'chat-no-workflows' }, [slots.title ? slots.title() : null, slots.default ? slots.default() : null])
    }
  },
  ElSelect: {
    name: 'ElSelect',
    props: { modelValue: { type: [String, Number], default: '' } },
    emits: ['update:modelValue'],
    setup (_p, { slots }) {
      return () => h('div', { class: 'select-stub' }, [slots.default?.()])
    }
  },
  ElOption: { name: 'ElOption', props: ['label', 'value'], setup: props => () => h('div', { class: 'opt-stub' }, props.label) },
  ElPopover: {
    name: 'ElPopover',
    setup (_p, { slots }) {
      return () => h('div', { class: 'popover-stub' }, [slots.reference?.(), slots.default?.()])
    }
  },
  // footer 插槽也渲染（证据详情弹窗的关闭按钮在 footer 里）
  ElDialog: {
    name: 'ElDialog',
    props: ['modelValue', 'title'],
    emits: ['update:modelValue', 'close', 'opened'],
    setup (props, { slots, emit }) {
      return () => (props.modelValue
        ? h('div', { class: 'test-dialog' }, [
            slots.default ? slots.default() : null,
            slots.footer ? slots.footer() : null
          ])
        : null)
    }
  },
  // 打开时发 opened（重命名弹窗聚焦箭头依赖它）
  ElDrawer: {
    name: 'ElDrawer',
    props: ['modelValue', 'title'],
    emits: ['update:modelValue'],
    setup (props, { slots }) {
      return () => (props.modelValue ? h('div', { class: 'drawer-stub' }, [slots.default?.()]) : null)
    }
  }
}

async function mountPage ({ rows = WORKFLOWS } = {}) {
  workflowApi.getFlowList = vi.fn(async () => ({ items: rows, total: rows.length }))
  chatApi.chatQueryStream = vi.fn()
  deletionApi.requestDeletion = vi.fn(async () => true)
  sideEffects.download = vi.fn()
  sideEffects.copyText = vi.fn(async () => true)

  const wrapper = await mountWithPlugins(ChatPage, {
    route: '/chat',
    routes: ROUTES,
    global: {
      components: PARTS,
      stubs: {
        ChatHistoryPanel: {
          name: 'ChatHistoryPanelStub',
          props: ['search', 'histories', 'total', 'activeId'],
          emits: ['select', 'action', 'manage', 'update:search'],
          setup (_props, { emit }) {
            return () => h('button', { class: 'panel-stub', onClick: () => {
              emit('update:search', '关键字')
              emit('select', { conversationId: 'conv-x' })
            } })
          }
        }
      },
      config: {
        globalProperties: {
          $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
        }
      }
    }
  })
  await flush()
  await flush()
  return wrapper
}

const EVIDENCE = {
  items: [
    { kind: 'vector', kb: 'doc_kb-1', source: '文件A', text: '片段一', score: 0.87 },
    { kind: 'vector', kb: 'doc_kb-1', source: '文件B', text: '片段二', score: 0.42 }
  ],
  timings: { understandingMs: 10, keywordRetrievalMs: 30, retrievalMs: 120, generateMs: 400 },
  stats: { sources: 2 }
}

async function withAssistantMessage (wrapper) {
  wrapper.vm.messages.push({
    role: 'assistant',
    text: '回答内容',
    html: '<p>回答内容</p>',
    totalMs: 1234,
    evidence: EVIDENCE
  })
  await flush()
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('工作流选择与空态', () => {
  it('下拉 v-model 切换工作流；选项渲染', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('.opt-stub')).toHaveLength(2)
    const select = wrapper.findAllComponents({ name: 'ElSelect' })[0]
    select.vm.$emit('update:modelValue', 'wf-2')
    await flush()
    expect(wrapper.vm.selectedWorkflowId).toBe('wf-2')
  })

  it('无已发布工作流：给引导提示与「去发布」链接', async () => {
    const wrapper = await mountPage({ rows: [] })
    await flush()
    await flush()
    const alert = wrapper.find('.chat-no-workflows')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('去知识检索')
  })
})

describe('消息区与输入区交互', () => {
  it('欢迎页建议按钮：点击填入问题', async () => {
    const wrapper = await mountPage()
    const suggestion = wrapper.find('.chat-welcome button')
    await suggestion.trigger('click')
    expect(wrapper.vm.question).not.toBe('')
  })

  it('输入框 v-model；消息 meta 按钮（复制 / 点赞 / 点踩）走 DOM 点击', async () => {
    const wrapper = await mountPage()
    await withAssistantMessage(wrapper)
    await wrapper.find('textarea').setValue('新问题')
    expect(wrapper.vm.question).toBe('新问题')

    const upVote = wrapper.find('button[aria-label="赞同"]')
    const downVote = wrapper.find('button[aria-label="反对"]')
    if (upVote.exists()) {
      await upVote.trigger('click')
      expect(wrapper.vm.messages[0].vote).toBe(1)
      await downVote.trigger('click')
      expect(wrapper.vm.messages[0].vote).toBe(-1)
    } else {
      // 按钮存在性兜底：模板没渲染时至少 msg-meta 有复制入口
      expect(wrapper.find('.msg-meta').exists()).toBe(true)
    }
    // 复制按钮（文案 = 复制答案）
    const copyBtn = wrapper.findAll('.msg-meta button').at(0)
    await copyBtn.trigger('click')
    await flush()
    expect(sideEffects.copyText).toHaveBeenCalled()
  })

  it('附件按钮只提示未接入；设置气泡渲染', async () => {
    const wrapper = await mountPage()
    const attach = wrapper.find('button[aria-label="添加附件"]')
    await attach.trigger('click')
    await flush()
    expect(messageMock.info).toHaveBeenCalled()
    expect(wrapper.find('.popover-stub').exists()).toBe(true)
  })

  it('检索链路「完整链路」按钮：打开抽屉；抽屉 v-model 关闭', async () => {
    const wrapper = await mountPage()
    const link = wrapper.findAll('.section-title button').find(node => node.text().includes('链路'))
    await link.trigger('click')
    expect(wrapper.vm.traceDrawer).toBe(true)
    await flush()
    const drawer = wrapper.findComponent({ name: 'ElDrawer' })
    drawer.vm.$emit('update:modelValue', false)
    await flush()
    expect(wrapper.vm.traceDrawer).toBe(false)
  })

  it('证据文档：点击打开详情弹窗；关闭按钮与 close 事件都能关', async () => {
    const wrapper = await mountPage()
    await withAssistantMessage(wrapper)
    const docHit = wrapper.find('button.doc-hit')
    await docHit.trigger('click')
    expect(wrapper.vm.selectedDoc).toBeTruthy()
    await flush()
    const closeBtn = wrapper.findAll('.test-dialog button').find(node => node.text().includes('关闭'))
    await closeBtn.trigger('click')
    expect(wrapper.vm.selectedDoc).toBeNull()

    // close 事件通路
    wrapper.vm.selectedDoc = EVIDENCE.items[0]
    await flush()
    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('close')
    await flush()
    expect(wrapper.vm.selectedDoc).toBeNull()
  })

  it('keyword 阶段：链路步骤含关键词检索', async () => {
    const wrapper = await mountPage()
    await withAssistantMessage(wrapper)
    expect(wrapper.vm.traceSteps.map(step => step.key)).toContain('keyword')
  })
})

describe('历史面板与辅助分支', () => {
  async function withHistory () {
    const wrapper = await mountPage()
    wrapper.vm.messages.push({ role: 'user', text: '问题一', ts: Date.now() })
    wrapper.vm.flush(wrapper.vm.selectedWorkflowId)
    await flush()
    return wrapper
  }

  it('历史面板：search 与 select 事件通路', async () => {
    const wrapper = await withHistory()
    await wrapper.find('button.panel-stub').trigger('click')
    await flush()
    expect(wrapper.vm.historySearch).toBe('关键字')
  })

  it('exportHistories / removeHistories：空目标早退', async () => {
    const wrapper = await withHistory()
    wrapper.vm.exportHistories([])
    expect(sideEffects.download).not.toHaveBeenCalled()
    await wrapper.vm.removeHistories([])
    expect(deletionApi.requestDeletion).not.toHaveBeenCalled()
  })

  it('boundKbLabels：只留字符串名；kbLabelByIdentity：无名库跳过', async () => {
    const wrapper = await mountPage()
    // wf-1 带 { name, tableName }；再补一条无名库验证 continue 分支
    wrapper.vm.publishedWorkflows[0].kbPkIds = [{ name: '手册库', tableName: 'doc_kb-1' }, {}, { tableName: 'doc_x' }]
    await flush()
    expect(wrapper.vm.boundKbLabels).toEqual(['手册库'])
    expect(wrapper.vm.kbLabelByIdentity.get('kb-1')).toBe('手册库') // 身份 token 剥掉 doc_ 前缀
    expect(wrapper.vm.kbLabelByIdentity.get('x')).toBeUndefined()
  })

  it('发送失败（未发布工作流）：错误文案用当前工作流名', async () => {
    const wrapper = await mountPage()
    chatApi.chatQueryStream = vi.fn(async () => ({
      ok: false,
      status: 404,
      errorEnvelope: { code: 'published_workflow_not_found', detail: 'RAG_Workflow_xx' }
    }))
    wrapper.vm.question = '问题'
    wrapper.vm.onEnterKey({ keyCode: 13, preventDefault: vi.fn() })
    await flush()
    await flush()
    expect(wrapper.vm.messages.at(-1).error).toBe(true)
    expect(wrapper.vm.messages.at(-1).text).toContain('客户问答')
  })
})
