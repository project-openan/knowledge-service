// @vitest-environment jsdom
// 临门一脚补测（1/6）：纯函数与可独立驱动的分支残余。
// - form-validators：空名报错分支、currentLocalTime
// - i18n.js：localStorage 里存的是对象（{value}）时的 locale 解析分支
// - useChatSession.togglePin：空目标 id 直接返回
// - 三个算子 Node.vue：节点无 variables 时挂载即 emit initCardHandle
//   （queryNode/responseNode 的 init 回调在固定节点上不可达：useFlowNodeCard 只在
//   `!fixed && 无初始 variables` 时才 emitInit，QUERY/RESPONSE 都是 fixed —— 见报告说明）
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  window.aipVueInstance = { $t: () => '' }
})

vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

const { kbNamesModule } = vi.hoisted(() => ({ kbNamesModule: { map: {} } }))
vi.mock('@/features/knowledge-base/lib/kbNames', () => ({
  kbDisplayName: name => kbNamesModule.map[name] || '',
  loadKbNames: vi.fn(async () => kbNamesModule.map)
}))

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { h, ref } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import {
  uniqueNameRule,
  isHttpEndpoint,
  currentLocalTime,
  expiryDateToUTC,
  isValidExpiryDate
} from '@/shared/lib/form-validators'
import { useChatSession } from '@/features/chat/composables/useChatSession'
import PostretrieverNode from '@/features/workflow/modules/postretriever/Node.vue'
import RetrieverNode from '@/features/workflow/modules/retriever/Node.vue'
import ResponsesynthesizerNode from '@/features/workflow/modules/responsesynthesizer/Node.vue'

describe('form-validators 残余分支', () => {
  it('uniqueNameRule：空名 / 纯空白给「请输入」错误', () => {
    const rule = uniqueNameRule(() => [{ name: 'A' }], '知识检索名')
    const errors = []
    rule.validator(rule, '', error => errors.push(error?.message))
    rule.validator(rule, '   ', error => errors.push(error?.message))
    expect(errors[0]).toBe('请输入知识检索名')
    expect(errors[1]).toBe('请输入知识检索名')
    // 默认 label 兜底
    const plain = uniqueNameRule(() => [])
    let msg = ''
    plain.validator(plain, '', error => { msg = error?.message })
    expect(msg).toBe('请输入名称')
  })

  it('currentLocalTime：上海时区的短时间格式', () => {
    const text = currentLocalTime()
    // sv-SE 短格式：YYYY-MM-DD HH:mm
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('expiryDateToUTC / isValidExpiryDate：空值与非法格式', () => {
    expect(expiryDateToUTC(null)).toBeNull()
    const now = new Date('2026-10-23T00:00:00.000Z')
    expect(isValidExpiryDate('', now)).toBe(true) // 空 = 永不过期
    expect(isValidExpiryDate('2026/12/01', now)).toBe(false) // 非 YYYY-MM-DD
  })

  it('isHttpEndpoint：带 hash 片段的地址不接受', () => {
    expect(isHttpEndpoint('https://host/v1#frag')).toBe(false)
    expect(isHttpEndpoint('https://host')).toBe(true)
  })
})

describe('i18n.js：locale 解析', () => {
  // ⚠️ `isObject(locale)` 为真（language-option 存的是 JSON 对象）的分支在源文件
  // 第 27 行是不可达的：第 9 行 `locale.substring(0, 2)` 会在模块加载期先炸
  // （JSON 解析不出函数，对象没有 substring），模块根本活不到第 26 行。
  // 这里验证该行为本身：对象 locale → 导入即抛错（与线上「坏配置」表现一致）。
  it('language-option 是对象：模块加载期就失败（第 26 行分支不可达）', async () => {
    window.localStorage.setItem('language-option', JSON.stringify({ value: 'zh-CN' }))
    vi.resetModules()
    await expect(import('@/app/i18n/i18n.js')).rejects.toThrow(/substring/)
    // 恢复成字符串配置，确认默认路径下 isGlobalZh 为真（zh-CN）
    window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
    vi.resetModules()
    const mod = await import('@/app/i18n/i18n.js')
    expect(mod.isGlobalZh).toBe(true)
    expect(mod.locale).toBe('zh-CN') // 导出的 locale 是原始配置；i18n 实例取前两位
  })
})

describe('useChatSession.togglePin：空目标 id 直接返回', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('togglePin("")：不落盘、不报错', async () => {
    const selectedWorkflowId = ref('wf-pin')
    const apiRef = {}
    const wrapper = await mountWithPlugins({
      name: 'PinProbe',
      setup () {
        Object.assign(apiRef, useChatSession(selectedWorkflowId))
        return () => h('div')
      }
    }, { router: null })
    await flush()

    apiRef.togglePin('')
    await flush()
    // 没有会话数据被写进 localStorage
    expect(window.localStorage.getItem('ragstudio:chat:sessions:wf-pin')).toBeNull()
    wrapper.unmount()
  })
})

describe('算子 Node.vue：无 variables 时挂载即 emit initCardHandle', () => {
  /** 与 test_wn_nodeCards 同款假 X6 节点。 */
  function makeNode ({ id = 'node-1', shape, label = '' } = {}) {
    const handlers = {}
    const modelHandlers = {}
    return {
      id,
      shape,
      store: { data: { label, inputVariables: [], data: {} } },
      model: {
        on: (name, fn) => { (modelHandlers[name] = modelHandlers[name] || []).push(fn) },
        off: vi.fn(),
        getEdges: vi.fn(() => []),
        getCell: () => null
      },
      on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn) },
      handlers,
      modelHandlers
    }
  }

  async function mountNodeCard (component, node) {
    const wrapper = await mountWithPlugins(component, {
      route: '/flow',
      global: { provide: { getNode: () => node } }
    })
    await flush()
    return wrapper
  }

  beforeEach(() => {
    window.aipVueInstance.$t = key => key
    kbNamesModule.map = {}
  })

  const CASES = [
    [PostretrieverNode, 'POST_RETRIEVER', 'postretriever'],
    [RetrieverNode, 'RETRIEVER', 'retriever'],
    [ResponsesynthesizerNode, 'RESPONSE_SYNTHESIZER', 'responsesynthesizer']
  ]

  it.each(CASES)('%s：无 variables → initCardHandle 上抛默认变量与节点 id', async (component, shape, variablesKey) => {
    const wrapper = await mountNodeCard(component, makeNode({ id: `init-${shape}`, shape }))
    const emitted = wrapper.emitted('initCardHandle')
    expect(emitted).toHaveLength(1)
    const [payload] = emitted[0]
    expect(payload.id).toBe(`init-${shape}`)
    expect(payload.componentType).toBe(shape)
    expect(payload.inputVariables).toEqual([])
    // 各模块都给了默认变量（键为模块名小写）
    expect(Object.keys(payload.variables)).toEqual([variablesKey])
    wrapper.unmount()
  })
})
