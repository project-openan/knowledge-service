// @vitest-environment jsdom
// 三个算子抽屉的残余分支：retriever（部署环境探测、库名三段校验、来源沿用、
// 提交收敛）、postretriever（清单失败兜底、无参算子）、responsesynthesizer
// （结构化知识库模式、库名存在性校验、双提示词大编辑器）。
// 共享骨架已在 test_wf_operatorDrawer.spec.js 覆盖，这里只打独有分支。
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
      setup: () => () => h('div', { class: 'json-editor-stub' })
    }
  }
})

import { describe, expect, it, beforeEach } from 'vitest'
import { h } from 'vue'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import RetrieverDrawer from '@/features/workflow/modules/retriever/Drawer.vue'
import PostretrieverDrawer from '@/features/workflow/modules/postretriever/Drawer.vue'
import ResponsesynthesizerDrawer from '@/features/workflow/modules/responsesynthesizer/Drawer.vue'
import { workflowState } from '@/features/workflow/store'

/** PromptEditorDialog 占位件：confirm 把编辑文本抛回抽屉。 */
/** PromptEditorDialog 占位件：confirm 把编辑文本抛回抽屉。 */
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
  ElDropdownItem: { name: 'ElDropdownItem', setup: (_p, { slots }) => () => slots.default?.() },
  ElTooltip: { name: 'ElTooltip', setup: (_p, { slots }) => () => slots.default?.() },
  // 下拉选项是自闭合标签（无插槽文案），占位件把 label 渲出来才能断言
  ElOption: { name: 'ElOption', props: ['label', 'value'], setup: props => () => h('div', { class: 'opt-stub' }, props.label) },
  ElOptionGroup: { name: 'ElOptionGroup', props: ['label'], setup: (props, { slots }) => () => h('div', {}, [props.label, slots.default?.()]) }
}

function t (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

// 知识库清单：全量（running+dev）与按 embedding 过滤（只有 running）两种形状
const KB_ALL = {
  running: [{ assetId: 'a1', name: '文档库A', tableName: 'feature_a1' }],
  dev: [{ assetId: 'd1', name: '草稿库D', tableName: 'feature_d1' }]
}
const KB_BY_MODEL = {
  running: [{ assetId: 'a1', name: '文档库A', tableName: 'feature_a1' }],
  dev: []
}

function defaultMocks (overrides = {}) {
  const pick = (value, fallback) => (value === undefined ? fallback : value)
  modelsApi.getModelList = vi.fn(async () => pick(overrides.models, [{ modelName: 'bge-m3' }]))
  modelsApi.getLLMModel = vi.fn(async () => pick(overrides.llms, [{ modelValue: 'qwen', nameZh: 'Qwen' }]))
  modelsApi.getRerankModels = vi.fn(async () => pick(overrides.reranks, [{ value: 'bge-reranker', label: 'BGE 重排', isDefault: true }]))
  flowApi.getAllKBList = vi.fn(async params => (params?.embedding
    ? pick(overrides.modelKbs, KB_BY_MODEL)
    : pick(overrides.allKbs, KB_ALL)))
  envApi.checkEnvironment = vi.fn(async () => overrides.env ?? { DEPLOYED_BY: 'self' })
  operatorsApi.getCustomOperatorList = vi.fn(async () => [])
}

/** 挂载并等载入链（模型清单 → 按模型拉库 → 全量库）落地。 */
async function mountDrawer (component, formData, extraGlobal = {}) {
  const wrapper = await mountWithPlugins(component, {
    route: '/flow',
    props: { formData, nodeId: 'node-1' },
    global: {
      components: DROPDOWN_PARTS,
      stubs: { PromptEditorDialog: PromptDialogStub },
      ...extraGlobal
    }
  })
  await flush()
  await flush()
  await flush()
  return wrapper
}

beforeEach(() => {
  defaultMocks()
  workflowState.ragWorkflowType = 'SequentialQueryEngine'
  window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = false
  messageMock.error.mockClear()
})

// ─────────────────────────────────────────────────────────────────────────────
// retriever：部署环境探测 / 库名校验 / 来源沿用 / 提交收敛
// ─────────────────────────────────────────────────────────────────────────────

describe('retriever 抽屉：部署环境与算子清单', () => {
  it('okiv5 部署：隐藏图谱检索算子', async () => {
    defaultMocks({ env: { DEPLOYED_BY: 'okiv5' } })
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    const ids = wrapper.vm.drawer.builtinOperatorList.map(item => item.id)
    expect(ids).not.toContain('KnowledgeGraphRetriever')
    expect(ids).toContain('VectorRetriever')
  })

  it('环境探测失败：按有图谱检索处理', async () => {
    envApi.checkEnvironment = vi.fn(async () => { throw new Error('boom') })
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    expect(wrapper.vm.drawer.builtinOperatorList.map(item => item.id))
      .toContain('KnowledgeGraphRetriever')
  })

  it('模型清单返回字符串数组：映射成对象清单', async () => {
    defaultMocks({ models: ['emb-1', 'emb-2'] })
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: [], top_k: 8 }] } }]
    })
    // 按模型拉库被逐个调用
    expect(flowApi.getAllKBList).toHaveBeenCalledWith({ embedding: 'emb-1' })
    const wrapperText = wrapper.text()
    expect(wrapperText).toContain('emb-1')
    expect(wrapperText).toContain('emb-2')
  })

  it('模型清单不是数组：清单保持为空、逐模型拉库不执行', async () => {
    defaultMocks({ models: null })
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    expect(wrapper.text()).not.toContain('emb-1')
    expect(flowApi.getAllKBList).toHaveBeenCalledTimes(1) // 只有全量那一次
  })

  it('按模型拉库失败：静默吞掉，不阻塞其它加载', async () => {
    flowApi.getAllKBList = vi.fn(async params => {
      if (params?.embedding) {
        throw new Error('boom')
      }
      return KB_ALL
    })
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: [] })
    expect(wrapper.vm.drawer.operatorList).toEqual([])
  })
})

describe('retriever 抽屉：知识库名三段校验（beforeValidate）', () => {
  const vectorWith = (embedding, names) => [{
    operator: 'VectorRetriever',
    kwargs: { strategy: 0, embedding, knowledge_info_list: [{ knowledge_base_name: names, top_k: 8, score: 0.3 }] }
  }]

  it('向量模型不可用：报「模型不存在」并拦截', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith('ghost-embed', ['feature_a1']) })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(false)
    expect(messageMock.error).toHaveBeenCalledWith(
      t('ragFlow.vectorModelUnavailable', { models: 'ghost-embed' }))
  })

  it('库在总清单但不在该模型的清单：报「模型不匹配」', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith('bge-m3', ['feature_d1']) })
    wrapper.vm.validate()(vi.fn())
    expect(messageMock.error).toHaveBeenCalledWith(
      t('ragFlow.kbModelMismatch', { names: 'feature_d1' }))
  })

  it('库哪儿都没有：报「找不到知识库」', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith('bge-m3', ['ghost-lib']) })
    wrapper.vm.validate()(vi.fn())
    expect(messageMock.error).toHaveBeenCalledWith(
      `${JSON.stringify(['ghost-lib'])}${t('knowledge.notFoundKBNamesTip')}`)
  })

  it('库名合法 + 算子校验全过：放行（config-error 空串）', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: vectorWith('bge-m3', ['feature_a1']) })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
    expect(wrapper.emitted('config-error').at(-1)).toEqual([''])
    expect(messageMock.error).not.toHaveBeenCalled()
  })
})

describe('retriever 抽屉：validateOperator 各算子的独立分支', () => {
  /** 换掉第一 个算子的 kwargs 后跑校验，返回最后一条 config-error 文案。 */
  async function errorAfter (list, mutate) {
    const wrapper = await mountDrawer(RetrieverDrawer, { retriever: list })
    mutate(wrapper.vm.drawer.operatorList[0].kwargs)
    wrapper.vm.validate()(vi.fn())
    return wrapper.emitted('config-error').at(-1)[0]
  }

  it('VectorRetriever：策略 / 向量模型 / 库清单 / 库名 / top_k / score 六道闸', async () => {
    const list = [{
      operator: 'VectorRetriever',
      kwargs: {
        strategy: 0,
        embedding: 'bge-m3',
        knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }]
      }
    }]
    expect(await errorAfter(list, k => { delete k.strategy })).toContain(t('ragFlow.kbRetrieveStrategyPlc'))
    // 空 embedding 时库名校验会先按「模型不匹配」拦（消息路径见三段校验组），
    // 这里同时清空库名让 beforeValidate 放行，才能走到算子校验的向量模型闸
    expect(await errorAfter(list, k => {
      k.embedding = ''
      k.knowledge_info_list[0].knowledge_base_name = []
    })).toContain(t('ragFlow.vectorModelPlc'))
    expect(await errorAfter(list, k => { k.knowledge_info_list = [] })).toContain(t('knowledge.selectKnowledge'))
    expect(await errorAfter(list, k => { k.knowledge_info_list[0].knowledge_base_name = [] }))
      .toContain(t('knowledge.selectKnowledge'))
    expect(await errorAfter(list, k => { k.knowledge_info_list[0].top_k = 0 }))
      .toContain(t('knowledge.top_kTip'))
    expect(await errorAfter(list, k => { k.knowledge_info_list[0].score = 5 }))
      .toContain(t('knowledge.scoreTip'))
  })

  it('KeywordRetriever：库名与 top_k', async () => {
    const list = [{ operator: 'KeywordRetriever', kwargs: { knowledge_base_name: ['feature_a1'], top_k: 8 } }]
    expect(await errorAfter(list, k => { k.knowledge_base_name = [] })).toContain(t('knowledge.selectKnowledge'))
    expect(await errorAfter(list, k => { k.top_k = 999 })).toContain(t('knowledge.top_kTip'))
  })

  it('KnowledgeGraphRetriever：库名 / top_k / depth', async () => {
    // 库名用清单里存在的 feature_a1（graph_* 不在清单里会被存在性闸先拦）
    const list = [{
      operator: 'KnowledgeGraphRetriever',
      kwargs: { knowledge_base_name: ['feature_a1'], top_k: 30, depth: 1 }
    }]
    expect(await errorAfter(list, k => { k.knowledge_base_name = [] })).toContain(t('knowledge.selectKnowledge'))
    expect(await errorAfter(list, k => { k.top_k = 0 })).toContain(t('knowledge.top_kTip'))
    expect(await errorAfter(list, k => { k.depth = 99 })).toContain(t('modules.workflow.depthRange'))
  })

  it('FusionRetriever：只看 top_k；自定义算子直接放行', async () => {
    const list = [{ operator: 'FusionRetriever', kwargs: { top_k: 8 } }]
    expect(await errorAfter(list, k => { k.top_k = 0 })).toContain(t('knowledge.top_kTip'))
    expect(await errorAfter(list, () => {})).toBe('')

    const custom = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'CustomOp', custom: true, kwargs: {} }]
    })
    const cb = vi.fn()
    custom.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })

  it('来源类型不匹配（图谱库挂在文档算子上）：报类型冲突', async () => {
    // graph_g1 同时在模型清单与总清单里：存在性闸放行，类型冲突在算子校验里暴露
    defaultMocks({
      allKbs: { running: [{ assetId: 'g1', name: '图谱库G', tableName: 'graph_g1' }], dev: [] },
      modelKbs: { running: [{ assetId: 'g1', name: '图谱库G', tableName: 'graph_g1' }], dev: [] }
    })
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['graph_g1'], top_k: 8, score: 0.3 }] } }]
    })
    wrapper.vm.validate()(vi.fn())
    const error = wrapper.emitted('config-error').at(-1)[0]
    // 提示里的 kind 是算子自身类型（文档），不是挂错的库类型
    expect(error).toContain(t('ragFlow.VectorRetrieverOperator'))
    expect(error).toContain(t('modules.kb.dockb'))
  })
})

describe('retriever 抽屉：来源沿用与提交收敛', () => {
  it('新增向量算子沿用同类算子的 embedding/strategy/库名', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{
        operator: 'VectorRetriever',
        kwargs: { strategy: 1, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] }
      }]
    })
    wrapper.vm.drawer.addOperatorWithType('VectorRetriever')
    const added = wrapper.vm.drawer.operatorList[1]
    expect(added.kwargs.embedding).toBe('bge-m3')
    expect(added.kwargs.strategy).toBe(1)
    expect(added.kwargs.knowledge_info_list[0].knowledge_base_name).toEqual(['feature_a1'])
  })

  it('新增关键词算子沿用文档库；图谱算子沿用图谱库与 embedding', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] } },
        { operator: 'KnowledgeGraphRetriever', kwargs: { knowledge_base_name: ['graph_g1'], embedding: 'graph-emb', top_k: 30, depth: 1 } }
      ]
    })
    wrapper.vm.drawer.addOperatorWithType('KeywordRetriever')
    expect(wrapper.vm.drawer.operatorList[2].kwargs.knowledge_base_name).toEqual(['feature_a1'])

    wrapper.vm.drawer.addOperatorWithType('KnowledgeGraphRetriever')
    const graph = wrapper.vm.drawer.operatorList[3]
    expect(graph.kwargs.knowledge_base_name).toEqual(['graph_g1'])
    expect(graph.kwargs.embedding).toBe('graph-emb')
  })

  it('新增没有来源概念的算子（Fusion）：不沿用任何库', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] } }]
    })
    wrapper.vm.drawer.addOperatorWithType('FusionRetriever')
    expect(wrapper.vm.drawer.operatorList[1].kwargs).toEqual({ top_k: 8, desc_info: '' })
  })

  it('sendOperatorListData 收敛：图谱串拆数组、去后缀去重；向量 priority 补 0、删 showConfig', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        {
          operator: 'KnowledgeGraphRetriever',
          kwargs: { knowledge_base_name: [], top_k: 30, depth: 1 }
        },
        {
          operator: 'VectorRetriever',
          kwargs: {
            strategy: 0,
            embedding: 'bge-m3',
            knowledge_info_list: [{ knowledge_base_name: ['库A|#|dev', '库A'], top_k: 8, score: 0.3, showConfig: true }]
          }
        },
        { operator: 'KeywordRetriever', kwargs: { knowledge_base_name: ['库B|#|dev', '库B'], top_k: 8 } }
      ]
    })
    // 老配置可能是逗号串（带 |#|dev 发布后缀）：提交前改回串触发 split / 去后缀 / 去重分支
    wrapper.vm.drawer.operatorList[0].kwargs.knowledge_base_name = '库B, 库A, 库B|#|dev'
    const data = wrapper.vm.sendOperatorListData()
    expect(data.retriever[0].kwargs.knowledge_base_name).toEqual(['库B', '库A'])
    const vectorItem = data.retriever[1].kwargs.knowledge_info_list[0]
    expect(vectorItem.priority).toBe(0)
    expect(vectorItem.showConfig).toBeUndefined()
    expect(vectorItem.knowledge_base_name).toEqual(['库A'])
    expect(data.retriever[2].kwargs.knowledge_base_name).toEqual(['库B'])
  })

  it('serializeOperator：抽屉私有字段（_key/_collapsed/_sourceNotice）不落库', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] } }]
    })
    const op = wrapper.vm.drawer.operatorList[0]
    op._sourceNotice = '提示'
    const copy = wrapper.vm.sendOperatorListData().retriever[0]
    expect(copy._sourceNotice).toBeUndefined()
    expect(copy._key).toBeUndefined()
    expect(copy.kwargs.knowledge_info_list[0].knowledge_base_name).toEqual(['feature_a1'])
  })

  it('来源切换提示：换成图谱算子带「图谱」提示；换成无来源算子不给提示', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [{ operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] } }]
    })
    const op = wrapper.vm.drawer.operatorList[0]
    wrapper.vm.drawer.changeOperator(op, 'KnowledgeGraphRetriever')
    expect(op._sourceNotice).toContain(zh.modules.workflow.sourceKindShortGraph)

    // 已被清空（无来源）后再换：不给提示
    wrapper.vm.drawer.changeOperator(op, 'FusionRetriever')
    expect(op._sourceNotice).toBe('')
  })

  it('来源标签：文档/图谱算子带类型徽标，融合检索没有', async () => {
    const wrapper = await mountDrawer(RetrieverDrawer, {
      retriever: [
        { operator: 'VectorRetriever', kwargs: { strategy: 0, embedding: 'bge-m3', knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8, score: 0.3 }] } },
        { operator: 'FusionRetriever', kwargs: { top_k: 8 } }
      ]
    })
    expect(wrapper.findAll('.fc-source-context')).toHaveLength(1)
    // 徽标文案走 modules.kb.dockb（文档知识库）
    expect(wrapper.find('.fc-source-context .tag-soft').text()).toBe(zh.modules.kb.dockb)

    // 提示条：有 _sourceNotice 且当前没选库时才显示
    const op = wrapper.vm.drawer.operatorList[1]
    op._sourceNotice = '换了算子'
    await flush()
    expect(wrapper.find('.fc-source-notice').exists()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// postretriever：清单失败兜底 / 无参算子 / 跟随默认文案
// ─────────────────────────────────────────────────────────────────────────────

describe('postretriever 抽屉：模型清单与表单分支', () => {
  it('LLM / 重排模型清单失败：回落空清单，抽屉可用', async () => {
    modelsApi.getLLMModel = vi.fn(async () => { throw new Error('boom') })
    modelsApi.getRerankModels = vi.fn(async () => { throw new Error('boom') })
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'LLMReranker', kwargs: { llm: 'qwen', top_n: 5 } }]
    })
    expect(wrapper.vm.LLMList).toEqual([])
    expect(wrapper.vm.RerankModelList).toEqual([])
    // 无默认行：占位文案走「空默认」词条
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })

  it('ExternalModelReranker：占位文案带默认模型名', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'ExternalModelReranker', kwargs: { model: '', top_n: 5, score: 0 } }]
    })
    await flush()
    expect(wrapper.text()).toContain('BGE 重排')
    expect(wrapper.text()).toContain('跟随部署默认（BGE 重排）')
  })

  it('未知算子（SimilarityFilter）：走 JSON 编辑器分支，插槽表单不渲染', async () => {
    // 注：模板里 SimilarityFilter 的「无需配置」提示挂在默认插槽内，而未知算子
    // 由外壳路由到 JSON 编辑器分支 —— 该提示在真实数据流下不可达（防御分支）。
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'SimilarityFilter', kwargs: {} }]
    })
    expect(wrapper.find('.json-editor-stub').exists()).toBe(true)
    expect(wrapper.text()).not.toContain(t('modules.workflow.noParams'))
  })

  it('重排清单没有默认行：占位文案走空默认词条', async () => {
    defaultMocks({ reranks: [{ value: 'bge', label: 'BGE 重排', isDefault: false }] })
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'ExternalModelReranker', kwargs: { model: '', top_n: 5 } }]
    })
    await flush()
    expect(wrapper.text()).toContain(t('modules.workflow.rerankModelFollowDefaultEmpty'))
  })

  it('载入时 kwargs 缺失：补 {} 与 top_n=5', async () => {
    const wrapper = await mountDrawer(PostretrieverDrawer, {
      postretriever: [{ operator: 'LLMReranker' }]
    })
    expect(wrapper.vm.drawer.operatorList[0].kwargs).toEqual({ top_n: 5 })
  })

  it('BlendedQueryEngine 下新增外部重排：top_n=5、score=default_BGM_score', async () => {
    workflowState.ragWorkflowType = 'BlendedQueryEngine'
    const wrapper = await mountDrawer(PostretrieverDrawer, { postretriever: [] })
    wrapper.vm.drawer.addOperatorWithType('ExternalModelReranker')
    expect(wrapper.vm.drawer.operatorList[0].kwargs).toEqual({ model: '', top_n: 5, score: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// responsesynthesizer：结构化模式 / 库名存在性 / 双提示词编辑器
// ─────────────────────────────────────────────────────────────────────────────

const rssList = config => [{ operator: 'RagSimpleSummarizer', kwargs: { 'generator-config': [config] } }]
const rssOkConfig = { llm: 'qwen', prompt: 'p', temperature: 0.5, knowledge_base_name: ['feature_a1'], top_k: 8, no_context_prompt: 'nc' }

describe('responsesynthesizer 抽屉：结构化知识库模式', () => {
  it('结构化模式：库名不选也不拦（跳过 selectKnowledge 闸）', async () => {
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const config = { ...rssOkConfig }
    delete config.knowledge_base_name
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(config) })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })

  it('结构化模式：占位显示已绑库的显示名（tableName → 名称）', async () => {
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(rssOkConfig) })
    await flush()
    expect(wrapper.findAll('[data-ep-stub="el-select"]').at(-1).attributes('placeholder')).toBe('文档库A')
  })

  it('结构化模式：新增算子被禁用；temperature 越界仍拦', async () => {
    window.aipVueInstance.$store.state.ragWorkflowIsStructKnowledge = true
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList({ ...rssOkConfig, temperature: 2 }) })
    expect(wrapper.vm.drawer.disableAddOperator).toBe(true)
    wrapper.vm.validate()(vi.fn())
    expect(wrapper.emitted('config-error').at(-1)[0]).toContain(t('ragFlow.temperatureTip'))
  })
})

describe('responsesynthesizer 抽屉：库名存在性与提示词编辑器', () => {
  it('库名不在清单：beforeValidate 拦下并提示', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: rssList({ ...rssOkConfig, knowledge_base_name: ['ghost-lib'] })
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(false)
    expect(messageMock.error).toHaveBeenCalledWith(
      `${JSON.stringify(['ghost-lib'])}${t('knowledge.notFoundKBNamesTip')}`)
  })

  it('自定义算子不参与库名校验；新增算子带引擎默认 top_k', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [
        { operator: 'CustomOp', custom: true, kwargs: {} },
        ...rssList(rssOkConfig)
      ]
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)

    wrapper.vm.drawer.addOperatorWithType('RagSimpleSummarizer')
    const added = wrapper.vm.drawer.operatorList.at(-1)
    expect(added.kwargs['generator-config'][0].top_k).toBe(5) // SequentialQueryEngine
    expect(added.kwargs['generator-config'][0].temperature).toBe(0.01)
  })

  it('normalizeItem：config.custom 跳过默认值补齐', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: [{ operator: 'CustomOp', custom: true, kwargs: { 'generator-config': [{ custom: true, llm: 'q' }] } }]
    })
    expect(wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0].temperature).toBeUndefined()
  })

  it('两个提示词字段的展开编辑：prompt 与 no_context_prompt 各自回写', async () => {
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, { responsesynthesizer: rssList(rssOkConfig) })
    const expandButtons = wrapper.findAll('button.fc-text-action')
    expect(expandButtons).toHaveLength(2)

    await expandButtons[1].trigger('click') // no_context_prompt
    expect(wrapper.find('.prompt-subtitle').text()).toContain(t('modules.workflow.fullPrompt'))
    await wrapper.findAll('button.confirm-prompt').at(-1).trigger('click')
    expect(wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0].no_context_prompt).toBe('nc!')

    await expandButtons[0].trigger('click') // prompt
    await wrapper.findAll('button.confirm-prompt').at(-1).trigger('click')
    expect(wrapper.vm.drawer.operatorList[0].kwargs['generator-config'][0].prompt).toBe('p!')
  })

  it('库清单未到达时校验放行（清单为空 = 交给后端）', async () => {
    flowApi.getAllKBList = vi.fn(async () => ({ running: [], dev: [] }))
    const wrapper = await mountDrawer(ResponsesynthesizerDrawer, {
      responsesynthesizer: rssList({ ...rssOkConfig, knowledge_base_name: ['never-exists'] })
    })
    const cb = vi.fn()
    wrapper.vm.validate()(cb)
    expect(cb).toHaveBeenCalledWith(true)
  })
})
