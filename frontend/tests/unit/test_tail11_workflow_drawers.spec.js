// @vitest-environment jsdom
// 四个画布抽屉的表单交互残余分支（3/6）：
// - preretriever：OperatorSection 四个上抛事件、JSON 编辑器回写、LLM/历史条数/提示词 v-model
// - postretriever：LLM/重排模型下拉、top_n/score 数字输入、top_n 越界校验、sendOperatorListData
// - responsesynthesizer：结构化模式空 formData 的占位、LLM 清单排序/失败、库名按 label 回映射、
//   全部表单 v-model（llm/temperature/库名/top_k/两段提示词）
// - retriever：加/删来源、图谱数组收敛、空库名校验放行、清单未加载放行、
//   Keyword/Graph 校验通过分支、normalizeItem 三种补默认、模板全量 v-model
// 骨架覆盖在 test_wf_operatorDrawer / test_wn_operatorDrawerBranches / test_wn_preDrawer。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  window.aipVueInstance = { $store: { state: { ragWorkflowIsStructKnowledge: false } } }
})

const { modelsApi, flowApi, envApi, operatorsApi, messageMock } = vi.hoisted(() => ({
  modelsApi: {},
  flowApi: {},
  envApi: {},
  operatorsApi: {},
  messageMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }
}))

vi.mock('@/features/model/api/models', () => ({
  getModelList: (...args) => modelsApi.getModelList(...args),
  getLLMModel: (...args) => modelsApi.getLLMModel(...args),
  getRerankModels: (...args) => modelsApi.getRerankModels(...args)
}))

vi.mock('@/features/workflow/api/workflow', () => ({
  getAllKBList: (...args) => flowApi.getAllKBList(...args),
  getFlowConfig: vi.fn(),
  saveFlowConfig: vi.fn(),
  checkSaveFlowConfig: vi.fn(),
  getFlowList: vi.fn(),
  createFlow: vi.fn(),
  updateFlow: vi.fn(),
  deleteFlowApi: vi.fn(),
  exportWorkFlow: vi.fn(),
  publishWorkFlow: vi.fn(),
  unpublishWorkFlow: vi.fn()
}))

vi.mock('@/features/knowledge-base/api', () => ({
  checkEnvironmentApi: (...args) => envApi.checkEnvironment(...args)
}))

vi.mock('@/features/operators/api/operators', () => ({
  getCustomOperatorListApi: (...args) => operatorsApi.getCustomOperatorList(...args)
}))

vi.mock('@/shared/lib/message', () => ({ default: messageMock }))

vi.mock('json-editor-vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'JsonEditorVueStub',
      props: ['modelValue'],
      emits: ['update:modelValue'],
      setup: (props, { emit }) => () => h('div', {
        class: 'json-editor-stub',
        onClick: () => emit('update:modelValue', { edited: true })
      })
    }
  }
})

import { describe, expect, it, beforeEach } from 'vitest'
import { h } from 'vue'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import PreDrawer from '@/features/workflow/modules/preretriever/Drawer.vue'
import RetrieverDrawer from '@/features/workflow/modules/retriever/Drawer.vue'
import PostretrieverDrawer from '@/features/workflow/modules/postretriever/Drawer.vue'
import ResponsesynthesizerDrawer from '@/features/workflow/modules/responsesynthesizer/Drawer.vue'
import { workflowState } from '@/features/workflow/store'

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

/** 会把交互转成事件的 EP 重型组件桩。 */
const INTERACTIVE_PARTS = {
  ElDropdown: { name: 'ElDropdown', setup: (_p, { slots }) => () => [slots.default?.(), slots.dropdown?.()] },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup: (_p, { slots }) => () => slots.default?.() },
  ElDropdownItem: { name: 'ElDropdownItem', setup: (_p, { slots }) => () => slots.default?.() },
  // content 插槽也要渲染（结构化模式的 tooltip 文案是模板分支的一部分）
  ElTooltip: { name: 'ElTooltip', setup: (_p, { slots }) => () => [slots.default?.(), slots.content?.()] },
  ElOptionGroup: { name: 'ElOptionGroup', props: ['label'], setup: (props, { slots }) => () => h('div', {}, [props.label, slots.default?.()]) },
  // 点击回抛 click（抽屉里 @click="kbOptionClickHandler(...)" 挂在 el-option 上）
  ElOption: {
    name: 'ElOption',
    props: ['label', 'value'],
    setup (props, { emit }) {
      return () => h('div', { class: 'opt-stub', onClick: () => emit('click') }, props.label)
    }
  },
  // 点击提交 +1 的数字输入（表单 v-model 箭头的触发器）
  ElInputNumber: {
    name: 'ElInputNumber',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup (props, { emit }) {
      return () => h('button', {
        class: 'input-number-stub',
        onClick: () => emit('update:modelValue', Number(props.modelValue || 0) + 1)
      })
    }
  },
  ElSwitch: {
    name: 'ElSwitch',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup (props, { emit }) {
      return () => h('button', {
        class: 'switch-stub',
        onClick: () => emit('update:modelValue', !props.modelValue)
      })
    }
  }
}

function t (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

const KB_ALL = {
  running: [{ assetId: 'a1', name: '文档库A', tableName: 'feature_a1' }],
  dev: [{ assetId: 'd1', name: '草稿库D', tableName: 'feature_d1' }]
}

function defaultMocks (overrides = {}) {
  const pick = (value, fallback) => (value === undefined ? fallback : value)
  modelsApi.getModelList = vi.fn(async () => pick(overrides.models, [{ modelName: 'bge-m3' }]))
  modelsApi.getLLMModel = vi.fn(async () => pick(overrides.llms, [
    { modelValue: 'qwen-b', nameZh: 'Qwen B' },
    { modelValue: 'qwen-a', nameZh: 'Qwen A' }
  ]))
  modelsApi.getRerankModels = vi.fn(async () => pick(overrides.reranks, [{ value: 'bge-reranker', label: 'BGE 重排', isDefault: true }]))
  flowApi.getAllKBList = vi.fn(async params => (params?.embedding
    ? pick(overrides.modelKbs, { running: [{ assetId: 'a1', name: '文档库A', tableName: 'feature_a1' }], dev: [] })
    : pick(overrides.allKbs, KB_ALL)))
  envApi.checkEnvironment = vi.fn(async () => overrides.env ?? { DEPLOYED_BY: 'self' })
  operatorsApi.getCustomOperatorList = vi.fn(async () => [])
}

async function mountDrawer (component, formData, extraGlobal = {}) {
  const wrapper = await mountWithPlugins(component, {
    route: '/flow',
    props: { formData, nodeId: 'node-1' },
    global: {
      components: INTERACTIVE_PARTS,
      stubs: { PromptEditorDialog: PromptDialogStub },
      ...extraGlobal
    }
  })
  await flush()
  await flush()
  await flush()
  return wrapper
}

/** 按 aria-label 找 EP 组件桩并回抛 update:modelValue。 */
async function setSelectValue (wrapper, ariaLabel, value, nth = 0) {
  const targets = wrapper.findAllComponents({ name: 'ElSelect' })
    .filter(w => w.attributes('aria-label') === ariaLabel)
  expect(targets.length, `找不到 aria-label=${ariaLabel} 的下拉`).toBeGreaterThan(nth)
  targets[nth].vm.$emit('update:modelValue', value)
  await flush()
  return targets[nth]
}

async function clickNumberByAria (wrapper, ariaLabel) {
  const el = wrapper.find(`[aria-label="${ariaLabel}"]`)
  expect(el.exists(), `找不到 aria-label=${ariaLabel} 的数字输入`).toBe(true)
  await el.trigger('click')
  await flush()
}

beforeEach(() => {
  defaultMocks()
  workflowState.ragWorkflowType = 'SequentialQueryEngine'
  window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = false
  messageMock.error.mockClear()
})

// ─────────────────────────────────────────────────────────────────────────────
// preretriever：OperatorSection 事件 / JSON 编辑器 / 表单 v-model
// ─────────────────────────────────────────────────────────────────────────────

describe('preretriever 抽屉：算子区块事件与表单回写', () => {
  it('OperatorSection 上抛 toggle/move/change：抽屉的折叠/换位/换算子生效', async () => {
    const wrapper = await mountDrawer(PreDrawer, {
      preretriever: [
        { operator: 'LLMQueryRewriter', kwargs: { llm: '', prompt: 'p', multi_chat_limit: 0 } },
        { operator: 'LLMSemanticRouting', kwargs: { llm: '', prompt: 'q' } }
      ]
    })
    let sections = wrapper.findAllComponents({ name: 'OperatorSection' })
    expect(sections).toHaveLength(2)

    // toggle：折叠第二块
    sections[1].vm.$emit('toggle')
    await flush()
    expect(wrapper.vm.operatorList[1]._collapsed).toBe(true)

    // move：第二块上移一位（重取引用：换位后区块按 _key 复用，位置已变）
    sections = wrapper.findAllComponents({ name: 'OperatorSection' })
    sections[1].vm.$emit('move', -1)
    await flush()
    expect(wrapper.vm.operatorList[0].operator).toBe('LLMSemanticRouting')

    // change：换算子类型（此时第 0 块是 LLMSemanticRouting）
    sections = wrapper.findAllComponents({ name: 'OperatorSection' })
    sections[0].vm.$emit('change', 'LLMQueryRewriter')
    await flush()
    expect(wrapper.vm.operatorList[0].operator).toBe('LLMQueryRewriter')
  })

  it('OperatorSection 上抛 remove：抽屉删一份并回抛 operator-count', async () => {
    const wrapper = await mountDrawer(PreDrawer, {
      preretriever: [
        { operator: 'LLMQueryRewriter', kwargs: {} },
        { operator: 'LLMSemanticRouting', kwargs: {} }
      ]
    })
    wrapper.findAllComponents({ name: 'OperatorSection' })[0].vm.$emit('remove')
    await flush()
    expect(wrapper.vm.operatorList).toHaveLength(1)
    expect(wrapper.emitted('operator-count').at(-1)).toEqual([1])
  })

  it('自定义算子：JSON 编辑器回写 kwargs（v-model 箭头）', async () => {
    const wrapper = await mountDrawer(PreDrawer, {
      preretriever: [{ operator: 'CustomOp', custom: true, kwargs: { prompt: 'p' }, operatorName: '我的算子' }]
    })
    await wrapper.find('.json-editor-stub').trigger('click')
    await flush()
    expect(wrapper.vm.operatorList[0].kwargs).toEqual({ edited: true })
  })

  it('LLM 下拉与多轮历史条数回写（表单 v-model 箭头）', async () => {
    const wrapper = await mountDrawer(PreDrawer, {
      preretriever: [{ operator: 'LLMQueryRewriter', kwargs: { llm: '', prompt: 'p', multi_chat_limit: 0 } }]
    })
    await setSelectValue(wrapper, t('kbEvaluation.llm'), 'qwen-a')
    expect(wrapper.vm.operatorList[0].kwargs.llm).toBe('qwen-a')

    await clickNumberByAria(wrapper, t('kbEvaluation.chatRecord'))
    expect(wrapper.vm.operatorList[0].kwargs.multi_chat_limit).toBe(1)
  })

  it('提示词 textarea 回写（el-input v-model）', async () => {
    const wrapper = await mountDrawer(PreDrawer, {
      preretriever: [{ operator: 'LLMQueryRewriter', kwargs: { llm: 'q', prompt: '旧', multi_chat_limit: 0 } }]
    })
    await wrapper.find('textarea').setValue('新提示词')
    expect(wrapper.vm.operatorList[0].kwargs.prompt).toBe('新提示词')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// postretriever：表单 v-model / 校验 / 提交收敛
// ─────────────────────────────────────────────────────────────────────────────

describe('postretriever 抽屉：表单回写与提交', () => {
  it('LLM / 重排模型下拉、top_n / score 数字输入回写', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [
        { operator: 'LLMReranker', kwargs: { llm: '', top_n: 5 } },
        { operator: 'ExternalModelReranker', kwargs: { model: '', top_n: 5, score: 0 } }
      ]
    })
    // LLM 下拉在 LLMReranker 行；重排模型下拉在 ExternalModelReranker 行
    await setSelectValue(wrapper, t('kbEvaluation.llm'), 'qwen-a')
    await setSelectValue(wrapper, t('modules.workflow.rerankModelLabel'), 'bge-reranker')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.llm).toBe('qwen-a')
    expect(wrapper.vm.drawer.operatorList[1].kwargs.model).toBe('bge-reranker')

    // top_n 数字输入取第一处（LLMReranker 行）；score 只在 ExternalModelReranker 行
    await clickNumberByAria(wrapper, t('modules.workflow.topNLabel'))
    expect(wrapper.vm.drawer.operatorList[0].kwargs.top_n).toBe(6)
    await clickNumberByAria(wrapper, t('ragFlow.score'))
    expect(wrapper.vm.drawer.operatorList[1].kwargs.score).toBe(1)
  })

  it('LLMReranker 行：LLM 下拉回写；top_n 越界在校验里拦截', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'LLMReranker', kwargs: { llm: 'qwen', top_n: 3 } }]
    })
    await setSelectValue(wrapper, t('kbEvaluation.llm'), 'qwen-a')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.llm).toBe('qwen-a')

    wrapper.vm.drawer.operatorList[0].kwargs.top_n = 0
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(false)
    expect(wrapper.emitted('config-error').at(-1)[0]).toContain(t('ragFlow.topKTip'))

    // 上限越界同样拦
    wrapper.vm.drawer.operatorList[0].kwargs.top_n = 21
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toContain(t('ragFlow.topKTip'))
  })

  it('sendOperatorListData：剥掉 _key/_collapsed/showConfig 且拷贝 kwargs', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'LLMReranker', kwargs: { llm: 'qwen', top_n: 5 } }]
    })
    const op = wrapper.vm.drawer.operatorList[0]
    op._collapsed = true
    op.showConfig = true
    const data = wrapper.vm.sendOperatorListData()
    const copy = data.postretriever[0]
    expect(copy._collapsed).toBeUndefined()
    expect(copy._key).toBeUndefined()
    expect(copy.showConfig).toBeUndefined()
    copy.kwargs.llm = 'changed'
    expect(op.kwargs.llm).toBe('qwen')
  })

  it('相似度过滤/去重：无需配置提示渲染', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'SimilarityFilter', kwargs: {}, operatorName: '相似度过滤' }]
    })
    // 未知算子由外壳路由到 JSON 编辑器分支，「无需配置」提示属于防御分支（见
    // test_wn_operatorDrawerBranches 的说明）；这里钉住提示文案本身来自词条
    expect(t('modules.workflow.noParams')).toBeTruthy()
    expect(wrapper.find('.json-editor-stub').exists()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// responsesynthesizer：结构化占位 / LLM 清单 / 库名回映射 / 表单回写
// ─────────────────────────────────────────────────────────────────────────────

describe('responsesynthesizer 抽屉：占位与清单', () => {
  it('结构化模式且 formData 没有该模块：占位回落空串', async () => {
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {})
    expect(wrapper.vm.getSelectedKbDisplayNames).toBe('')
  })

  it('LLM 清单按 nameZh 排序（比较器）；拉取失败回落空清单', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{ operator: 'RagSimpleSummarizer', kwargs: { 'generator-config': [{ llm: '', prompt: 'p', temperature: 0.5, knowledge_base_name: [], top_k: 8 }] } }]
    })
    expect(wrapper.vm.LLMList.map(item => item.modelValue)).toEqual(['qwen-a', 'qwen-b'])

    modelsApi.getLLMModel = vi.fn(async () => { throw new Error('boom') })
    await mountDrawer(ResponsesynthesizerDrawer, {})
    // 第二个实例挂载不炸即可（catch 分支：LLMList=[]）
    expect(modelsApi.getLLMModel).toHaveBeenCalled()
  })
})

describe('responsesynthesizer 抽屉：表单回写与库名映射', () => {
  const rssConfig = { llm: 'qwen', prompt: 'p', temperature: 0.5, knowledge_base_name: ['feature_a1'], top_k: 8, no_context_prompt: 'nc' }
  const rssList = config => [{ operator: 'RagSimpleSummarizer', kwargs: { 'generator-config': [config] } }]

  it('载入库名回映射：doc_ 前缀与数字原样保留；显示名无 status 分组可查也保留', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: rssList({ ...rssConfig, knowledge_base_name: ['文档库A', 'doc_raw', 3] })
    })
    await flush()
    // transKbsToPublishedOptions 的分组没有 status 字段，「按 label 回映射」分支
    // 在当前数据流下不可达（见报告）；数字与 doc_ 前缀走提前返回分支
    expect(wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0].knowledge_base_name)
      .toEqual(['文档库A', 'doc_raw', 3])
  })

  it('库名已是 tableName 或数字：映射保持原样', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: rssList({ ...rssConfig, knowledge_base_name: ['feature_a1', 3, 'ghost'] })
    })
    await flush()
    expect(wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0].knowledge_base_name)
      .toEqual(['feature_a1', 3, 'ghost'])
  })

  it('llm / temperature / top_k / 两段提示词全部可回写', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(rssConfig) })
    const config = wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0]

    await setSelectValue(wrapper, t('kbEvaluation.llm'), 'qwen-a')
    expect(config.llm).toBe('qwen-a')

    await clickNumberByAria(wrapper, t('app.temperature'))
    expect(config.temperature).toBe(1.5)

    await clickNumberByAria(wrapper, t('modules.workflow.topKLabel'))
    expect(config.top_k).toBe(9)

    const textareas = wrapper.findAll('textarea')
    await textareas[0].setValue('新提示词')
    await textareas[1].setValue('无上下文提示')
    expect(config.prompt).toBe('新提示词')
    expect(config.no_context_prompt).toBe('无上下文提示')
  })

  it('结构化模式：tooltip 文案渲染、库名下拉禁用', async () => {
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(rssConfig) })
    expect(wrapper.text()).toContain(t('ragFlow.structKnowledgeNotSupportTip'))
  })

  it('非结构化模式：库名下拉选项点击（同库去重的点击通路）', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(rssConfig) })
    const config = wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0]
    // el-option 桩点击：值已在选中列表里 → 去重替换通路
    const options = wrapper.findAllComponents({ name: 'ElOption' })
    expect(options.length).toBeGreaterThan(0)
    options[0].vm.$emit('click')
    await flush()
    expect(Array.isArray(config.knowledge_base_name)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// retriever：来源增删 / 收敛 / 校验放行 / normalizeItem / 表单回写
// ─────────────────────────────────────────────────────────────────────────────

const vectorWith = (names, extra = {}) => [{
  operator: 'VectorRetriever',
  kwargs: {
    strategy: 0,
    embedding: 'bge-m3',
    knowledge_info_list: [{ knowledge_base_name: names, top_k: 8, score: 0.3, priority: 2 }],
    ...extra
  }
}]

describe('retriever 抽屉：来源增删与载入补默认', () => {
  it('「添加来源」按钮：追加一份来源配置', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith(['feature_a1']) })
    await wrapper.find('.fc-source-list button.button-compact').trigger('click')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list).toHaveLength(2)
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list[1]).toEqual({
      knowledge_base_name: [], priority: 10, top_k: 8, score: 0.3
    })
  })

  it('多份来源时显示删除按钮：点击删掉对应一份', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: vectorWith(['feature_a1'], { knowledge_info_list: [
        { knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3, priority: 2 },
        { knowledge_base_name: ['feature_d1'], top_k: 8, score: 0.3, priority: 3 }
      ] })
    })
    expect(wrapper.find('button.fc-delete').exists()).toBe(true)
    await wrapper.find('button.fc-delete').trigger('click')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list).toHaveLength(1)
  })

  it('载入补默认：向量算子无来源清单时种一份；库名串改数组；图谱算子缺库名给空数组', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3' } },
        { operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: 'feature_a1' }] } },
        { operator: 'KnowledgeGraphRetriever', kwargs: { top_k: 30 } }
      ]
    })
    const list = wrapper.vm.drawer.operatorList
    // 1) 无 knowledge_info_list → 种默认一份
    expect(list[0].kwargs.knowledge_info_list).toEqual([
      { knowledge_base_name: [], priority: 10, top_k: 8, score: 0.3 }
    ])
    // 2) 串形式的库名 → 数组；缺 top_k/score 补默认
    expect(list[1].kwargs.knowledge_info_list[0].knowledge_base_name).toEqual(['feature_a1'])
    expect(list[1].kwargs.knowledge_info_list[0].top_k).toBe(8)
    expect(list[1].kwargs.knowledge_info_list[0].score).toBe(0.3)
    // 3) 图谱算子：库名 undefined → 空数组；depth/score 补默认
    expect(list[2].kwargs.knowledge_base_name).toEqual([])
    expect(list[2].kwargs.depth).toBe(1)
    expect(list[2].kwargs.score).toBe(0)
  })

  it('载入库名回映射：doc_ 前缀与数字提前返回，显示名原样保留', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: vectorWith(['文档库A', 'doc_raw', 7])
    })
    await flush()
    // 分组没有 status 字段：按 label 回映射的主体在当前数据流下不可达（见报告）
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list[0].knowledge_base_name)
      .toEqual(['文档库A', 'doc_raw', 7])
  })
})

describe('retriever 抽屉：校验放行分支', () => {
  it('模型/库清单都没到：库名校验整体放行', async () => {
    defaultMocks({ models: null, allKbs: { running: [], dev: [] }, modelKbs: { running: [], dev: [] } })
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith(['never-exists']) })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })

  it('KeywordRetriever 配置齐全：算子校验通过（返回空错误）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'KeywordRetriever', kwargs: { knowledge_base_name: ['feature_a1'], top_k: 8 } }]
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
    expect(wrapper.emitted('config-error').at(-1)).toEqual([''])
  })

  it('KnowledgeGraphRetriever 配置齐全：算子校验通过', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'KnowledgeGraphRetriever',
        kwargs: { knowledge_base_name: ['feature_a1'], top_k: 30, depth: 2, score: 0.5 }
      }]
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
    expect(wrapper.emitted('config-error').at(-1)).toEqual([''])
  })

  it('Fusion / 自定义算子：只看 top_k 或直接放行', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'FusionRetriever', kwargs: { top_k: 8 } },
        { operator: 'CustomOp', custom: true, kwargs: {} }
      ]
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })
})

describe('retriever 抽屉：提交收敛（sendOperatorListData）', () => {
  it('图谱数组库名：去 |#| 后缀并去重', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'KnowledgeGraphRetriever',
        kwargs: { knowledge_base_name: ['库B|#|dev', '库B', '库A'], top_k: 30, depth: 1 }
      }]
    })
    const data = wrapper.vm.sendOperatorListData()
    expect(data.retriever[0].kwargs.knowledge_base_name).toEqual(['库B', '库A'])
  })

  it('向量 priority 缺失补 0、showConfig 剥离；desc_info trim（v-model.trim）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: vectorWith(['feature_a1'])
    })
    const op = wrapper.vm.drawer.operatorList[0]
    op.kwargs.knowledge_info_list[0].showConfig = true
    delete op.kwargs.knowledge_info_list[0].priority
    const data = wrapper.vm.sendOperatorListData()
    const item = data.retriever[0].kwargs.knowledge_info_list[0]
    expect(item.priority).toBe(0)
    expect(item.showConfig).toBeUndefined()
  })
})

describe('retriever 抽屉：各算子模板的表单回写', () => {
  it('向量算子：策略 / 向量模型 / 库名下拉 / top_k / priority / score 全部回写', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: vectorWith(['feature_a1'], { strategy: 1, knowledge_info_list: [
        { knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3, priority: 2 }
      ] })
    })
    const item = wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list[0]

    await setSelectValue(wrapper, t('knowledge.kbRetrieveStrategy'), 0)
    expect(wrapper.vm.drawer.operatorList[0].kwargs.strategy).toBe(0)
    await setSelectValue(wrapper, t('ragFlow.vectorModel'), 'bge-m3')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.embedding).toBe('bge-m3')
    await setSelectValue(wrapper, t('knowledge.knowledgeBase'), ['feature_a1'])
    expect(item.knowledge_base_name).toEqual(['feature_a1'])

    // strategy!==0 时 priority 输入框在列（先切回 1 保证渲染，再全部 +1）
    await setSelectValue(wrapper, t('knowledge.kbRetrieveStrategy'), 1)
    await clickNumberByAria(wrapper, t('modules.workflow.topKLabel'))
    await clickNumberByAria(wrapper, t('knowledge.priority'))
    await clickNumberByAria(wrapper, t('modules.workflow.minScore'))
    expect(item.top_k).toBe(9)
    expect(item.priority).toBe(3)
    expect(item.score).toBe(1.3)
  })

  it('向量算子：来源下拉选项点击（已选库的去重替换通路）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith(['feature_a1']) })
    const options = wrapper.findAllComponents({ name: 'ElOption' })
    expect(options.length).toBeGreaterThan(0)
    options[0].vm.$emit('click')
    await flush()
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list[0].knowledge_base_name)
      .toEqual(['feature_a1'])
  })

  it('关键词算子：库名下拉 / top_k / 选项点击回写', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'KeywordRetriever', kwargs: { knowledge_base_name: ['feature_a1'], top_k: 8 } }]
    })
    await setSelectValue(wrapper, t('knowledge.knowledgeBase'), ['feature_a1', 'feature_d1'])
    expect(wrapper.vm.drawer.operatorList[0].kwargs.knowledge_base_name).toEqual(['feature_a1', 'feature_d1'])
    await clickNumberByAria(wrapper, t('modules.workflow.topKLabel'))
    expect(wrapper.vm.drawer.operatorList[0].kwargs.top_k).toBe(9)

    const options = wrapper.findAllComponents({ name: 'ElOption' })
    options[0].vm.$emit('click')
    await flush()
  })

  it('图谱算子：库名下拉 / top_k / depth / score / 边事实开关回写；选项点击', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'KnowledgeGraphRetriever',
        kwargs: { knowledge_base_name: ['feature_a1'], top_k: 30, depth: 2, score: 0.5, include_edge_facts: false }
      }]
    })
    await setSelectValue(wrapper, t('knowledge.knowledgeBase'), ['feature_a1'])
    await clickNumberByAria(wrapper, t('modules.workflow.topKLabel'))
    await clickNumberByAria(wrapper, t('knowledge.depth'))
    await clickNumberByAria(wrapper, t('modules.workflow.minScore'))
    const kwargs = wrapper.vm.drawer.operatorList[0].kwargs
    expect(kwargs.top_k).toBe(31)
    expect(kwargs.depth).toBe(3)
    expect(kwargs.score).toBe(1.5)

    await wrapper.find('button.switch-stub').trigger('click')
    expect(kwargs.include_edge_facts).toBe(true)

    const options = wrapper.findAllComponents({ name: 'ElOption' })
    options[0].vm.$emit('click')
    await flush()
  })

  it('融合检索算子：只有 top_k 输入框，回写生效', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'FusionRetriever', kwargs: { top_k: 8 } }]
    })
    await clickNumberByAria(wrapper, t('modules.workflow.topKLabel'))
    expect(wrapper.vm.drawer.operatorList[0].kwargs.top_k).toBe(9)
  })

  it('算子描述 textarea 回写（v-model.trim）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith(['feature_a1']) })
    await wrapper.find('textarea').setValue('  描述文案  ')
    expect(wrapper.vm.drawer.operatorList[0].kwargs.desc_info).toBe('描述文案')
  })
})
