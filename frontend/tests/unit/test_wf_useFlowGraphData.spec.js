// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

// 画布 ⇄ 后端 DTO 的双向转换与节点创建。X6 用假 graph。
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

import { useFlowGraphData } from '@/features/workflow/composables/useFlowGraphData'

const methods = useFlowGraphData()

/** 可编程的假节点（setProp/setData/getPortsByGroup 都记录调用）。 */
function makeNode ({ id = 'n1', shape = 'RETRIEVER', label = 'RE-1', ports = {}, variables = null } = {}) {
  return {
    id,
    shape,
    store: { data: { label, ...(variables ? { variables } : {}) } },
    props: {},
    data: null,
    setProp: vi.fn(function (key, value) { this.props[key] = value }),
    setData: vi.fn(function (value) { this.data = value }),
    getPortsByGroup: vi.fn(group => (ports[group] ? [{ id: ports[group] }] : [])),
    getPosition: vi.fn(() => ({ x: 100, y: 100 })),
    position: vi.fn()
  }
}

function createFakeGraph (overrides = {}) {
  const handlers = {}
  const graph = {
    on: (name, fn) => {
      (handlers[name] = handlers[name] || []).push(fn)
    },
    addNode: vi.fn(node => node),
    createNode: vi.fn(config => ({ id: 'new-1', config, setProp: vi.fn(), setData: vi.fn() })),
    addEdge: vi.fn(),
    removeEdge: vi.fn(),
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ cells: [] })),
    getNodes: vi.fn(() => []),
    getEdges: vi.fn(() => []),
    getCellById: vi.fn(() => null),
    getIncomingEdges: vi.fn(() => []),
    getOutgoingEdges: vi.fn(() => []),
    clientToLocal: vi.fn((x, y) => ({ x, y })),
    container: null,
    handlers,
    ...overrides
  }
  return graph
}

function createCtx (overrides = {}) {
  return {
    // composable 方法之间经 this 互调：默认带全套，用例按需覆盖成 spy
    ...methods,
    graph: null,
    jsonDTO: null,
    nodeLoaded: false,
    pendingArrange: false,
    libraryVisible: true,
    portSideCache: { old: {} },
    $t: key => key,
    $message: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn() }),
    $nextTick: fn => fn(),
    syncAllNodeGeometry: vi.fn(),
    layoutWorkflowNodes: vi.fn(),
    zoom: vi.fn(),
    syncGraphStats: vi.fn(),
    editCardHandle: vi.fn(),
    insertNodeBeforeEnd: vi.fn(),
    normalizeNodePorts: vi.fn(),
    scheduleGeometrySync: vi.fn(),
    runPendingArrange: vi.fn(),
    arrangeFallbackTimer: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('initDefaultNode：空画布播种默认节点', () => {
  it('画布为空：补 QUERY/RESPONSE 并排版、缩放、统计', () => {
    const graph = createFakeGraph()
    const ctx = createCtx({ graph })
    methods.initDefaultNode.call(ctx)
    expect(graph.addNode).toHaveBeenCalledTimes(2)
    const [first, second] = graph.addNode.mock.calls.map(call => call[0])
    expect(first.shape).toBe('QUERY')
    expect(second.shape).toBe('RESPONSE')
    expect(ctx.syncAllNodeGeometry).toHaveBeenCalled()
    expect(ctx.layoutWorkflowNodes).toHaveBeenCalled()
    expect(ctx.zoom).toHaveBeenCalledWith('fit')
    expect(ctx.syncGraphStats).toHaveBeenCalled()
  })

  it('画布已有节点：什么都不做', () => {
    const graph = createFakeGraph({ toJSON: () => ({ cells: [{ id: 'n1' }] }) })
    const ctx = createCtx({ graph })
    methods.initDefaultNode.call(ctx)
    expect(graph.addNode).not.toHaveBeenCalled()
  })
})

describe('insertNodeBeforeEnd：新节点接在结束前', () => {
  it('没有结束节点：直接返回', () => {
    const graph = createFakeGraph({ getNodes: () => [] })
    const ctx = createCtx({ graph })
    methods.insertNodeBeforeEnd.call(ctx, makeNode({ id: 'new' }))
    expect(graph.addEdge).not.toHaveBeenCalled()
  })

  it('端口缺失：不接', () => {
    const end = makeNode({ id: 'end', shape: 'RESPONSE', ports: {} })
    const node = makeNode({ id: 'new', ports: { in: 'new-in', out: 'new-out' } })
    const graph = createFakeGraph({ getNodes: () => [end], getIncomingEdges: () => [] })
    const ctx = createCtx({ graph })
    methods.insertNodeBeforeEnd.call(ctx, node)
    expect(graph.addEdge).not.toHaveBeenCalled()
  })

  it('把结束节点的原上游改挂到新节点，新节点再连结束', () => {
    const end = makeNode({ id: 'end', shape: 'RESPONSE', ports: { in: 'end-in' } })
    const node = makeNode({ id: 'new', ports: { in: 'new-in', out: 'new-out' } })
    const oldEdge = { id: 'old', getSourceCellId: () => 'q1', getSourcePortId: () => 'q-out' }
    const graph = createFakeGraph({
      getNodes: () => [end, node],
      getIncomingEdges: () => [oldEdge]
    })
    const ctx = createCtx({ graph, insertNodeBeforeEnd: methods.insertNodeBeforeEnd })
    methods.insertNodeBeforeEnd.call(ctx, node)
    expect(graph.removeEdge).toHaveBeenCalledWith('old')
    expect(graph.addEdge).toHaveBeenCalledTimes(2)
    expect(graph.addEdge.mock.calls[0][0]).toMatchObject({
      source: { cell: 'q1', port: 'q-out' },
      target: { cell: 'new', port: 'new-in' }
    })
    expect(graph.addEdge.mock.calls[1][0]).toMatchObject({
      source: { cell: 'new', port: 'new-out' },
      target: { cell: 'end', port: 'end-in' }
    })
  })
})

describe('createLibraryNode / addLibraryNode：从模块库添加节点', () => {
  it('createLibraryNode：按 shape 取模板与算子默认值，算子 id 用节点 id 编号', () => {
    const graph = createFakeGraph({ createNode: vi.fn(config => ({ id: 'new-9', config, setProp: vi.fn(), setData: vi.fn() })) })
    const ctx = createCtx({ graph })
    const node = methods.createLibraryNode.call(ctx, 'retriever')
    expect(node.id).toBe('new-9')
    expect(node.config.label).toMatch(/^RE-[0-9a-f]{3}$/)
    expect(node.setProp).toHaveBeenCalledWith('variables', expect.objectContaining({
      retriever: [expect.objectContaining({ operator: 'VectorRetriever', id: 'new-9_1' })]
    }))
    expect(node.setData).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ retriever: [expect.objectContaining({ id: 'new-9_1' })] })
    }))

    // 未知 shape 回落到预检索模板
    const fallback = methods.createLibraryNode.call(ctx, '???')
    expect(fallback.config.label).toMatch(/^PRE-/)
  })

  it('addLibraryNode：超过 60 个节点只弹提示', () => {
    const graph = createFakeGraph({ getNodes: () => new Array(60).fill({}) })
    const ctx = createCtx({ graph })
    methods.addLibraryNode.call(ctx, 'retriever')
    expect(ctx.$message).toHaveBeenCalledWith({ message: 'public.nodeLimit', type: 'warning' })
    expect(graph.createNode).not.toHaveBeenCalled()
  })

  it('addLibraryNode：放到视口中心、与已有节点错开、接链后打开配置抽屉', () => {
    const existing = makeNode({ id: 'old', shape: 'QUERY' })
    const graph = createFakeGraph({
      getNodes: vi.fn()
        // 第一次调用数节点数，第二次/第三次在防重叠循环里
        .mockReturnValueOnce([existing])
        .mockReturnValueOnce([existing])
        .mockReturnValue([existing]),
      container: {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
      },
      clientToLocal: vi.fn(() => ({ x: 400, y: 300 })),
      getCellById: vi.fn(() => ({ id: 'new-1', shape: 'RETRIEVER', store: { data: { label: 'RE-1' } } }))
    })
    const ctx = createCtx({
      graph,
      createLibraryNode: vi.fn(() => {
        const node = makeNode({ id: 'new-1' })
        return node
      })
    })
    // 旧节点恰好在中心位置：while 循环把新节点往下错开 60px
    existing.getPosition = () => ({ x: 268, y: 220 })
    methods.addLibraryNode.call(ctx, 'retriever')

    const created = ctx.createLibraryNode.mock.results[0].value
    expect(created.position).toHaveBeenCalled()
    expect(graph.addNode).toHaveBeenCalledWith(created)
    expect(ctx.insertNodeBeforeEnd).toHaveBeenCalledWith(created)
    expect(ctx.libraryVisible).toBe(false)
    expect(ctx.scheduleGeometrySync).toHaveBeenCalled()
    expect(ctx.syncGraphStats).toHaveBeenCalled()
    expect(ctx.editCardHandle).toHaveBeenCalledWith(expect.objectContaining({
      id: 'new-1',
      componentType: 'RETRIEVER',
      label: 'RE-1'
    }), 'new-1')
  })

  it('addLibraryNode：下一拍节点没了（被清场）不再打开抽屉', () => {
    const graph = createFakeGraph({
      getNodes: () => [],
      container: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
      clientToLocal: () => ({ x: 0, y: 0 }),
      getCellById: () => null
    })
    const ctx = createCtx({ graph, createLibraryNode: () => makeNode({ id: 'x' }) })
    methods.addLibraryNode.call(ctx, 'retriever')
    expect(ctx.editCardHandle).not.toHaveBeenCalled()
  })

  it('addNode：直接把配置交给画布', () => {
    const graph = createFakeGraph()
    const ctx = createCtx({ graph })
    methods.addNode.call(ctx, { shape: 'QUERY' })
    expect(graph.addNode).toHaveBeenCalledWith({ shape: 'QUERY' })
  })
})

describe('normalizeNodePorts / importGraph：DTO 装配', () => {
  it('normalizeNodePorts：有模板的 shape 重写 ports（深拷贝），没有的跳过', () => {
    const retriever = makeNode({ id: 'r', shape: 'RETRIEVER' })
    const custom = makeNode({ id: 'c', shape: 'CUSTOM' })
    const graph = createFakeGraph({ getNodes: () => [retriever, custom] })
    const ctx = createCtx({ graph })
    methods.normalizeNodePorts.call(ctx)
    expect(retriever.setProp).toHaveBeenCalledWith('ports', expect.objectContaining({ groups: expect.anything() }))
    expect(custom.setProp).not.toHaveBeenCalled()
    // 深拷贝：改动不影响模板
    const written = retriever.setProp.mock.calls[0][1]
    expect(written).not.toBe(expect.anything())
  })

  it('importGraph：fromJSON + 建边 + 回填 variables + 立即同步几何；排版等 render:done', () => {
    const target = makeNode({ id: 'n1' })
    target.getPortsByGroup = vi.fn(() => [{ id: 'n1-in' }])
    const graph = createFakeGraph({
      getCellById: id => ({ t1: target, n1: target }[id] || null)
    })
    const ctx = createCtx({
      graph,
      jsonDTO: [
        {
          nodeId: 'n1',
          id: 'n1',
          outputVariables: [{ key: 'q-out', targetNode: 't1' }],
          variables: { retriever: [] }
        }
      ]
    })
    methods.importGraph.call(ctx)
    expect(ctx.nodeLoaded).toBe(true)
    expect(graph.fromJSON).toHaveBeenCalledWith(ctx.jsonDTO)
    expect(ctx.normalizeNodePorts).toHaveBeenCalled()
    expect(graph.addEdge).toHaveBeenCalledWith(expect.objectContaining({
      source: { cell: 'n1', port: 'q-out' },
      target: { cell: 't1', port: 'n1-in' }
    }))
    expect(target.setData).toHaveBeenCalledWith(
      { type: 'displayData', variables: { retriever: [] } },
      { overwrite: true }
    )
    expect(ctx.portSideCache).toEqual({})
    expect(ctx.syncAllNodeGeometry).toHaveBeenCalled()
    expect(ctx.pendingArrange).toBe(true)
    expect(ctx.arrangeFallbackTimer).toBeTruthy()
  })

  it('importGraph(shouldArrange=false)：不排排版；jsonDTO 为空时跳过装配', () => {
    const graph = createFakeGraph({ getCellById: () => makeNode({ id: 'n1' }) })
    const ctx = createCtx({ graph, jsonDTO: null })
    methods.importGraph.call(ctx, false)
    expect(graph.fromJSON).not.toHaveBeenCalled()
    expect(ctx.pendingArrange).toBe(false)
    expect(ctx.syncAllNodeGeometry).toHaveBeenCalled()

    const ctx2 = createCtx({
      graph,
      jsonDTO: [{ id: 'n1', outputVariables: [] }],
      arrangeFallbackTimer: 42
    })
    methods.importGraph.call(ctx2, false)
    // outputVariables 是空数组：不建边
    expect(graph.addEdge).not.toHaveBeenCalled()
    expect(ctx2.nodeLoaded).toBe(true)
  })

  it('importGraph：兜底计时器到期时尝试排版', () => {
    vi.useFakeTimers()
    const graph = createFakeGraph({ getCellById: () => makeNode({ id: 'n1' }) })
    const ctx = createCtx({ graph, jsonDTO: [{ id: 'n1', outputVariables: [] }] })
    methods.importGraph.call(ctx)
    vi.advanceTimersByTime(500)
    expect(ctx.runPendingArrange).toHaveBeenCalled()
    expect(ctx.arrangeFallbackTimer).toBeNull()
    vi.useRealTimers()
  })
})

describe('generateRandomUUID', () => {
  it('产出 3 位小写十六进制串（去掉横线取前 3 位）', () => {
    for (let i = 0; i < 20; i++) {
      expect(methods.generateRandomUUID()).toMatch(/^[0-9a-f]{3}$/)
    }
  })
})
