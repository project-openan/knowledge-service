// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// types.ts 在 import 期用 webpack require 拉 svg（vitest 解析不了），换形状等价的桩
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

// 节点配置抽屉：打开/回填、校验与应用、删除确认与桥接。
// X6 用假 graph；删除确认走真实的 requestDeletion（用 settleDeletion 模拟用户点击）。
import { useFlowDrawer } from '@/features/workflow/composables/useFlowDrawer'
import { useFlowConnections } from '@/features/workflow/composables/useFlowConnections'
import { useFlowGeometry } from '@/features/workflow/composables/useFlowGeometry'
import { deletion, settleDeletion } from '@/shared/composables/deletion'

const methods = useFlowDrawer()
// applyDrawerUpstreams 里的环检测/几何同步属于相邻 composable（经 this 互调）
const allMethods = { ...methods, ...useFlowConnections(), ...useFlowGeometry() }

function createCtx (overrides = {}) {
  return {
    ...allMethods,
    graph: null,
    $t: (key, params) => key + (params ? '|' + Object.values(params).join('|') : ''),
    $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
    $nextTick: fn => fn(),
    shapeAndPortIdMap: {
      PRE_RETRIEVER: 'preretriever',
      RETRIEVER: 'retriever',
      POST_RETRIEVER: 'postretriever',
      RESPONSE_SYNTHESIZER: 'responsesynthesizer'
    },
    $refs: {},
    currentNodeId: '',
    currentNodeData: {},
    drawerBasics: {},
    toolsOpen: false,
    refreshStructKnowledgeFlag: vi.fn(),
    selectNodeView: vi.fn(),
    clearNodeSelection: vi.fn(),
    cancelConnection: vi.fn(),
    scheduleGeometrySync: vi.fn(),
    scheduleEdgeDecorations: vi.fn(),
    syncGraphStats: vi.fn(),
    moduleTitleOf: shape => `标题-${shape}`,
    moduleToneOf: () => 'orange',
    nodeVariables: node => node?.store?.data?.data?.variables ?? null,
    nodeDisplayName: id => `名-${id}`,
    removeNodeWithBridge: vi.fn(),
    ...overrides
  }
}

function makeNode ({ id = 'n1', shape = 'RETRIEVER', label = 'RE-1', variables = { retriever: [] } } = {}) {
  return {
    id,
    shape,
    store: { data: { label, data: { variables } } },
    getPortsByGroup: vi.fn(group => [{ id: `${id}-${group}-port` }]),
    getPort: vi.fn(() => ({ group: 'in' })),
    setProp: vi.fn(),
    setData: vi.fn(),
    getData: vi.fn(() => ({ old: 1 })),
    portProp: vi.fn(),
    position: vi.fn()
  }
}

function makeEdge ({ id = 'e1', sourceId = 'q1', targetId = 'n1', sourcePort = 'q-out' } = {}) {
  return {
    id,
    getSourceCellId: () => sourceId,
    getTargetCellId: () => targetId,
    getSourcePortId: () => sourcePort,
    getSourceCell: () => ({ id: sourceId })
  }
}

/** 等删除确认弹窗挂起后，用 settleDeletion 模拟用户点确认/取消。 */
async function confirmAs (confirmed) {
  await Promise.resolve()
  settleDeletion(confirmed)
  await Promise.resolve()
}

beforeEach(() => {
  deletion.open = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  settleDeletion(false)
})



describe('editCardHandle：抽屉打开与回填', () => {
  it('节点不存在：直接返回', () => {
    const ctx = createCtx({ graph: { getCellById: () => null } })
    methods.editCardHandle.call(ctx, { id: 'missing' })
    expect(ctx.currentNodeId).toBe('')
  })

  it('固定节点（QUERY/RESPONSE）：不走动态 require，字段与方向按 shape 区分', async () => {
    const openDrawer = vi.fn()
    const query = makeNode({ id: 'q1', shape: 'QUERY', label: '' })
    const ctx = createCtx({
      graph: {
        getCellById: id => ({ q1: query }[id] || null),
        getIncomingEdges: () => [],
        getNodes: () => [query]
      },
      $refs: { drawerFrameRef: { openDrawer } }
    })
    methods.editCardHandle.call(ctx, { id: 'q1' })
    expect(ctx.toolsOpen).toBe(false)
    expect(ctx.refreshStructKnowledgeFlag).toHaveBeenCalled()
    expect(ctx.drawerFixed).toBe(true)
    expect(ctx.drawerTitle).toBe('标题-QUERY')
    expect(ctx.drawerTone).toBe('orange')
    expect(ctx.drawerFixedDirection).toBe('modules.workflow.output')
    expect(ctx.drawerFixedField).toBe('Question')
    expect(ctx.dynamicComponent).toBeNull()
    expect(openDrawer).toHaveBeenCalledWith('QUERY')
    expect(ctx.selectNodeView).toHaveBeenCalledWith('q1')

    // RESPONSE：字段是 Answer，方向回到「输入」
    const response = makeNode({ id: 'r1', shape: 'RESPONSE' })
    ctx.graph.getCellById = id => ({ r1: response }[id] || null)
    methods.editCardHandle.call(ctx, { id: 'r1' })
    expect(ctx.drawerFixedField).toBe('Answer')
    expect(ctx.drawerFixedDirection).toBe('modules.workflow.inputs')
  })

  // ⚠️ 业务节点的动态 require(`../modules/<dir>/Drawer`) 走 vitest vm 的模块链接器
  //（不经过 Node 的 CJS 解析，_resolveFilename 补丁拦不住），单测环境不可达；
  // 抽屉文件的形状由 canvasNodeDrawers.spec.js 的源码守卫钉住。
  it.skip('业务节点：动态 require 抽屉组件、下一拍标记加载完成', async () => {
    const openDrawer = vi.fn()
    const retriever = makeNode({ id: 'n1', shape: 'RETRIEVER' })
    const query = makeNode({ id: 'q1', shape: 'QUERY' })
    const response = makeNode({ id: 'r1', shape: 'RESPONSE' })
    const ctx = createCtx({
      graph: {
        getCellById: id => ({ n1: retriever }[id] || null),
        getIncomingEdges: () => [makeEdge({ sourceId: 'q1' })],
        getNodes: () => [retriever, query, response]
      },
      $refs: { drawerFrameRef: { openDrawer } }
    })
    methods.editCardHandle.call(ctx, { id: 'n1' })

    expect(ctx.currentNodeId).toBe('n1')
    expect(ctx.currentNodeData).toMatchObject({ id: 'n1', componentType: 'RETRIEVER', label: 'RE-1' })
    expect(ctx.drawerFixed).toBe(false)
    expect(ctx.drawerOperatorCount).toBe(1)
    expect(ctx.drawerBasics).toEqual({ label: 'RE-1', upstreams: ['q1'] })
    // 上游候选：排除自己与 RESPONSE；QUERY 用「问题」文案，其余用模块标题
    expect(ctx.drawerUpstreamOptions).toEqual([
      { id: 'q1', label: 'modules.workflow.question · RE-1' },
      { id: 'r1', label: '标题-RESPONSE · RE-1' }
    ])
    expect(ctx.dynamicComponent).toBeTruthy() // = lodash 函数（见上方 _resolveFilename 补丁说明）
    expect(ctx.isComponentLoaded).toBe(true) // $nextTick 桩是同步执行
    expect(openDrawer).toHaveBeenCalledWith('RETRIEVER')
  })
})

describe('confirmNodeDeletion / removeNodeWithBridge / deleteCurrentNode / deleteNode', () => {
  it('固定节点或缺失节点不弹确认，返回 false', async () => {
    const ctx = createCtx({ graph: { getCellById: () => null } })
    await expect(methods.confirmNodeDeletion.call(ctx, 'x')).resolves.toBe(false)

    const query = makeNode({ id: 'q1', shape: 'QUERY' })
    ctx.graph = { getCellById: () => query }
    await expect(methods.confirmNodeDeletion.call(ctx, 'q1')).resolves.toBe(false)
    expect(deletion.open).toBe(false)
  })

  it('业务节点：弹统一确认框；用户确认 → true，取消 → false', async () => {
    const node = makeNode({ id: 'n1', shape: 'RETRIEVER' })
    const ctx = createCtx({ graph: { getCellById: () => node } })
    const pending = methods.confirmNodeDeletion.call(ctx, 'n1')
    await Promise.resolve()
    expect(deletion.open).toBe(true)
    expect(deletion.options.items[0]).toMatchObject({ id: 'n1', name: '名-n1' })
    expect(deletion.options.verification).toBe(false)
    settleDeletion(true)
    await expect(pending).resolves.toBe(true)

    const pending2 = methods.confirmNodeDeletion.call(ctx, 'n1')
    await Promise.resolve()
    settleDeletion(false)
    await expect(pending2).resolves.toBe(false)
  })

  it('removeNodeWithBridge：上游 × 下游桥接成边，已存在的边不重复加', () => {
    const node = makeNode({ id: 'n1' })
    const graph = {
      getIncomingEdges: () => [makeEdge({ id: 'in1', sourceId: 'q1' })],
      getOutgoingEdges: () => [makeEdge({ id: 'out1', sourceId: 'n1', targetId: 'r1' })],
      getEdges: () => [{ getSourceCellId: () => 'q1', getTargetCellId: () => 'r1' }],
      getCellById: () => ({ getPortsByGroup: () => [{ id: 'r-in' }] }),
      removeNode: vi.fn(),
      addEdge: vi.fn()
    }
    const ctx = createCtx({ graph })
    methods.removeNodeWithBridge.call(ctx, 'n1')
    expect(graph.removeNode).toHaveBeenCalledWith('n1')
    expect(graph.addEdge).not.toHaveBeenCalled() // q1→r1 已存在
    expect(ctx.scheduleGeometrySync).toHaveBeenCalled()
    expect(ctx.syncGraphStats).toHaveBeenCalled()
  })

  it('removeNodeWithBridge：没有现成边时补桥接；下游没有输入端口则跳过', () => {
    const node = makeNode({ id: 'n1' })
    let noPort = false
    const graph = {
      getIncomingEdges: () => [
        makeEdge({ id: 'in1', sourceId: 'q1', sourcePort: 'q-out' }),
        makeEdge({ id: 'in2', sourceId: 'q2', sourcePort: 'q2-out' })
      ],
      getOutgoingEdges: () => [makeEdge({ id: 'out1', sourceId: 'n1', targetId: 'r1' })],
      getEdges: () => [],
      getCellById: () => ({ getPortsByGroup: () => (noPort ? [] : [{ id: 'r-in' }]) }),
      removeNode: vi.fn(),
      addEdge: vi.fn()
    }
    const ctx = createCtx({ graph })
    methods.removeNodeWithBridge.call(ctx, 'n1')
    // q1→r1 与 q2→r1 两条桥
    expect(graph.addEdge).toHaveBeenCalledTimes(2)
    expect(graph.addEdge.mock.calls[0][0]).toMatchObject({
      source: { cell: 'q1', port: 'q-out' },
      target: { cell: 'r1', port: 'r-in' }
    })

    // 自环（上游就是下游）不桥接；下游无输入端口也不桥接
    noPort = true
    graph.addEdge.mockClear()
    graph.getIncomingEdges = () => [makeEdge({ id: 'in1', sourceId: 'r1' })]
    methods.removeNodeWithBridge.call(ctx, 'n1')
    expect(graph.addEdge).not.toHaveBeenCalled()
  })

  it('deleteCurrentNode：确认后关抽屉并删节点；取消则不动', async () => {
    const node = makeNode({ id: 'n1', shape: 'RETRIEVER' })
    const closeDrawer = vi.fn()
    const ctx = createCtx({
      currentNodeId: 'n1',
      graph: { getCellById: () => node },
      $refs: { drawerFrameRef: { closeDrawer } }
    })
    const pending = methods.deleteCurrentNode.call(ctx)
    await confirmAs(true)
    await pending
    expect(closeDrawer).toHaveBeenCalled()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.removeNodeWithBridge).toHaveBeenCalledWith('n1')
    expect(ctx.currentNodeId).toBe('')

    // 无 id / 确认取消：不删
    const idle = createCtx({ currentNodeId: '' })
    await expect(methods.deleteCurrentNode.call(idle)).resolves.toBeUndefined()
    expect(idle.removeNodeWithBridge).not.toHaveBeenCalled()
  })

  it('deleteNode：卡片删除按钮 → 确认后桥接删除', async () => {
    const node = makeNode({ id: 'n9', shape: 'PRE_RETRIEVER' })
    const ctx = createCtx({ graph: { getCellById: () => node } })
    const pending = methods.deleteNode.call(ctx, 'n9')
    await confirmAs(false)
    await pending
    expect(ctx.removeNodeWithBridge).not.toHaveBeenCalled()

    const pending2 = methods.deleteNode.call(ctx, 'n9')
    await confirmAs(true)
    await pending2
    expect(ctx.removeNodeWithBridge).toHaveBeenCalledWith('n9')
  })
})

describe('抽屉输入连接（refreshDrawerInputs / removeDrawerInput / inputDeleteHandle）', () => {
  it('无图或无当前节点：清空', () => {
    const ctx = createCtx()
    methods.refreshDrawerInputs.call(ctx)
    expect(ctx.drawerInputs).toEqual([])
    ctx.currentNodeId = 'n1'
    methods.refreshDrawerInputs.call(ctx)
    expect(ctx.drawerInputs).toEqual([])
  })

  it('从入边实时取输入；来源缺失显示 --', () => {
    const node = makeNode({ id: 'n1' })
    const ctx = createCtx({
      currentNodeId: 'n1',
      graph: {
        getCellById: id => ({ q1: { store: { data: { label: '开始' } } } }[id] || null),
        getIncomingEdges: () => [makeEdge({ id: 'e1', sourceId: 'q1', sourcePort: 'q-out' }), makeEdge({ id: 'e2' })]
      }
    })
    // 第二条边没有来源节点（getIncomingEdges 里.getSourceCellId 返回 'q1'，这里自造）
    ctx.graph.getIncomingEdges = () => [
      makeEdge({ id: 'e1', sourceId: 'q1', sourcePort: 'q-out' }),
      { id: 'e2', getSourceCellId: () => '', getSourcePortId: () => '' }
    ]
    methods.refreshDrawerInputs.call(ctx)
    expect(ctx.drawerInputs).toEqual([
      { edgeId: 'e1', label: '开始', port: 'q-out' },
      { edgeId: 'e2', label: '--', port: '' }
    ])
    expect(node).toBeTruthy()
  })

  it('removeDrawerInput：删边后刷新输入列表', async () => {
    const removeEdge = vi.fn()
    const ctx = createCtx({
      currentNodeId: 'n1',
      graph: { removeEdge, getIncomingEdges: vi.fn(() => []) }
    })
    methods.removeDrawerInput.call(ctx, 'e1')
    expect(removeEdge).toHaveBeenCalledWith('e1')
    expect(ctx.graph.getIncomingEdges).toHaveBeenCalled()
  })

  it('inputDeleteHandle：只删「端口与来源都对上」的入边', () => {
    const matchEdge = { id: 'e1', getSourcePortId: () => 'p1', getSourceCell: () => ({ id: 'q1' }) }
    const otherPort = { id: 'e2', getSourcePortId: () => 'p2', getSourceCell: () => ({ id: 'q1' }) }
    const otherNode = { id: 'e3', getSourcePortId: () => 'p1', getSourceCell: () => ({ id: 'q2' }) }
    const removeEdge = vi.fn()
    const ctx = createCtx({ graph: { getIncomingEdges: () => [matchEdge, otherPort, otherNode], removeEdge } })
    methods.inputDeleteHandle.call(ctx, { key: 'p1', sourceNode: 'q1' }, 'n1')
    expect(removeEdge).toHaveBeenCalledTimes(1)
    expect(removeEdge).toHaveBeenCalledWith('e1')
    // 没有入边也不抛错
    ctx.graph.getIncomingEdges = () => null
    expect(() => methods.inputDeleteHandle.call(ctx, { key: 'p1', sourceNode: 'q1' }, 'n1')).not.toThrow()
  })
})

describe('applyDrawerUpstreams：上游多选的应用', () => {
  function buildGraph ({ nodes, incoming = [], edges = [] }) {
    return {
      getCellById: id => nodes[id] || null,
      getIncomingEdges: () => incoming,
      getEdges: () => edges,
      removeEdge: vi.fn(),
      addEdge: vi.fn()
    }
  }

  it('目标没有输入端口 / 未选上游：给错误文案', () => {
    const target = makeNode({ id: 'n1' })
    target.getPortsByGroup = vi.fn(() => [])
    const ctx = createCtx({ graph: buildGraph({ nodes: { n1: target } }) })
    expect(methods.applyDrawerUpstreams.call(ctx, target, ['q1'])).toBe('modules.workflow.noInputPort')

    target.getPortsByGroup = vi.fn(() => [{ id: 'n1-in' }])
    expect(methods.applyDrawerUpstreams.call(ctx, target, [])).toBe('modules.workflow.needUpstream')
    expect(methods.applyDrawerUpstreams.call(ctx, target, [''])).toBe('modules.workflow.needUpstream')
  })

  it('上游节点不存在 / 会成环：给错误文案', () => {
    const target = makeNode({ id: 'n1' })
    const ctx = createCtx({ graph: buildGraph({ nodes: { n1: target } }) })
    expect(methods.applyDrawerUpstreams.call(ctx, target, ['ghost'])).toBe('modules.workflow.upstreamMissing')

    // a→n1 已存在，再把 n1→a 补上会成环：先按「删掉全部入边」后的边集检测
    const a = makeNode({ id: 'a' })
    const cycleGraph = buildGraph({
      nodes: { n1: target, a },
      edges: [
        { getSourceCellId: () => 'n1', getTargetCellId: () => 'a' },
        { getSourceCellId: () => 'q1', getTargetCellId: () => 'n1' }
      ]
    })
    const cycleCtx = createCtx({ graph: cycleGraph, wouldCreateCycleInEdges: () => true })
    expect(methods.applyDrawerUpstreams.call(cycleCtx, target, ['a']))
      .toBe('modules.workflow.connectionCycle')
  })

  it('正常应用：删掉未选的入边；已存在的入边不重复加', () => {
    const target = makeNode({ id: 'n1' })
    const query = makeNode({ id: 'q1', shape: 'QUERY' })
    const graph = buildGraph({
      nodes: { n1: target, q1: query },
      incoming: [
        makeEdge({ id: 'keep', sourceId: 'q1' }),
        makeEdge({ id: 'drop', sourceId: 'q2', targetId: 'n1', sourcePort: 'q2-out' })
      ],
      edges: [{ getSourceCellId: () => 'x1', getTargetCellId: () => 'other' }]
    })
    const ctx = createCtx({ graph })
    expect(methods.applyDrawerUpstreams.call(ctx, target, ['q1'])).toBe('')
    expect(graph.removeEdge).toHaveBeenCalledWith('drop')
    // q1→n1 本来就存在：不加边
    expect(graph.addEdge).not.toHaveBeenCalled()
  })

  it('新增来源才补边；来源没有输出端口时静默跳过', () => {
    const target = makeNode({ id: 'n1' })
    const query = makeNode({ id: 'q1', shape: 'QUERY' })
    let noOutPort = false
    const graph = buildGraph({
      nodes: { n1: target, q1: query },
      incoming: [],
      edges: []
    })
    const ctx = createCtx({ graph })
    expect(methods.applyDrawerUpstreams.call(ctx, target, ['q1'])).toBe('')
    expect(graph.addEdge).toHaveBeenCalledWith(expect.objectContaining({
      source: { cell: 'q1', port: 'q1-out-port' },
      target: { cell: 'n1', port: 'n1-in-port' }
    }))

    // 来源节点没有输出端口：跳过加边（不报错）
    noOutPort = true
    query.getPortsByGroup = vi.fn(group => (group === 'out' ? [] : [{ id: 'x' }]))
    graph.addEdge.mockClear()
    expect(methods.applyDrawerUpstreams.call(ctx, target, ['q1'])).toBe('')
    expect(graph.addEdge).not.toHaveBeenCalled()
  })
})

describe('drawerSubmitHandle：校验与应用', () => {
  function buildSubmitCtx ({ componentRef, target, label = '新名字', upstreams = ['q1'], applyError = '' } = {}) {
    const ctx = createCtx({
      currentNodeData: { id: 'n1', componentType: 'RETRIEVER' },
      drawerBasics: { label, upstreams },
      $refs: { RETRIEVERRef: componentRef, drawerFrameRef: { closeDrawer: vi.fn(), showError: vi.fn() } },
      graph: { getCellById: () => target || null },
      applyDrawerUpstreams: vi.fn(() => applyError)
    })
    return ctx
  }

  it('组件缺位 / validate 缺失 / 校验器缺位：直接返回', () => {
    const ctx = buildSubmitCtx({ componentRef: null })
    expect(methods.drawerSubmitHandle.call(ctx)).toBeUndefined()
    expect(ctx.$refs.RETRIEVERRef).toBeNull()

    const noValidate = buildSubmitCtx({ componentRef: {} })
    methods.drawerSubmitHandle.call(noValidate)
    expect(noValidate.applyDrawerUpstreams).not.toHaveBeenCalled()

    const badValidator = buildSubmitCtx({ componentRef: { validate: () => 'not-a-function' } })
    methods.drawerSubmitHandle.call(badValidator)
    expect(badValidator.applyDrawerUpstreams).not.toHaveBeenCalled()
  })

  it('校验不通过：不应用任何配置', async () => {
    const validator = vi.fn(cb => cb(false))
    const componentRef = { validate: vi.fn(() => validator) }
    const ctx = buildSubmitCtx({ componentRef, target: makeNode() })
    methods.drawerSubmitHandle.call(ctx)
    expect(validator).toHaveBeenCalled()
    expect(ctx.applyDrawerUpstreams).not.toHaveBeenCalled()
  })

  it('目标节点丢失：回调里直接返回', async () => {
    const validator = vi.fn(cb => cb(true))
    const ctx = buildSubmitCtx({ componentRef: { validate: () => validator }, target: null })
    methods.drawerSubmitHandle.call(ctx)
    expect(ctx.applyDrawerUpstreams).not.toHaveBeenCalled()
  })

  it('名字为空 / 上游报错：showDrawerError 提示并中断', () => {
    const validator = vi.fn(cb => cb(true))
    const emptyName = buildSubmitCtx({
      componentRef: { validate: () => validator },
      target: makeNode(),
      label: '   '
    })
    methods.drawerSubmitHandle.call(emptyName)
    expect(emptyName.$refs.drawerFrameRef.showError).toHaveBeenCalledWith('modules.workflow.nodeNameRequired')

    const upstreamError = buildSubmitCtx({
      componentRef: { validate: () => validator },
      target: makeNode(),
      applyError: 'modules.workflow.connectionCycle'
    })
    methods.drawerSubmitHandle.call(upstreamError)
    expect(upstreamError.$refs.drawerFrameRef.showError).toHaveBeenCalledWith('modules.workflow.connectionCycle')
  })

  it('应用成功：剥掉 showConfig、写回两份变量、关抽屉并提示', () => {
    const data = { retriever: [{ operator: 'VectorRetriever', showConfig: true }, { operator: 'KeywordRetriever', showConfig: false }] }
    const componentRef = {
      validate: () => vi.fn(cb => cb(true)),
      sendOperatorListData: vi.fn(() => data)
    }
    const target = makeNode({ id: 'n1' })
    const ctx = buildSubmitCtx({ componentRef, target })
    methods.drawerSubmitHandle.call(ctx)

    // showConfig 被剥掉（两份 variables 都不再带）
    expect(data.retriever.every(item => item.showConfig === undefined)).toBe(true)
    expect(target.setProp).toHaveBeenCalledWith('label', '新名字')
    // replaceNodeVariables：setProp('variables') + setData overwrite
    expect(target.setProp).toHaveBeenCalledWith('variables', data)
    expect(target.setData).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveData', variables: data }), { overwrite: true })
    expect(ctx.currentNodeData.label).toBe('新名字')
    expect(ctx.currentNodeData.variables).toBe(data)
    expect(ctx.$refs.drawerFrameRef.closeDrawer).toHaveBeenCalled()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.currentNodeId).toBe('')
    expect(ctx.scheduleGeometrySync).toHaveBeenCalled()
    expect(ctx.syncGraphStats).toHaveBeenCalled()
    expect(ctx.refreshStructKnowledgeFlag).toHaveBeenCalled()
    expect(ctx.$message.success).toHaveBeenCalledWith('modules.workflow.nodeApplied')
  })
})

describe('initCardHandle / drawerCancelHandle / showDrawerError', () => {
  it('initCardHandle：给算子补 ${nodeId}_${i+1} 并写回两份 variables', () => {
    const target = makeNode({ id: 'n1' })
    const ctx = createCtx({ graph: { getCellById: () => target }, shapeAndPortIdMap: { RETRIEVER: 'retriever' } })
    const variables = { retriever: [{ operator: 'VectorRetriever' }, { operator: 'KeywordRetriever' }] }
    methods.initCardHandle.call(ctx, { id: 'n1', componentType: 'RETRIEVER', variables })
    expect(variables.retriever.map(item => item.id)).toEqual(['n1_1', 'n1_2'])
    expect(target.setProp).toHaveBeenCalledWith('variables', variables)
    expect(target.setData).toHaveBeenCalledWith({ type: 'saveData', variables })
    expect(ctx.scheduleGeometrySync).toHaveBeenCalled()
    expect(ctx.syncGraphStats).toHaveBeenCalled()

    // 模块键不在映射里：prop 为 undefined 也不抛错
    expect(() => methods.initCardHandle.call(ctx, {
      id: 'n1', componentType: 'RETRIEVER', variables: { retriever: [] }
    })).not.toThrow()
  })

  it('drawerCancelHandle：清选中态与当前节点', () => {
    const ctx = createCtx({ currentNodeId: 'n1' })
    methods.drawerCancelHandle.call(ctx)
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.currentNodeId).toBe('')
  })

  it('showDrawerError：透传给抽屉骨架；骨架缺位也不抛错', () => {
    const showError = vi.fn()
    const ctx = createCtx({ $refs: { drawerFrameRef: { showError } } })
    methods.showDrawerError.call(ctx, '出错了')
    expect(showError).toHaveBeenCalledWith('出错了')
    methods.showDrawerError.call(createCtx(), '出错了')
  })
})
