// @vitest-environment jsdom
// 画布卡片层：CardFrame（卡片皮肤）+ 六个节点组件（queryNode / responseNode /
// sideNode + 四个算子 Node.vue）与它们共享的数据层 useFlowNodeCard。
//
// 节点组件挂在 X6 的 VueShape 里运行，靠 inject('getNode') 拿真实节点对象；
// 单测里用假节点（store.data / model.on / on 事件表）顶上，断言渲染与 emit。
import { vi } from 'vitest'

vi.hoisted(() => {
  // 卡片数据层与 CardFrame 读 window.aipVueInstance.$t（main.js 挂的全局实例）
  window.aipVueInstance = { $t: () => '' }
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

// types.ts 在 import 期用 webpack require 拉 svg（vitest 解析不了），换形状等价桩
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

// 卡片的库名映射走缓存请求，这里换成同步可判的桩
const { kbNamesModule } = vi.hoisted(() => ({ kbNamesModule: { map: {} } }))
vi.mock('@/features/knowledge-base/lib/kbNames', () => ({
  kbDisplayName: name => kbNamesModule.map[name] || '',
  loadKbNames: vi.fn(async () => kbNamesModule.map)
}))

import { describe, expect, it, beforeEach } from 'vitest'
import zh from '@/app/i18n/zh.js'
import { flush, mountWithPlugins } from './helpers/mount'
import CardFrame from '@/features/workflow/modules/CardFrame.vue'
import QueryNode from '@/features/workflow/modules/queryNode.vue'
import ResponseNode from '@/features/workflow/modules/responseNode.vue'
import SideNode from '@/features/workflow/modules/sideNode.vue'
import PreretrieverNode from '@/features/workflow/modules/preretriever/Node.vue'
import RetrieverNode from '@/features/workflow/modules/retriever/Node.vue'
import PostretrieverNode from '@/features/workflow/modules/postretriever/Node.vue'
import ResponsesynthesizerNode from '@/features/workflow/modules/responsesynthesizer/Node.vue'
import {
  geometryForNode,
  moduleToneOf
} from '@/features/workflow/modules/useFlowNodeCard'
import { createDefaultVariables } from '@/features/workflow/modules/flowNodeDefaults'
import { nodeGeometry } from '@/features/workflow/lib/flowGeometry'

/** 真 zh 词条的 $t：CardFrame / useFlowNodeCard 不走 app i18n 插件，读这个全局实例。 */
function translate (key, params = {}) {
  const text = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zh)
  if (text == null) {
    return key
  }
  return String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

/** 假 X6 节点：事件表 + model 事件表 + 可换的边列表。 */
function makeNode ({ id = 'node-1', shape = 'RETRIEVER', label = '', variables = undefined, edges = [], cells = {} } = {}) {
  const handlers = {}
  const modelHandlers = {}
  const storeData = { label, inputVariables: [], data: {} }
  if (variables !== undefined) {
    storeData.data = { variables }
  }
  const node = {
    id,
    shape,
    store: { data: storeData },
    model: {
      on: (name, fn) => { (modelHandlers[name] = modelHandlers[name] || []).push(fn) },
      off: vi.fn(),
      getEdges: vi.fn(() => edges),
      getCell: cellId => cells[cellId] || null
    },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn) },
    handlers,
    modelHandlers
  }
  return node
}

function makeEdge ({ id = 'e1', sourceId = 'q1', targetId = 'node-1' } = {}) {
  return {
    id,
    getSourceCellId: () => sourceId,
    getTargetCellId: () => targetId
  }
}

/** 带假节点的挂载：inject('getNode') 由 provide 注入。 */
async function mountNodeCard (component, node) {
  const wrapper = await mountWithPlugins(component, {
    route: '/flow',
    global: { provide: { getNode: () => node } }
  })
  await flush()
  return wrapper
}

beforeEach(() => {
  window.aipVueInstance.$t = translate
  kbNamesModule.map = {}
})

// ─────────────────────────────────────────────────────────────────────────────
// CardFrame：卡片皮肤（tone / 固定节点 / 算子与 IO 区 / 编辑入口）
// ─────────────────────────────────────────────────────────────────────────────

describe('CardFrame：卡片皮肤', () => {
  const baseProps = {
    title: '检索器',
    label: 'RE-1',
    operators: [{ key: 1, name: '向量检索' }],
    inputs: [{ id: 'e1', title: 'Question', label: 'Q-1', tone: 'purple' }],
    outputField: 'documents'
  }

  it('标题 + label + 算子行（序号补零）+ 输入/输出区', async () => {
    const wrapper = await mountWithPlugins(CardFrame, { route: '/flow', props: baseProps })
    const text = wrapper.text()
    expect(text).toContain('检索器')
    expect(text).toContain('RE-1')
    expect(text).toContain('向量检索')
    expect(text).toContain('01')
    expect(text).toContain('Question')
    expect(text).toContain('documents')
    expect(text).toContain('输出')
    expect(wrapper.find('.ai-card-frame--blue').exists()).toBe(true)
  })

  it('theme 映射：primary / 空 / gray 都归到 blue，其余原样', async () => {
    for (const [theme, expected] of [['primary', 'blue'], ['', 'blue'], ['gray', 'blue'], ['orange', 'orange'], ['purple', 'purple']]) {
      const wrapper = await mountWithPlugins(CardFrame, {
        route: '/flow',
        props: { ...baseProps, theme }
      })
      expect(wrapper.find(`.ai-card-frame--${expected}`).exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('业务节点：编辑按钮上抛 editCardHandle，正文点击 / 回车 / 空格同样触发', async () => {
    const wrapper = await mountWithPlugins(CardFrame, { route: '/flow', props: baseProps })
    await wrapper.find('button.icon-button').trigger('click')
    expect(wrapper.emitted('editCardHandle')).toHaveLength(1)

    const body = wrapper.find('.flow-node-contents')
    await body.trigger('click')
    await body.trigger('keydown.enter')
    await body.trigger('keydown.space')
    expect(wrapper.emitted('editCardHandle')).toHaveLength(4)
    // 高亮态
    expect(wrapper.find('.highlight').exists()).toBe(false)
  })

  it('showEditButton=false：不渲染编辑按钮；highlightNode 加高亮类', async () => {
    const wrapper = await mountWithPlugins(CardFrame, {
      route: '/flow',
      props: { ...baseProps, showEditButton: false, highlightNode: true }
    })
    expect(wrapper.find('button.icon-button').exists()).toBe(false)
    expect(wrapper.find('.highlight').exists()).toBe(true)
  })

  it('固定节点（QUERY/RESPONSE）：Lock 图标 + 固定字段正文，无算子/IO 区', async () => {
    const wrapper = await mountWithPlugins(CardFrame, {
      route: '/flow',
      props: { ...baseProps, fixed: true, fixedDirection: '输出', fixedField: 'Question' }
    })
    expect(wrapper.find('.node-lock').exists()).toBe(true)
    expect(wrapper.find('.flow-fixed-body').exists()).toBe(true)
    expect(wrapper.text()).toContain('Question')
    expect(wrapper.find('.flow-node-contents').exists()).toBe(false)
    expect(wrapper.find('.flow-operators').exists()).toBe(false)
    await wrapper.find('.flow-fixed-body').trigger('keydown.enter')
    expect(wrapper.emitted('editCardHandle')).toHaveLength(1)
  })

  it('空列表：算子与上游的占位文案；来源摘要带 title', async () => {
    const wrapper = await mountWithPlugins(CardFrame, {
      route: '/flow',
      props: {
        ...baseProps,
        operators: [],
        inputs: [],
        sourceSummary: { text: '文档 · 文档库A · Top 8', title: '文档 · 文档库A' }
      }
    })
    expect(wrapper.text()).toContain('尚未配置算子')
    expect(wrapper.text()).toContain('尚未连接上游')
    expect(wrapper.text()).toContain('文档 · 文档库A · Top 8')
    expect(wrapper.find('.flow-source-summary').attributes('title')).toBe('文档 · 文档库A')
  })

  it('icon prop 走 mask 字形（--card-frame-icon 变量）；默认插槽图标优先', async () => {
    const glyph = await mountWithPlugins(CardFrame, {
      route: '/flow',
      props: { ...baseProps, icon: 'data:image/svg+xml;base64,x' }
    })
    expect(glyph.find('.card-frame-header__glyph').exists()).toBe(true)

    const slotted = await mountWithPlugins(CardFrame, {
      route: '/flow',
      props: baseProps,
      slots: { icon: '<span class="slotted-icon"/>' }
    })
    expect(slotted.find('.slotted-icon').exists()).toBe(true)
    expect(slotted.find('.card-frame-header__glyph').exists()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 固定节点：queryNode / responseNode
// ─────────────────────────────────────────────────────────────────────────────

describe('固定节点卡片：queryNode / responseNode', () => {
  it('queryNode：标题「开始」+ Query 字段 + Lock，正文点击上抛 editCardHandle', async () => {
    const node = makeNode({ id: 'q-node', shape: 'QUERY', label: 'IN' })
    const wrapper = await mountNodeCard(QueryNode, node)
    const text = wrapper.text()
    expect(text).toContain(zh.ragFlow.start)
    expect(text).toContain('Question')
    expect(text).toContain(zh.modules.workflow.output)
    expect(wrapper.find('.node-lock').exists()).toBe(true)
    expect(wrapper.find('.flow-fixed-body').exists()).toBe(true)

    await wrapper.find('.flow-fixed-body').trigger('click')
    const [info, id] = wrapper.emitted('editCardHandle')[0]
    expect(id).toBe('q-node')
    expect(info.id).toBe('q-node')
    expect(info.componentType).toBe('QUERY')
  })

  it('responseNode：标题「结束」+ Answer 字段', async () => {
    const wrapper = await mountNodeCard(ResponseNode, makeNode({ shape: 'RESPONSE' }))
    expect(wrapper.text()).toContain(zh.ragFlow.end)
    expect(wrapper.text()).toContain('Answer')
    await wrapper.find('.flow-fixed-body').trigger('click')
    expect(wrapper.emitted('editCardHandle')).toHaveLength(1)
  })

  it('固定节点无 variables 也不发 initCardHandle（父组件不给固定节点建变量）', async () => {
    const wrapper = await mountNodeCard(QueryNode, makeNode({ shape: 'QUERY', variables: null }))
    expect(wrapper.emitted('initCardHandle')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 算子节点：preretriever / retriever / postretriever / responsesynthesizer
// ─────────────────────────────────────────────────────────────────────────────

const OPERATOR_NODES = [
  [PreretrieverNode, 'PRE_RETRIEVER', 'ragFlow.preretrieverTitle', 'query'],
  [RetrieverNode, 'RETRIEVER', 'ragFlow.retrieverTitle', 'documents'],
  [PostretrieverNode, 'POST_RETRIEVER', 'ragFlow.postretrieverTitle', 'documents'],
  [ResponsesynthesizerNode, 'RESPONSE_SYNTHESIZER', 'ragFlow.responsesynthesizerTitle', 'answer']
]

describe('算子节点卡片：四个业务节点', () => {
  it.each(OPERATOR_NODES)('%s：标题 / 输出字段 / 默认算子渲染', async (component, shape, titleKey, outputField) => {
    const variables = createDefaultVariables(shape)
    const wrapper = await mountNodeCard(component, makeNode({ shape, variables }))
    expect(wrapper.text()).toContain(zh.ragFlow[titleKey.split('.')[1]])
    expect(wrapper.text()).toContain(outputField)
    // 默认算子链一条，显示名走词条
    expect(wrapper.text()).toContain('1')
    expect(wrapper.find('.flow-operator-row').exists()).toBe(true)
    // 正文点击 → editCardHandle（bindEmits 的 edit 通路）
    await wrapper.find('.flow-node-contents').trigger('click')
    expect(wrapper.emitted('editCardHandle')).toHaveLength(1)
    wrapper.unmount()
  })

  it('节点没带 variables：挂载即 emit initCardHandle（父组件回写默认变量）', async () => {
    const wrapper = await mountNodeCard(PreretrieverNode, makeNode({ shape: 'PRE_RETRIEVER', variables: null }))
    const [payload] = wrapper.emitted('initCardHandle')[0]
    expect(payload.id).toBe('node-1')
    expect(payload.componentType).toBe('PRE_RETRIEVER')
    expect(payload.variables.preretriever).toHaveLength(1)
    expect(payload.inputVariables).toEqual([])
  })

  it('节点带 variables：不发 init，卡片直接渲染传入的算子链', async () => {
    const variables = {
      retriever: [
        { id: 1, operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8 }] } },
        { id: 2, operator: 'KeywordRetriever', kwargs: { knowledge_base_name: ['feature_a1'], top_k: 8 } }
      ]
    }
    const wrapper = await mountNodeCard(RetrieverNode, makeNode({ shape: 'RETRIEVER', variables }))
    expect(wrapper.emitted('initCardHandle')).toBeUndefined()
    expect(wrapper.findAll('.flow-operator-row')).toHaveLength(2)
  })

  it('点击卡片正文：emit editCardHandle（带 inputVariables 拷贝与节点 id）', async () => {
    const node = makeNode({ shape: 'RETRIEVER', variables: { retriever: [] } })
    node.store.data.inputVariables = [{ key: 'query' }]
    const wrapper = await mountNodeCard(RetrieverNode, node)
    await wrapper.find('.flow-node-contents').trigger('click')
    const [info, id] = wrapper.emitted('editCardHandle')[0]
    expect(id).toBe('node-1')
    expect(info.inputVariables).toEqual([{ key: 'query' }])
    expect(info.inputVariables).not.toBe(node.store.data.inputVariables) // 拷贝而非引用
  })

  it('change:data（saveData/displayData）：卡片算子列表跟着刷新', async () => {
    const node = makeNode({ shape: 'RETRIEVER', variables: { retriever: [] } })
    const wrapper = await mountNodeCard(RetrieverNode, node)
    expect(wrapper.findAll('.flow-operator-row')).toHaveLength(1) // 空态占位行

    node.handlers['change:data'].forEach(fn => fn({
      current: { type: 'saveData', variables: { retriever: [{ id: 1, operator: 'VectorRetriever', kwargs: {} }] } }
    }))
    await flush()
    expect(wrapper.findAll('.flow-operator-row')).toHaveLength(1) // 一行算子
    expect(wrapper.text()).toContain('向量')

    // 非 saveData/displayData 的变更不刷新
    node.handlers['change:data'].forEach(fn => fn({ current: { type: 'other', variables: { retriever: [] } } }))
    await flush()
    expect(wrapper.text()).toContain('向量')
  })

  it('change:label：卡片上的 label 更新', async () => {
    const node = makeNode({ shape: 'RETRIEVER', label: '旧名', variables: { retriever: [] } })
    const wrapper = await mountNodeCard(RetrieverNode, node)
    expect(wrapper.text()).toContain('旧名')
    node.store.data.label = '新名'
    node.handlers['change:label'].forEach(fn => fn({ current: '新名' }))
    await flush()
    expect(wrapper.text()).toContain('新名')
  })

  it('上游输入区：入边渲染来源卡片名 + tone；cell:added 重新统计', async () => {
    const cells = {
      q1: { shape: 'QUERY', store: { data: { label: 'Q' } } },
      r2: { shape: 'RETRIEVER', store: { data: { label: 'RE-2' } } }
    }
    const node = makeNode({
      shape: 'POST_RETRIEVER',
      variables: { postretriever: [] },
      edges: [makeEdge({ id: 'e1', sourceId: 'q1' }), makeEdge({ id: 'e2', sourceId: 'r2' })],
      cells
    })
    const wrapper = await mountNodeCard(PostretrieverNode, node)
    const rows = wrapper.findAll('.flow-io-row')
    expect(rows).toHaveLength(2)
    expect(wrapper.text()).toContain(zh.modules.workflow.question)
    expect(wrapper.text()).toContain(zh.ragFlow.retrieverTitle)

    // 模型补一条边（来源未知 shape → 标题回落为空串、tone 蓝色）
    cells.x1 = { store: { data: { label: 'X' } } }
    node.model.getEdges.mockReturnValue([
      ...node.model.getEdges(),
      makeEdge({ id: 'e3', sourceId: 'x1' })
    ])
    node.modelHandlers['cell:added'].forEach(fn => fn())
    await flush()
    expect(wrapper.findAll('.flow-io-row')).toHaveLength(3)
  })

  it('RETRIEVER 卡片：来源摘要带类型前缀（库名映射命中时用显示名）', async () => {
    kbNamesModule.map = { feature_a1: '文档库A' }
    const wrapper = await mountNodeCard(RetrieverNode, makeNode({
      shape: 'RETRIEVER',
      variables: { retriever: [{ id: 1, operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8 }] } }] }
    }))
    expect(wrapper.find('.flow-source-summary').exists()).toBe(true)
    expect(wrapper.text()).toContain(`${zh.modules.workflow.sourceKindShortKnowledge} · 文档库A · Top 8`)
  })

  it('RETRIEVER 卡片：映射未命中回落短名；Fusion 检索用融合文案', async () => {
    const noMap = await mountNodeCard(RetrieverNode, makeNode({
      shape: 'RETRIEVER',
      variables: { retriever: [{ id: 1, operator: 'VectorRetriever', kwargs: { knowledge_info_list: [{ knowledge_base_name: ['feature_a1'], top_k: 8 }] } }] }
    }))
    expect(noMap.text()).toContain(`${zh.modules.workflow.sourceKindShortKnowledge} · feature_a1 · Top 8`)
    noMap.unmount()

    const fusion = await mountNodeCard(RetrieverNode, makeNode({
      shape: 'RETRIEVER',
      variables: { retriever: [{ id: 1, operator: 'FusionRetriever', kwargs: { top_k: 30 } }] }
    }))
    expect(fusion.text()).toContain(zh.modules.workflow.fusionSource)
  })

  it('deleteCardHandle：上抛节点 id（卡片 UI 无删除入口，走数据层直调）', async () => {
    for (const [component, shape] of [[PreretrieverNode, 'PRE_RETRIEVER'], [RetrieverNode, 'RETRIEVER'], [PostretrieverNode, 'POST_RETRIEVER'], [ResponsesynthesizerNode, 'RESPONSE_SYNTHESIZER'], [QueryNode, 'QUERY'], [ResponseNode, 'RESPONSE']]) {
      const node = makeNode({ id: 'del-1', shape, variables: shape === 'QUERY' || shape === 'RESPONSE' ? null : { retriever: [] } })
      const wrapper = await mountNodeCard(component, node)
      wrapper.vm.deleteCardHandle()
      expect(wrapper.emitted('deleteCardHandle')[0]).toEqual(['del-1'])
      wrapper.unmount()
    }
  })

  it('卸载时解绑 model 监听', async () => {
    const node = makeNode({ shape: 'RETRIEVER', variables: { retriever: [] } })
    const wrapper = await mountNodeCard(RetrieverNode, node)
    wrapper.unmount()
    expect(node.model.off).toHaveBeenCalledTimes(3)
    const events = node.model.off.mock.calls.map(([name]) => name)
    expect(events).toEqual(expect.arrayContaining(['cell:added', 'cell:removed', 'cell:changed']))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sideNode：左侧节点栏的预览卡
// ─────────────────────────────────────────────────────────────────────────────

describe('sideNode：左侧栏节点预览', () => {
  it.each([
    ['preretriever'], ['retriever'], ['postretriever'], ['responsesynthesizer']
  ])('%s：按类型挂皮肤类与图标', async sideNodeId => {
    const wrapper = await mountWithPlugins(SideNode, {
      route: '/flow',
      props: { sideNodeId, sideNodeName: '预检索器' }
    })
    expect(wrapper.classes()).toContain(`side-node--${sideNodeId}`)
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.text()).toContain('预检索器')
    wrapper.unmount()
  })

  it('未知类型：无图标、无修饰类', async () => {
    const wrapper = await mountWithPlugins(SideNode, {
      route: '/flow',
      props: { sideNodeId: '', sideNodeName: '' }
    })
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['side-node']))
    expect(wrapper.find('img').exists()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// useFlowNodeCard 导出的纯辅助
// ─────────────────────────────────────────────────────────────────────────────

describe('useFlowCard 辅助导出', () => {
  it('moduleToneOf：五类节点各自的 tone，未知回落 blue', () => {
    expect(moduleToneOf('PRE_RETRIEVER')).toBe('purple')
    expect(moduleToneOf('RETRIEVER')).toBe('orange')
    expect(moduleToneOf('POST_RETRIEVER')).toBe('blue')
    expect(moduleToneOf('RESPONSE_SYNTHESIZER')).toBe('green')
    expect(moduleToneOf('QUERY')).toBe('blue')
    expect(moduleToneOf('Whatever')).toBe('blue')
  })

  it('geometryForNode：算子数 + 入边数 → 卡片几何', () => {
    const node = makeNode({
      shape: 'RETRIEVER',
      variables: { retriever: [{ id: 1 }, { id: 2 }] },
      edges: [makeEdge({ id: 'e1' }), makeEdge({ id: 'e2', sourceId: 'q2' })]
    })
    expect(geometryForNode(node)).toEqual(
      nodeGeometry({ shape: 'RETRIEVER', operatorCount: 2, inputCount: 2 }))
  })

  it('geometryForNode：裸数据节点（无 model/variables）不炸', () => {
    expect(geometryForNode({ shape: 'QUERY', id: 'q' })).toEqual(
      nodeGeometry({ shape: 'QUERY', operatorCount: 0, inputCount: 0 }))
    expect(geometryForNode(null)).toEqual(
      nodeGeometry({ shape: undefined, operatorCount: 0, inputCount: 0 }))
  })
})
