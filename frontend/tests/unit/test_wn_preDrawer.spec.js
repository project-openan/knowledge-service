// @vitest-environment jsdom
// preretriever/Drawer.vue：0% 文件整体补齐。它是四个抽屉里唯一不走
// useOperatorDrawer 骨架的（自带列表状态），载入/新增/换算子/校验/提交/大编辑器
// 全在文件内。LLM 拉取换桩，PromptEditorDialog 用可发 confirm 的占位件。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  window.aipVueInstance = { $store: { state: { ragWorkflowIsStructKnowledge: false } } }
})

const { modelsApi, operatorsApi } = vi.hoisted(() => ({ modelsApi: {}, operatorsApi: {} }))

vi.mock('@/features/model/api/models', () => ({
  getModelList: vi.fn(),
  getLLMModel: (...args) => modelsApi.getLLMModel(...args),
  getRerankModels: vi.fn()
}))

vi.mock('@/features/operators/api/operators', () => ({
  getCustomOperatorListApi: (...args) => operatorsApi.getCustomOperatorList(...args)
}))

vi.mock('json-editor-vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'JsonEditorVueStub',
      props: ['modelValue', 'mode', 'stringified', 'mainMenuBar'],
      emits: ['update:modelValue'],
      setup (props, { emit }) {
        return () => h('div', {
          class: 'json-editor-stub',
          onClick: () => emit('update:modelValue', { edited: true })
        })
      }
    }
  }
})

import { describe, expect, it, beforeEach } from 'vitest'
import { h } from 'vue'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import PreDrawer from '@/features/workflow/modules/preretriever/Drawer.vue'

/** PromptEditorDialog 占位件：confirm 按钮把编辑文本抛回抽屉。 */
const PromptDialogStub = {
  name: 'PromptEditorDialog',
  props: ['modelValue', 'text', 'subtitle'],
  emits: ['update:modelValue', 'confirm'],
  setup (props, { emit }) {
    return () => props.modelValue
      ? [
          h('span', { class: 'prompt-subtitle' }, props.subtitle),
          h('button', {
            class: 'confirm-prompt',
            onClick: () => {
              emit('confirm', `${props.text}!`)
              emit('update:modelValue', false)
            }
          })
        ]
      : null
  }
}

const DROPDOWN_PARTS = {
  ElDropdown: { name: 'ElDropdown', setup: (_p, { slots }) => () => [slots.default?.(), slots.dropdown?.()] },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', setup: (_p, { slots }) => () => slots.default?.() }
}

function t (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

async function mountPreDrawer (list = [], extraGlobal = {}) {
  const wrapper = await mountWithPlugins(PreDrawer, {
    route: '/flow',
    props: { formData: { preretriever: list }, nodeId: 'node-1' },
    global: { components: DROPDOWN_PARTS, stubs: { PromptEditorDialog: PromptDialogStub }, ...extraGlobal }
  })
  await flush()
  await flush()
  return wrapper
}

beforeEach(() => {
  modelsApi.getLLMModel = vi.fn(async () => [{ modelValue: 'qwen-b', nameZh: 'Qwen B' }, { modelValue: 'qwen-a', nameZh: 'Qwen A' }])
  operatorsApi.getCustomOperatorList = vi.fn(async () => [])
})

describe('preretriever 抽屉：载入与列表操作', () => {
  it('挂载：补 llm/prompt 默认值，LLM 清单按 modelValue 排序渲染', async () => {
    const wrapper = await mountPreDrawer([{ operator: 'LLMQueryRewriter', kwargs: {} }])
    const op = wrapper.vm.operatorList[0]
    expect(op.kwargs.llm).toBe('')
    expect(op.kwargs.prompt).toBeTruthy()
    expect(wrapper.emitted('operator-count')[0]).toEqual([1])
    // LLM 清单按 modelValue 升序（下拉选项自闭合无插槽文案，经 vm 断言）
    expect(wrapper.vm.LLMList.map(item => item.modelValue)).toEqual(['qwen-a', 'qwen-b'])
  })

  it('LLMSemanticRouting 缺 prompt 用语义路由默认提示词', async () => {
    const wrapper = await mountPreDrawer([{ operator: 'LLMSemanticRouting', kwargs: {} }])
    expect(wrapper.vm.operatorList[0].kwargs.prompt).toBeTruthy()
  })

  it('getLLMModel 挂了：LLM 清单回落空数组', async () => {
    modelsApi.getLLMModel = vi.fn(async () => 'not-an-array')
    const wrapper = await mountPreDrawer([])
    expect(wrapper.vm.LLMList).toEqual([])
  })

  it('getLLMModel 抛错：不炸抽屉', async () => {
    modelsApi.getLLMModel = vi.fn(async () => { throw new Error('boom') })
    const wrapper = await mountPreDrawer([])
    await flush()
    expect(wrapper.vm.LLMList).toEqual([])
  })

  it('addOperatorWithType：两种算子各自的 package/kwargs，id 带 nodeId', async () => {
    const wrapper = await mountPreDrawer([])
    wrapper.vm.addOperatorWithType('LLMQueryRewriter')
    wrapper.vm.addOperatorWithType('LLMSemanticRouting')
    const list = wrapper.vm.operatorList
    expect(list).toHaveLength(2)
    expect(list[0].id).toMatch(/^node-1_[0-9a-f]{3}$/)
    expect(list[0].package).toContain('query_rewrite')
    expect(list[0].kwargs.multi_chat_limit).toBe(0)
    expect(list[1].package).toContain('query_routing')
    expect(wrapper.emitted('operator-count').at(-1)).toEqual([2])
  })

  it('changeOperator：换 id 换 package/kwargs；同 id 或空 id 不动', async () => {
    const wrapper = await mountPreDrawer([{ operator: 'LLMQueryRewriter', kwargs: { llm: 'q', prompt: 'p' } }])
    const op = wrapper.vm.operatorList[0]
    wrapper.vm.changeOperator(op, '')
    wrapper.vm.changeOperator(op, 'LLMQueryRewriter')
    expect(op.kwargs.prompt).toBe('p')

    wrapper.vm.changeOperator(op, 'LLMSemanticRouting')
    expect(op.operator).toBe('LLMSemanticRouting')
    expect(op.package).toContain('query_routing')
  })

  it('move / remove：越界不动，至少保留一个', async () => {
    const wrapper = await mountPreDrawer([
      { operator: 'LLMQueryRewriter', kwargs: {} },
      { operator: 'LLMSemanticRouting', kwargs: {} }
    ])
    const list = wrapper.vm.operatorList
    const first = list[0]
    wrapper.vm.move(0, -1)
    expect(list[0]).toBe(first)
    wrapper.vm.move(0, 1)
    expect(list[1]).toBe(first)
    wrapper.vm.move(0, 99)
    expect(list[1]).toBe(first)

    wrapper.vm.remove(0)
    expect(list).toHaveLength(1)
    expect(wrapper.emitted('operator-count').at(-1)).toEqual([1])
    wrapper.vm.remove(0)
    expect(list).toHaveLength(1)
  })
})

describe('preretriever 抽屉：校验与提交', () => {
  it('缺大模型 / 空提示词 / 历史条数越界 各给一条错误并展开出错算子', async () => {
    const wrapper = await mountPreDrawer([{ operator: 'LLMQueryRewriter', kwargs: { llm: '', prompt: 'p', multi_chat_limit: 0 } }])
    const run = () => { const cb = vi.fn(); wrapper.vm.validate()(cb); return cb }
    const errorOf = () => wrapper.emitted('config-error').at(-1)[0]

    run()
    expect(errorOf()).toContain(t('ragFlow.llmTip'))

    const op = wrapper.vm.operatorList[0]
    op.kwargs.llm = 'qwen'
    op.kwargs.prompt = '   '
    run()
    expect(errorOf()).toContain(t('app.inputPrompt'))

    op.kwargs.prompt = 'ok'
    op.kwargs.multi_chat_limit = 9
    run()
    expect(errorOf()).toContain(t('modules.workflow.historyRange'))
    expect(op._collapsed).toBe(false)
    expect(run()).toBeFalsy // callback(false) 返回 undefined
  })

  it('multi_chat_limit 边界内通过；自定义算子放行', async () => {
    const wrapper = await mountPreDrawer([
      { operator: 'LLMQueryRewriter', kwargs: { llm: 'qwen', prompt: 'p', multi_chat_limit: 8 } },
      { operator: 'CustomOp', custom: true, kwargs: {}, operatorName: '我的算子' }
    ])
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
    expect(wrapper.emitted('config-error').at(-1)).toEqual([''])
  })

  it('sendOperatorListData：剥 UI 字段、拷贝 kwargs（改副本不动原件）', async () => {
    const source = [{ operator: 'LLMQueryRewriter', kwargs: { llm: 'qwen', prompt: 'p', multi_chat_limit: 1 } }]
    const wrapper = await mountPreDrawer(source)
    wrapper.vm.operatorList[0]._collapsed = true
    const data = wrapper.vm.sendOperatorListData()
    expect(Object.keys(data)).toEqual(['preretriever'])
    const copy = data.preretriever[0]
    expect(copy._key).toBeUndefined()
    expect(copy._collapsed).toBeUndefined()
    expect(copy.showConfig).toBeUndefined()
    expect(copy.kwargs).toEqual({ llm: 'qwen', prompt: 'p', multi_chat_limit: 1 })
    copy.kwargs.llm = 'changed'
    expect(wrapper.vm.operatorList[0].kwargs.llm).toBe('qwen')
  })
})

describe('preretriever 抽屉：提示词大编辑器', () => {
  it('expandPrompt 打开弹窗（副标题带显示名），confirm 回写对应字段', async () => {
    const wrapper = await mountPreDrawer([{ operator: 'LLMQueryRewriter', kwargs: { llm: 'qwen', prompt: '旧提示词', multi_chat_limit: 0 } }])
    const expandButtons = wrapper.findAll('button.fc-text-action')
    expect(expandButtons).toHaveLength(1)
    await expandButtons[0].trigger('click')
    expect(wrapper.find('.prompt-subtitle').exists()).toBe(true)
    expect(wrapper.find('.prompt-subtitle').text()).toContain(t('ragFlow.LLMQueryRewriterOperator'))
    expect(wrapper.find('.prompt-subtitle').text()).toContain(t('modules.workflow.fullPrompt'))

    await wrapper.find('button.confirm-prompt').trigger('click')
    expect(wrapper.vm.operatorList[0].kwargs.prompt).toBe('旧提示词!')
    expect(wrapper.find('.prompt-subtitle').exists()).toBe(false)
  })

  it('自定义/未知算子走 JSON 编辑器（没有表单区，也就没有展开入口）', async () => {
    const wrapper = await mountPreDrawer([
      { operator: 'CustomOp', custom: true, kwargs: { prompt: 'p' }, operatorName: '我的算子' }
    ])
    expect(wrapper.find('.json-editor-stub').exists()).toBe(true)
    expect(wrapper.find('.fc-prompt-field').exists()).toBe(false)
    expect(wrapper.findAll('button.fc-text-action')).toHaveLength(0)
  })
})
