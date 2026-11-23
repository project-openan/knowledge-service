// @vitest-environment jsdom
// 算子抽屉共享骨架：useOperatorDrawer（载入/列表操作/校验/提交）+ OperatorDrawerShell，
// 以及三个抽屉（retriever / postretriever / responsesynthesizer）的独有表单分支。
// 对外契约（defineExpose 的 validate / sendOperatorListData）一并钉住。
import { vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
  // 响应合成抽屉从 window.aipVueInstance 读全局 store（main.js 挂的）
  window.aipVueInstance = { $store: { state: { ragWorkflowIsStructKnowledge: false } } }
})

const { modelsApi, flowApi, kbApiModule, operatorsApi, envApi, messageMock } = vi.hoisted(() => ({
  modelsApi: {},
  flowApi: {},
  kbApiModule: {},
  operatorsApi: {},
  envApi: {},
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

// json-editor-vue 是重型编辑器：外壳只用它的 v-model 与 class
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
          'data-mode': props.mode,
          onClick: () => emit('update:modelValue', { edited: true })
        })
      }
    }
  }
})

import { describe, expect, it, beforeEach } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'
import OperatorDrawerShell from '@/features/workflow/modules/shared/OperatorDrawerShell.vue'
import RetrieverDrawer from '@/features/workflow/modules/retriever/Drawer.vue'
import PostretrieverDrawer from '@/features/workflow/modules/postretriever/Drawer.vue'
import ResponsesynthesizerDrawer from '@/features/workflow/modules/responsesynthesizer/Drawer.vue'
import { workflowState } from '@/features/workflow/store'

const KB_RESPONSE = {
  running: [{ assetId: 'a1', name: '已发布库', tableName: 'feature_a1' }],
  dev: [{ assetId: 'd1', name: '草稿库', tableName: 'feature_d1' }]
}

beforeEach(() => {
  modelsApi.getModelList = vi.fn(async () => [{ modelName: 'bge-m3' }])
  modelsApi.getLLMModel = vi.fn(async () => [{ modelValue: 'qwen', nameZh: 'Qwen' }])
  modelsApi.getRerankModels = vi.fn(async () => [{ value: 'bge-reranker', label: 'BGE 重排', isDefault: true }])
  flowApi.getAllKBList = vi.fn(async () => KB_RESPONSE)
  operatorsApi.getCustomOperatorList = vi.fn(async () => [])
  envApi.checkEnvironment = vi.fn(async () => ({ data: { env: 'dev' } }))
  workflowState.ragWorkflowType = 'SequentialQueryEngine'
})

/** 挂一个抽屉并等 onMounted 的载入链落地。 */
async function mountDrawer (component, formData, options = {}) {
  const wrapper = await mountWithPlugins(component, {
    route: '/flow',
    props: { formData, nodeId: 'node-1', ...(options.props || {}) },
    global: options.global
  })
  await flush()
  await flush()
  return wrapper
}

/** el-dropdown 系没有注册 popper：透明占位件把所有插槽摊平渲染。 */
const DROPDOWN_PARTS = {
  ElDropdown: {
    name: 'ElDropdown',
    setup (_props, { slots }) {
      return () => [slots.default?.(), slots.dropdown?.()]
    }
  },
  ElDropdownMenu: { name: 'ElDropdownMenu', setup (_props, { slots }) { return () => slots.default?.() } },
  ElDropdownItem: { name: 'ElDropdownItem', setup (_props, { slots }) { return () => slots.default?.() } },
  ElTooltip: {
    name: 'ElTooltip',
    setup (_props, { slots }) { return () => slots.default?.() }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OperatorDrawerShell：外壳渲染
// ─────────────────────────────────────────────────────────────────────────────

describe('OperatorDrawerShell：外壳渲染', () => {
  function fakeDrawer () {
    return {
      operatorList: [
        { _key: 'op-1', _collapsed: false, operator: 'VectorRetriever', kwargs: {} },
        { _key: 'op-2', _collapsed: true, operator: 'TotallyUnknown', custom: true, kwargs: { a: 1 } }
      ],
      builtinOperatorList: [{ id: 'KeywordRetriever', name: '关键词检索' }],
      disableAddOperator: false,
      isKnownOperator: operator => operator.operator === 'VectorRetriever',
      addOperatorWithType: vi.fn(),
      changeOperator: vi.fn(),
      move: vi.fn(),
      remove: vi.fn()
    }
  }

  it('标题带算子数；已知算子走插槽表单、未知/自定义走 JSON 编辑器', async () => {
    const drawer = fakeDrawer()
    const wrapper = await mountWithPlugins(OperatorDrawerShell, {
      route: '/flow',
      props: { drawer },
      global: {
        components: DROPDOWN_PARTS,
        stubs: { OperatorSection: { name: 'OperatorSectionStub', setup (_p, { slots }) { return () => slots.default?.() } } }
      }
    })
    await flush()
    const text = wrapper.text()
    expect(text).toContain('算子配置')
    expect(text).toContain('2') // 算子数
    expect(text).toContain('关键词检索') // 「新增算子」下拉项
    expect(wrapper.find('.json-editor-stub').exists()).toBe(true)
  })

  it('真 OperatorSection：已知算子渲默认插槽表单，暗色主题给 JSON 编辑器加暗色类', async () => {
    const drawer = {
      operatorList: [
        { _key: 'op-1', _collapsed: false, operator: 'VectorRetriever', kwargs: {} }
      ],
      builtinOperatorList: [{ id: 'KeywordRetriever', name: '关键词检索' }],
      disableAddOperator: false,
      isKnownOperator: operator => operator.operator === 'VectorRetriever',
      addOperatorWithType: vi.fn(),
      changeOperator: vi.fn(),
      move: vi.fn(),
      remove: vi.fn()
    }
    const wrapper = await mountWithPlugins(OperatorDrawerShell, {
      route: '/flow',
      props: { drawer },
      global: { components: DROPDOWN_PARTS }
    })
    await flush()
    // 已知算子：走 el-form 分支（默认插槽），不出现 JSON 编辑器
    expect(wrapper.find('.json-editor-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('算子配置')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 共享 composable（经 retriever 抽屉驱动：钩子最全）
// ─────────────────────────────────────────────────────────────────────────────

describe('useOperatorDrawer（retriever 抽屉）：载入与列表操作', () => {
  it('挂载：深拷贝 formData[retriever]、补 UI 字段、补默认值并去重库名', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'VectorRetriever',
        kwargs: {
          knowledge_info_list: [{ knowledge_base_name: ['库A', '库A', '库B'], top_k: undefined, score: undefined, priority: undefined }]
        }
      }]
    })
    const list = wrapper.vm.drawer.operatorList
    expect(list).toHaveLength(1)
    expect(list[0]._key).toBe('op-1')
    expect(list[0]._collapsed).toBe(false)
    const kbInfo = list[0].kwargs.knowledge_info_list[0]
    expect(kbInfo.knowledge_base_name).toEqual(['库A', '库B']) // uniqueKbNames 去重
    expect(kbInfo.top_k).toBe(8)
    expect(kbInfo.score).toBe(0.3)
    // operator-count 事件
    expect(wrapper.emitted('operator-count')?.[0]).toEqual([1])
    // 原始 formData 未被写回 UI 字段
    expect(wrapper.props('formData').retriever[0]._key).toBeUndefined()
  })

  it('normalizeItem：Keyword / KnowledgeGraph 检索器各自补默认', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'KeywordRetriever', kwargs: { knowledge_base_name: '单个库' } },
        { operator: 'KnowledgeGraphRetriever', kwargs: { knowledge_base_name: '图谱库' } }
      ]
    })
    const list = wrapper.vm.drawer.operatorList
    expect(list[0].kwargs.knowledge_base_name).toEqual(['单个库'])
    expect(list[0].kwargs.top_k).toBe(8)
    expect(list[1].kwargs.knowledge_base_name).toEqual(['图谱库'])
    expect(list[1].kwargs.depth).toBe(1)
    expect(list[1].kwargs.score).toBe(0)
    expect(list[1].kwargs.embedding).toBe('')
  })

  it('addOperatorWithType：建新算子（id=nodeId_uuid）并沿用同类来源（seed）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    wrapper.vm.drawer.addOperatorWithType('VectorRetriever')
    const list = wrapper.vm.drawer.operatorList
    expect(list).toHaveLength(1)
    expect(list[0].id).toMatch(/^node-1_[0-9a-f]{3}$/)
    expect(list[0].operator).toBe('VectorRetriever')
    expect(list[0].kwargs.knowledge_info_list).toHaveLength(1)
    expect(wrapper.emitted('operator-count')?.at(-1)).toEqual([1])
  })

  it('isAddDisabled：列表里有 SQL 算子时禁用新增', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'SqlRetriever', kwargs: {} }]
    })
    expect(wrapper.vm.drawer.disableAddOperator).toBe(true)
  })

  it('changeOperator：换算子换 package/kwargs，并给来源切换提示；同 id 不动', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: ['库A'] }] } }]
    })
    const operator = wrapper.vm.drawer.operatorList[0]
    operator.knowledge_info_list = undefined // 结构对齐 buildOperator 的形状
    wrapper.vm.drawer.changeOperator(operator, 'VectorRetriever')
    expect(operator.operator).toBe('VectorRetriever') // 同 id：no-op

    wrapper.vm.drawer.changeOperator(operator, 'KeywordRetriever')
    expect(operator.operator).toBe('KeywordRetriever')
    expect(operator.package).toContain('keyword')
    expect(operator._sourceNotice).toBeTruthy() // 有来源被清空的提示

    // 原来没选库：换算子不给提示
    wrapper.vm.drawer.changeOperator(operator, 'FusionRetriever')
    expect(operator._sourceNotice).toBe('')
  })

  it('move / remove：越界不动；至少保留一个', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'KeywordRetriever', kwargs: {} },
        { operator: 'FusionRetriever', kwargs: {} }
      ]
    })
    const list = wrapper.vm.drawer.operatorList
    const first = list[0]
    wrapper.vm.drawer.move(0, -1)
    expect(list[0]).toBe(first)
    wrapper.vm.drawer.move(0, 1)
    expect(list[1]).toBe(first)
    wrapper.vm.drawer.move(0, 99)
    expect(list[1]).toBe(first)

    wrapper.vm.drawer.remove(1)
    expect(list).toHaveLength(1)
    // 只剩一个：不再删
    wrapper.vm.drawer.remove(0)
    expect(list).toHaveLength(1)
  })

  it('displayName：自定义算子用 operatorName；内置走词条', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    expect(wrapper.vm.drawer.displayName({ custom: true, operatorName: '我的算子' })).toBe('我的算子')
    expect(wrapper.vm.drawer.displayName({ operator: 'VectorRetriever' })).toContain('向量')
    expect(wrapper.vm.drawer.displayName({})).toContain('ragFlow.undefinedOperator')
  })
})

describe('useOperatorDrawer：校验与提交', () => {
  it('beforeValidate 挂了知识库名校验：库名在清单里才放行', async () => {
    // afterLoad 拉到的知识库清单来自 getAllKBList（已发布库/草稿库）
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'VectorRetriever',
        kwargs: {
          strategy: 0,
          embedding: 'bge-m3',
          knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }]
        }
      }]
    })
    const validator = wrapper.vm.validate()
    const cb = vi.fn()
    validator(cb)
    expect(cb).toHaveBeenCalledWith(true)
    expect(wrapper.emitted('config-error')?.at(-1)).toEqual([''])

    // 未知库名：beforeValidate 拦下（message.error 提示清单里找不到）
    wrapper.vm.drawer.operatorList[0].kwargs.knowledge_info_list[0].knowledge_base_name = ['ghost-lib']
    const cb2 = vi.fn()
    wrapper.vm.validate()(cb2)
    expect(cb2).toHaveBeenCalledWith(false)
    expect(messageMock.error).toHaveBeenCalled()
    messageMock.error.mockClear()
  })

  it('校验失败：展开出错算子并 emit config-error（带显示名）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'VectorRetriever',
        kwargs: {
          strategy: 0,
          embedding: 'bge-m3',
          knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 0 }]
        }
      }]
    })
    const validator = wrapper.vm.validate()
    const cb = vi.fn()
    validator(cb)
    expect(cb).toHaveBeenCalledWith(false)
    const [error] = wrapper.emitted('config-error').at(-1)
    expect(error).toContain('向量')
    // 出错算子被展开
    expect(wrapper.vm.drawer.operatorList[0]._collapsed).toBe(false)
  })

  it('sendOperatorListData：剥离 UI 字段并按 formDataKey 包装', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: ['已发布库'], top_k: 8, score: 0.3, showConfig: true }] } }]
    })
    const operator = wrapper.vm.drawer.operatorList[0]
    operator._sourceNotice = '提示'
    const data = wrapper.vm.sendOperatorListData()
    expect(Object.keys(data)).toEqual(['retriever'])
    const copy = data.retriever[0]
    expect(copy._key).toBeUndefined()
    expect(copy._collapsed).toBeUndefined()
    expect(copy._sourceNotice).toBeUndefined()
    expect(copy.kwargs.knowledge_info_list[0].showConfig).toBeUndefined()
    expect(copy.kwargs.knowledge_info_list[0].knowledge_base_name).toEqual(['已发布库'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// postretriever：默认 top_k 随引擎、模型清单、独立校验
// ─────────────────────────────────────────────────────────────────────────────

describe('postretriever 抽屉', () => {
  it('挂载：补 top_n 默认值与「跟随部署默认」的空模型；拉模型清单', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'ExternalModelReranker', kwargs: {} }]
    })
    const list = wrapper.vm.drawer.operatorList
    // SequentialQueryEngine 的默认 top_n = 5
    expect(list[0].kwargs.top_n).toBe(5)
    expect(list[0].kwargs.model).toBe('')
    await flush()
    expect(modelsApi.getRerankModels).toHaveBeenCalled()
    expect(modelsApi.getLLMModel).toHaveBeenCalled()
  })

  it('getDefaultTopKWithType：三种引擎各自的默认 top_k', async () => {
    await mountDrawer(PostretrieverDrawer, { postretriever: [] })
    const { getDefaultTopKWithType } = await import('@/features/workflow/modules/shared/useOperatorDrawer')

    workflowState.ragWorkflowType = 'BlendedQueryEngine'
    expect(getDefaultTopKWithType('LLMReranker')).toBe(5)
    workflowState.ragWorkflowType = 'SequentialQueryEngine'
    expect(getDefaultTopKWithType('LLMReranker')).toBe(5)
    workflowState.ragWorkflowType = 'ConditionalQueryEngine'
    expect(getDefaultTopKWithType('LLMReranker')).toBe(4)
    // 未知引擎回落 Conditional 分支
    workflowState.ragWorkflowType = ''
    expect(getDefaultTopKWithType('LLMReranker')).toBe(4)
    expect(getDefaultTopKWithType('VectorRetriever')).toBe(8)
  })

  it('校验：LLMReranker 缺模型 / top_n 越界；未知算子放行', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [
        { operator: 'LLMReranker', kwargs: { llm: '', top_n: 4 } },
        { operator: 'ExternalModelReranker', kwargs: { model: 'bge', top_n: 99 } },
        { operator: 'CustomThing', custom: true, kwargs: {} }
      ]
    })
    const validator = wrapper.vm.validate()
    const cb = vi.fn()
    validator(cb)
    expect(cb).toHaveBeenCalledWith(false)
    const [error] = wrapper.emitted('config-error').at(-1)
    expect(error).toBeTruthy()

    // 修好第一项与越界的 top_n 后通过
    const list = wrapper.vm.drawer.operatorList
    list[0].kwargs.llm = 'qwen'
    list[1].kwargs.top_n = 20
    const cb2 = vi.fn()
    wrapper.vm.validate()(cb2)
    expect(cb2).toHaveBeenCalledWith(true)
  })

  it('addOperatorWithType：LLM / 外部模型重排的默认 kwargs', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, { postretriever: [] })
    workflowState.ragWorkflowType = 'ConditionalQueryEngine'
    wrapper.vm.drawer.addOperatorWithType('LLMReranker')
    wrapper.vm.drawer.addOperatorWithType('ExternalModelReranker')
    const list = wrapper.vm.drawer.operatorList
    expect(list[0].kwargs).toEqual({ llm: '', top_n: 4 })
    expect(list[1].kwargs).toEqual({ model: '', top_n: 4, score: 0 })
    expect(list[1].package).toContain('external')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// responsesynthesizer：generator-config 默认值、库的名字回填、结构化禁用新增
// ─────────────────────────────────────────────────────────────────────────────

describe('responsesynthesizer 抽屉', () => {
  it('挂载：generator-config 补默认（温度/无上下文提示词/top_k/库名数组）', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{
        operator: 'RagSimpleSummarizer',
        kwargs: { 'generator-config': [{ llm: 'qwen', prompt: 'p', knowledge_base_name: '单个库' }] }
      }]
    })
    const config = wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0]
    expect(config.temperature).toBe(0.01)
    expect(config.no_context_prompt).toBeTruthy()
    expect(config.top_k).toBe(8)
    expect(config.knowledge_base_name).toEqual(['单个库'])
  })

  it('afterLoad：拉知识库清单；带 doc_ 前缀与数字的库名原样保留', async () => {
    flowApi.getAllKBList = vi.fn(async () => ({
      running: [{ assetId: 'asset-9', name: '已发布库', tableName: 'doc_asset-9' }],
      dev: []
    }))
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{
        operator: 'RagSimpleSummarizer',
        kwargs: { 'generator-config': [{ llm: 'qwen', prompt: 'p', temperature: 0.5, knowledge_base_name: ['已发布库', 'doc_keep', 123] }] }
      }]
    })
    // ⚠️ 源码现状：回填循环要求 group.status === 'running'，而
    // transKbsToPublishedOptions 只在 option 上带 status（group 上没有）→ 映射不生效。
    // 这里按真实行为钉住「纯名字不映射、doc_ 前缀与数字原样保留」，
    // 校验要传 option.value（tableName）才能过 beforeValidate。
    const config = wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0]
    expect(config.knowledge_base_name).toEqual(['已发布库', 'doc_keep', 123])
    // 概览：抽屉内可用的知识库选项 = 清单里的 tableName
    expect(wrapper.vm.allKBList[0].options).toEqual([
      { value: 'doc_asset-9', label: '已发布库', status: 'running' }
    ])
  })

  it('校验：缺模型/温度越界/库名为空/top_k 越界/提示词为空 各给一条错误', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{
        operator: 'RagSimpleSummarizer',
        kwargs: { 'generator-config': [{ llm: '', prompt: '', temperature: 0.01, knowledge_base_name: ['feature_a1'], top_k: 8 }] }
      }]
    })
    const errors = []
    const validator = wrapper.vm.validate()
    const cb = vi.fn()
    validator(cb)
    errors.push(wrapper.emitted('config-error').at(-1)[0])
    expect(cb).toHaveBeenCalledWith(false)
    expect(errors[0]).toContain('大模型')

    const config = wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0]
    config.llm = 'qwen'
    config.temperature = 2
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toContain('温度')

    config.temperature = 0.5
    config.knowledge_base_name = []
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toBeTruthy()

    config.knowledge_base_name = ['feature_a1']
    config.top_k = 999
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toContain('Top N')

    config.top_k = 8
    config.prompt = '   '
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toBeTruthy()

    config.prompt = '提示词'
    const cb2 = vi.fn()
    wrapper.vm.validate()(cb2)
    expect(cb2).toHaveBeenCalledWith(true)
  })

  it('结构化知识库模式：新增算子被禁用（isAddDisabled 闸门）', async () => {
    // 页面把 ragWorkflowIsStructKnowledge 置位后（window.aipVueInstance.$store），合成抽屉不再允许新增
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: [] })
    expect(wrapper.vm.drawer.disableAddOperator).toBe(true)
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = false
  })

  it('sendOperatorListData：generator-config 的库名序列化成字符串', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{
        operator: 'RagSimpleSummarizer',
        kwargs: { 'generator-config': [{ llm: 'qwen', prompt: 'p', temperature: 0.5, knowledge_base_name: [123, '库B'], top_k: 8 }] }
      }]
    })
    const data = wrapper.vm.sendOperatorListData()
    expect(Object.keys(data)).toEqual(['responsesynthesizer'])
    expect(data.responsesynthesizer[0].kwargs['generator-config'][0].knowledge_base_name).toEqual(['123', '库B'])
    expect(data.responsesynthesizer[0]._key).toBeUndefined()
  })
})
