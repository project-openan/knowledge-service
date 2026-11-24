// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

// types.ts 在 import 期用 webpack require 拉 svg（vitest 解析不了），换形状等价的桩
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

// 卡片几何 / 端口 / 线中段箭头 / 排版缩放：composable 方法映射 + 假 this + 假 graph。
// X6 不进单测；视图容器用真实 DOM 元素（decorateEdges 要 querySelector/appendChild）。
// types.ts 桩见上
import { useFlowGeometry } from '@/features/workflow/composables/useFlowGeometry'
import { nodeGeometry } from '@/features/workflow/lib/flowGeometry'

const methods = useFlowGeometry()

function createFakeGraph (overrides = {}) {
  const handlers = {}
  return {
    on: (name, fn) => {
      (handlers[name] = handlers[name] || []).push(fn)
    },
    zoom: vi.fn(() => 1),
    zoomTo: vi.fn(),
    translate: vi.fn(),
    getNodes: vi.fn(() => []),
    getEdges: vi.fn(() => []),
    getCellById: vi.fn(() => null),
    findViewByCell: vi.fn(() => null),
    getIncomingEdges: vi.fn(() => []),
    getOutgoingEdges: vi.fn(() => []),
    handlers,
    ...overrides
  }
}

function createCtx (overrides = {}) {
  return {
    // composable 方法之间经 this 互调：默认带全套方法，用例里按需覆盖成 spy
    ...methods,
    graph: null,
    $t: (key, params) => key + (params ? '|' + Object.values(params).join('|') : ''),
    $nextTick: fn => fn(),
    portSideCache: {},
    ...overrides
  }
}

/** 带几何数据的最小节点桩。 */
function makeNode ({ id = 'n1', shape = 'RETRIEVER', variables, x = 0, y = 0, size = { width: 264, height: 200 } } = {}) {
  const storeData = shape === 'QUERY' || shape === 'RESPONSE'
    ? { shape }
    : { shape, data: { variables: variables || { retriever: [{ operator: 'VectorRetriever' }] } } }
  return {
    id,
    shape,
    store: { data: storeData },
    getSize: vi.fn(() => size),
    setPosition: vi.fn(),
    getPosition: vi.fn(() => ({ x, y })),
    resize: vi.fn(),
    portProp: vi.fn(),
    getPorts: vi.fn(() => []),
    getPortsByGroup: vi.fn(() => []),
    position: vi.fn()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('模块标题 / 语气', () => {
  it('moduleTitleKeyOf：已知 shape 给键，未知给空串', () => {
    expect(methods.moduleTitleKeyOf('RETRIEVER')).toBe('ragFlow.retrieverTitle')
    expect(methods.moduleTitleKeyOf('QUERY')).toBe('ragFlow.start')
    expect(methods.moduleTitleKeyOf('RESPONSE')).toBe('ragFlow.end')
    expect(methods.moduleTitleKeyOf('NOPE')).toBe('')
  })

  it('moduleTitleOf：走 $t；未知 shape 为空', () => {
    const ctx = createCtx()
    expect(methods.moduleTitleOf.call(ctx, 'PRE_RETRIEVER')).toBe('ragFlow.preretrieverTitle')
    expect(methods.moduleTitleOf.call(ctx, 'NOPE')).toBe('')
  })

  it('moduleToneOf：各模块固定语气，未知回落 blue', () => {
    expect(methods.moduleToneOf('RETRIEVER')).toBe('orange')
    expect(methods.moduleToneOf('RESPONSE_SYNTHESIZER')).toBe('green')
    expect(methods.moduleToneOf('POST_RETRIEVER')).toBe('blue')
    expect(methods.moduleToneOf('NOPE')).toBe('blue')
  })
})

describe('节点几何', () => {
  it('nodeVariables：data.data.variables 优先，退回 data.variables', () => {
    expect(methods.nodeVariables({ store: { data: { data: { variables: 'inner' } } } })).toBe('inner')
    expect(methods.nodeVariables({ store: { data: { variables: 'outer' } } })).toBe('outer')
    expect(methods.nodeVariables(null)).toBeUndefined()
  })

  it('nodeGeometryFor：按 shape + 算子数 + 入边数算几何', () => {
    const ctx = createCtx({ graph: createFakeGraph({ getIncomingEdges: () => [{}, {}] }) })
    const geometry = methods.nodeGeometryFor.call(ctx, makeNode({ shape: 'RETRIEVER' }))
    expect(geometry.width).toBe(264)
    // 检索器 1 算子 + 2 入边 → 与 lib 的 nodeGeometry 一致
    expect(geometry).toEqual(nodeGeometry({ shape: 'RETRIEVER', operatorCount: 1, inputCount: 2 }))
  })

  it('scheduleGeometrySync：同一帧只排一次', async () => {
    const raf = vi.fn(cb => setTimeout(() => cb(performance.now()), 0))
    vi.stubGlobal('requestAnimationFrame', raf)
    const ctx = createCtx({ syncAllNodeGeometry: vi.fn() })
    methods.scheduleGeometrySync.call(ctx)
    methods.scheduleGeometrySync.call(ctx)
    expect(raf).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(ctx.syncAllNodeGeometry).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})

describe('syncAllNodeGeometry：尺寸与端口回写', () => {
  function buildCtx ({ nodes, incoming, outgoing }) {
    const ctx = createCtx({
      scheduleEdgeDecorations: vi.fn(),
      nodeGeometryFor: node => nodeGeometry({
        shape: node.shape,
        operatorCount: 1,
        inputCount: 1
      })
    })
    ctx.graph = createFakeGraph({
      getNodes: () => nodes,
      getIncomingEdges: () => incoming || [],
      getOutgoingEdges: () => outgoing || []
    })
    return ctx
  }

  it('无 graph 直接返回', () => {
    const ctx = createCtx()
    expect(methods.syncAllNodeGeometry.call(ctx)).toBeUndefined()
  })

  it('尺寸偏差超过 0.5px 时 resize（silent）', () => {
    const node = makeNode({ id: 'a', shape: 'RETRIEVER', size: { width: 1, height: 1 } })
    const ctx = buildCtx({ nodes: [node] })
    methods.syncAllNodeGeometry.call(ctx)
    expect(node.resize).toHaveBeenCalled()
    const [width, height, options] = node.resize.mock.calls[0]
    expect(width).toBe(264)
    expect(height).toBeGreaterThan(1)
    expect(options).toEqual({ silent: true })
  })

  it('尺寸一致时不 resize；端口坐标变化才写 portProp', () => {
    const geometry = nodeGeometry({ shape: 'RETRIEVER', operatorCount: 1, inputCount: 1 })
    const node = makeNode({
      id: 'a',
      shape: 'RETRIEVER',
      size: { width: geometry.width, height: geometry.frameHeight }
    })
    node.getPortsByGroup = vi.fn(group => [{
      id: `port-${group}`,
      args: { x: -1, y: -1 }
    }])
    const ctx = buildCtx({ nodes: [node] })
    methods.syncAllNodeGeometry.call(ctx)
    expect(node.resize).not.toHaveBeenCalled()
    // in 端口在左侧（无对端 → fallback left）：坐标从 (-1,-1) 修正到 (0, inputY)
    expect(node.portProp).toHaveBeenCalledWith('port-in', 'args', { x: 0, y: geometry.inputY })
    expect(node.portProp).toHaveBeenCalledWith('port-out', 'args', { x: geometry.width, y: geometry.outputY })
    // 记下朝向缓存，并触发装饰刷新
    expect(ctx.portSideCache.a).toEqual({ input: 'left', output: 'right' })
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })

  it('端口坐标已正确：不再写 portProp', () => {
    const geometry = nodeGeometry({ shape: 'RETRIEVER', operatorCount: 1, inputCount: 1 })
    const node = makeNode({ id: 'a', shape: 'RETRIEVER', size: { width: geometry.width, height: geometry.frameHeight } })
    node.getPortsByGroup = vi.fn(group => [{ id: `port-${group}`, args: group === 'in'
      ? { x: 0, y: geometry.inputY }
      : { x: geometry.width, y: geometry.outputY } }])
    const ctx = buildCtx({ nodes: [node] })
    methods.syncAllNodeGeometry.call(ctx)
    expect(node.portProp).not.toHaveBeenCalled()
  })

  it('对端节点给出时按相对位置选上/下端口；对端不在缓存里跳过', () => {
    // 上游在正上方：输入端口朝上
    const geometry = nodeGeometry({ shape: 'RETRIEVER', operatorCount: 1, inputCount: 1 })
    const node = makeNode({
      id: 'b', shape: 'RETRIEVER', x: 100, y: 400,
      size: { width: geometry.width, height: geometry.frameHeight }
    })
    const peer = makeNode({ id: 'a', shape: 'QUERY', x: 100, y: 0, size: { width: 264, height: 140 } })
    node.getPortsByGroup = vi.fn(group => [{ id: `port-${group}`, args: { x: -9, y: -9 } }])
    peer.getPortsByGroup = vi.fn(() => [])
    const ctx = buildCtx({ nodes: [node, peer], incoming: [{ getSourceCellId: () => 'a' }] })
    methods.syncAllNodeGeometry.call(ctx)
    // 上游 (y=0,高140+16) 在 b (y=400) 上方 → input 端口朝上
    expect(ctx.portSideCache.b.input).toBe('top')
    expect(node.portProp).toHaveBeenCalledWith('port-in', 'args', { x: geometry.width / 2, y: 0 })
  })

  it('applyPortPosition：该组没有端口时直接返回', () => {
    const node = makeNode({ id: 'a' })
    node.getPortsByGroup = vi.fn(() => [])
    methods.applyPortPosition.call(createCtx(), node, 'in', 'left', 'input', { width: 264, inputY: 10 })
    expect(node.portProp).not.toHaveBeenCalled()
  })
})

describe('线中段箭头（decorateEdges / scheduleEdgeDecorations）', () => {
  function makeEdgeView ({ preview = false, selectedEdge = null, withPath = true, withPoints = true } = {}) {
    const container = document.createElement('div')
    if (withPath) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      container.appendChild(path)
    }
    const edge = {
      id: 'e1',
      getData: () => (preview ? { preview: true } : {}),
      getSourceCellId: () => 'q1',
      getTargetCellId: () => 'r1',
      getSourcePortId: () => 'sp',
      getTargetPortId: () => 'tp',
      model: { getCell: () => null }
    }
    const view = {
      container,
      sourcePoint: withPoints ? { x: 0, y: 0 } : null,
      targetPoint: withPoints ? { x: 300, y: 0 } : null
    }
    return { edge, view, container }
  }

  it('无 graph 直接返回', () => {
    expect(methods.decorateEdges.call(createCtx())).toBeUndefined()
  })

  it('正式边：挂连接类名、补 path 的 a11y 属性、创建并定位箭头', () => {
    const { edge, view, container } = makeEdgeView()
    const ctx = createCtx({
      graph: createFakeGraph({
        zoom: () => 1.2,
        getEdges: () => [edge],
        findViewByCell: () => view,
        getNodes: () => []
      }),
      nodeDisplayName: vi.fn(id => `名-${id}`),
      selectedEdge: { id: 'e1' }
    })
    methods.decorateEdges.call(ctx)

    expect(container.classList.contains('flow-connection')).toBe(true)
    expect(container.classList.contains('flow-edge-preview')).toBe(false)
    expect(container.classList.contains('selected')).toBe(true)
    const path = container.querySelector('path')
    expect(path.getAttribute('tabindex')).toBe('0')
    expect(path.getAttribute('role')).toBe('button')
    expect(path.getAttribute('aria-label')).toContain('名-q1')
    const arrow = container.querySelector('.flow-edge-direction')
    expect(arrow).toBeTruthy()
    expect(arrow.getAttribute('transform')).toContain('scale(')
    // 1/1.2 缩放
    expect(arrow.getAttribute('transform')).toContain('scale(0.8333333333333334)')
  })

  it('预览边：只挂预览类名，不补箭头/选中态', () => {
    const { edge, view, container } = makeEdgeView({ preview: true })
    const ctx = createCtx({
      graph: createFakeGraph({
        getEdges: () => [edge],
        findViewByCell: () => view,
        getNodes: () => []
      }),
      selectedEdge: { id: 'e1' }
    })
    methods.decorateEdges.call(ctx)
    expect(container.classList.contains('flow-edge-preview')).toBe(true)
    expect(container.classList.contains('flow-connection')).toBe(false)
    expect(container.classList.contains('selected')).toBe(false)
    expect(container.querySelector('.flow-edge-direction')).toBeNull()
  })

  it('视图缺失 / path 与端点缺失都不抛错', () => {
    const edge = { id: 'e1', getData: () => ({}) }
    const ctx = createCtx({
      graph: createFakeGraph({ getEdges: () => [edge], findViewByCell: () => null, getNodes: () => [] })
    })
    expect(() => methods.decorateEdges.call(ctx)).not.toThrow()

    const noPath = makeEdgeView({ withPath: false })
    const ctx2 = createCtx({
      graph: createFakeGraph({ getEdges: () => [noPath.edge], findViewByCell: () => noPath.view, getNodes: () => [] })
    })
    expect(() => methods.decorateEdges.call(ctx2)).not.toThrow()
    // 没有端点：箭头已创建但 transform 不写
    expect(noPath.container.querySelector('.flow-edge-direction')).toBeTruthy()
  })

  it('scheduleEdgeDecorations 同帧去重；settle 阶段按 idle/timeout 二次贴箭头', async () => {
    const raf = vi.fn(cb => setTimeout(() => cb(performance.now()), 0))
    vi.stubGlobal('requestAnimationFrame', raf)
    const decorateEdges = vi.fn()
    const ctx = createCtx({ decorateEdges })
    methods.scheduleEdgeDecorations.call(ctx)
    methods.scheduleEdgeDecorations.call(ctx)
    expect(raf).toHaveBeenCalledTimes(1)
    // rAF 贴一次箭头；idle 回调在 jsdom 里不存在 → settle 走 setTimeout 兜底再贴一次
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(decorateEdges).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('decoratePortA11y：给每个端口补 tabindex/role/aria', () => {
    const inEl = document.createElement('div')
    inEl.setAttribute('port', 'p-in')
    const outEl = document.createElement('div')
    outEl.setAttribute('port', 'p-out')
    const container = document.createElement('div')
    container.appendChild(inEl)
    container.appendChild(outEl)
    const node = makeNode({ id: 'q1', shape: 'QUERY' })
    node.getPorts = vi.fn(() => [{ id: 'p-in', group: 'in' }, { id: 'p-out', group: 'out' }, { id: null }])
    const ctx = createCtx({
      graph: createFakeGraph({ getNodes: () => [node], findViewByCell: () => ({ container }) }),
      moduleTitleOf: () => '开始'
    })
    methods.decoratePortA11y.call(ctx)
    expect(inEl.getAttribute('aria-label')).toContain('开始')
    expect(inEl.getAttribute('tabindex')).toBe('0')
    expect(outEl.getAttribute('aria-label')).toContain('开始')
    // 视图缺失：静默跳过
    ctx.graph.findViewByCell = () => null
    expect(() => methods.decoratePortA11y.call(ctx)).not.toThrow()
  })

  it('nodeDisplayName：无 cell 回原 id；有 cell 取标题或 label', () => {
    const ctx = createCtx()
    expect(methods.nodeDisplayName.call(ctx, 'missing')).toBe('missing')
    ctx.graph = createFakeGraph({ getCellById: () => ({ shape: 'RETRIEVER', store: { data: { label: 'RE-1' } } }) })
    expect(methods.nodeDisplayName.call(ctx, 'r1')).toBe('ragFlow.retrieverTitle')
    ctx.graph = createFakeGraph({ getCellById: () => ({ shape: 'CUSTOM', store: { data: { label: '自定义' } } }) })
    expect(methods.nodeDisplayName.call(ctx, 'c1')).toBe('自定义')
  })
})

describe('拓扑排版与缩放', () => {
  it('topologicalOrderNodes：按入度出拓扑序；剩余（成环）节点追加在尾部', () => {
    const q = makeNode({ id: 'q' })
    const r = makeNode({ id: 'r' })
    const s = makeNode({ id: 's' })
    const incoming = {
      q: [],
      r: [{ getTargetCellId: () => 'r' }],
      s: [{ getTargetCellId: () => 's' }]
    }
    const outgoing = {
      q: [{ getTargetCellId: () => 'r' }, { getTargetCellId: () => 's' }],
      r: [],
      s: []
    }
    const graph = createFakeGraph({
      getNodes: () => [q, r, s],
      getIncomingEdges: node => incoming[node.id],
      getOutgoingEdges: node => outgoing[node.id],
      getCellById: id => ({ q, r, s }[id])
    })
    const ctx = createCtx({ graph })
    expect(methods.topologicalOrderNodes.call(ctx).map(n => n.id)).toEqual(['q', 'r', 's'])
  })

  it('layoutWorkflowNodes：空图直接返回；两节点按列布局并清朝向缓存', () => {
    const ctx = createCtx({
      portSideCache: { a: { input: 'left' } },
      syncAllNodeGeometry: vi.fn(),
      nodeGeometryFor: () => ({ width: 264, height: 140 })
    })
    methods.layoutWorkflowNodes.call(ctx) // 空 graph：不抛错
    expect(ctx.syncAllNodeGeometry).not.toHaveBeenCalled()

    const a = makeNode({ id: 'a' })
    const b = makeNode({ id: 'b' })
    ctx.graph = createFakeGraph({ getNodes: () => [a, b] })
    ctx.topologicalOrderNodes = vi.fn(() => [a, b])
    methods.layoutWorkflowNodes.call(ctx)
    expect(a.position).toHaveBeenCalledWith(60, 60)
    // 第二张卡在第一张下方：60 + 140 + 48
    expect(b.position).toHaveBeenCalledWith(60, 60 + 140 + 48)
    expect(ctx.portSideCache).toEqual({})
    expect(ctx.syncAllNodeGeometry).toHaveBeenCalled()
  })

  it('arrangeWorkflow：空图返回；有图收起工具抽屉、重排并 fit', () => {
    const ctx = createCtx({ toolsOpen: true, layoutWorkflowNodes: vi.fn(), zoom: vi.fn() })
    methods.arrangeWorkflow.call(ctx) // 空 graph
    expect(ctx.toolsOpen).toBe(true)

    ctx.graph = createFakeGraph({ getNodes: () => [makeNode()] })
    methods.arrangeWorkflow.call(ctx)
    expect(ctx.toolsOpen).toBe(false)
    expect(ctx.layoutWorkflowNodes).toHaveBeenCalled()
    expect(ctx.zoom).toHaveBeenCalledWith('fit')
  })

  it('resetZoom：无 graph 返回；有 graph 回 100% 并刷新装饰', () => {
    const ctx = createCtx({ scheduleEdgeDecorations: vi.fn() })
    methods.resetZoom.call(ctx)
    expect(ctx.graph).toBeNull()
    ctx.graph = createFakeGraph()
    methods.resetZoom.call(ctx)
    expect(ctx.graph.zoomTo).toHaveBeenCalledWith(1)
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })

  it('zoom：in/out 按 15% 步进并夹在 0.2–1.6', () => {
    const ctx = createCtx({ graph: createFakeGraph({ zoom: vi.fn(() => 1.5) }) })
    methods.zoom.call(ctx, 'in')
    expect(ctx.graph.zoom).toHaveBeenLastCalledWith(1.6, { absolute: true })

    // 0.2 / 1.15 < 0.2 → 夹在下限
    ctx.graph = createFakeGraph({ zoom: vi.fn(() => 0.2) })
    methods.zoom.call(ctx, 'out')
    expect(ctx.graph.zoom).toHaveBeenLastCalledWith(0.2, { absolute: true })

    ctx.graph = createFakeGraph({ zoom: vi.fn(() => 1) })
    methods.zoom.call(ctx, 'out')
    expect(ctx.graph.zoom).toHaveBeenLastCalledWith(1 / 1.15, { absolute: true })
  })

  it('zoom：fit 分支 —— 无节点返回；能放下时居中', () => {
    const ctx = createCtx({
      graph: createFakeGraph(),
      getCanvasSize: () => ({ width: 1000, height: 800 })
    })
    methods.zoom.call(ctx, 'fit') // 空画布
    expect(ctx.graph).toBeTruthy()

    const node = makeNode({ x: 0, y: 0 })
    ctx.graph = createFakeGraph({ getNodes: () => [node] })
    ctx.getCanvasSize = () => ({ width: 1000, height: 800 })
    ctx.getNodeDisplaySize = () => ({ width: 264, height: 320 })
    methods.zoom.call(ctx, 'fit')
    // 内容 264×320，画布 1000×800：zoom=min(1.6, 940/264≈3.56, 740/320≈2.31, 1)=1
    expect(ctx.graph.zoomTo).toHaveBeenCalledWith(1)
    // translateX = (1000-264)/2 - 0；translateY = (800-320)/2
    expect(ctx.graph.translate).toHaveBeenCalledWith((1000 - 264) / 2, (800 - 320) / 2)
  })

  it('zoom：fit 分支 —— 放不下时缩到最小并贴左上（留 24px）', () => {
    const node = makeNode({ x: 0, y: 0 })
    const ctx = createCtx({
      graph: createFakeGraph({ getNodes: () => [node] }),
      getCanvasSize: () => ({ width: 300, height: 200 }),
      getNodeDisplaySize: () => ({ width: 2000, height: 1600 })
    })
    methods.zoom.call(ctx, 'fit')
    // zoom = max(0.2, min(240/2000, 140/1600, 1)) = 0.2
    expect(ctx.graph.zoomTo).toHaveBeenCalledWith(0.2)
    // 内容缩放后 400×320 > 画布内区 → 走 24 - minX*zoom = 24
    expect(ctx.graph.translate).toHaveBeenCalledWith(24, 24)
  })

  it('updateOuputPortForSingleOutput / updatePortAfterChangingOperators 都走几何同步', () => {
    const ctx = createCtx({ scheduleGeometrySync: vi.fn() })
    methods.updateOuputPortForSingleOutput.call(ctx)
    methods.updatePortAfterChangingOperators.call(ctx)
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(2)
  })
})

describe('统计与来源类型', () => {
  it('syncGraphStats：节点/非预览边/算子数与来源类型', () => {
    const retriever = makeNode({ id: 'r', shape: 'RETRIEVER' })
    const query = makeNode({ id: 'q', shape: 'QUERY' })
    const previewEdge = { getData: () => ({ preview: true }) }
    const realEdge = { getData: () => ({}) }
    const ctx = createCtx({
      graph: createFakeGraph({
        getNodes: () => [retriever, query],
        getEdges: () => [previewEdge, realEdge]
      })
    })
    methods.syncGraphStats.call(ctx)
    expect(ctx.nodeCount).toBe(2)
    expect(ctx.edgeCount).toBe(1)
    expect(ctx.operatorCount).toBe(1)
    expect(ctx.sourceKinds).toEqual(['knowledge'])

    // 无 graph：全 0
    const empty = createCtx()
    methods.syncGraphStats.call(empty)
    expect(empty.nodeCount).toBe(0)
    expect(empty.edgeCount).toBe(0)
    expect(empty.operatorCount).toBe(0)
  })

  it('sourceKindOf：meta + 图标（未知类型回落 Document 图标）', () => {
    const knowledge = methods.sourceKindOf('knowledge')
    expect(knowledge.labelKey).toBeTruthy()
    expect(knowledge.icon).toBeTruthy()
    const unknown = methods.sourceKindOf('???')
    expect(unknown.icon).toBeTruthy()
  })

  it('workflowTypeLabel：只绑图谱库 → 图谱检索；其余按引擎映射', () => {
    const ctx = createCtx({
      sourceKinds: ['graph'],
      workflowTypeMap: { BlendedQueryEngine: '混合检索' },
      queryEngineType: 'BlendedQueryEngine'
    })
    expect(methods.workflowTypeLabel.call(ctx)).toBe('modules.workflow.graphRetrieval')

    ctx.sourceKinds = ['knowledge']
    expect(methods.workflowTypeLabel.call(ctx)).toBe('混合检索')

    ctx.queryEngineType = '???'
    expect(methods.workflowTypeLabel.call(ctx)).toBe('')
  })
})
