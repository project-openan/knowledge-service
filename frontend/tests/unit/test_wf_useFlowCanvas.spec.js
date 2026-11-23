// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// X6 不进单测（真 Graph 要 DOM/SVG 全套）：mock 成「记录调用」的假件，
// composable 是方法映射，用假 `this` 逐方法调用即可。
const { registeredConnectors, registeredShapes, graphInstances } = vi.hoisted(() => ({
  registeredConnectors: {},
  registeredShapes: [],
  graphInstances: []
}))

// createEditorGraph 会 new Graph(...)：mock 的 Graph 自带假实例能力（on/zoom/...），
// 让 initGraph 装出来的 ctx.graph 可直接驱动。
vi.mock('@antv/x6', () => {
  class FakeGraph {
    constructor (options) {
      this.options = options
      this.handlers = {}
      graphInstances.push(this)
    }

    on (name, fn) {
      (this.handlers[name] = this.handlers[name] || []).push(fn)
    }

    off () {}

    zoom () {
      return 1
    }

    zoomTo () {}

    resize () {}

    translate () {}

    getNodes () {
      return []
    }

    getEdges () {
      return []
    }
  }

  FakeGraph.registerConnector = (name, factory) => {
    registeredConnectors[name] = factory
  }

  return {
    Graph: FakeGraph,
    Shape: {
      Edge: class {
        constructor (options) {
          this.options = options
        }
      }
    }
  }
})

// x6-editor-core 顶层 import 的插件与 Vue 形状注册：换桩记录调用即可
vi.mock('@antv/x6-plugin-selection', () => ({ Selection: vi.fn(o => ({ o })) }))
vi.mock('@antv/x6-plugin-keyboard', () => ({ Keyboard: vi.fn(o => ({ o })) }))
vi.mock('@antv/x6-plugin-transform', () => ({ Transform: vi.fn(o => ({ o })) }))
vi.mock('@antv/x6-plugin-history', () => ({ History: vi.fn(o => ({ o })) }))
vi.mock('@antv/x6-plugin-clipboard', () => ({ Clipboard: vi.fn(o => ({ o })) }))
vi.mock('@antv/x6-vue-shape', () => ({ register: (...args) => registeredShapes.push(args[0]) }))

// useNodeConfig / 卡片组件链会引 types.ts（import 期用 webpack require 拉 svg，
// vitest 解析不了）；composable 只用它的形状枚举，这里给形状等价的桩。
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

import { useFlowCanvas } from '@/features/workflow/composables/useFlowCanvas'

// composable 是工厂：调用一次得到方法映射，再用假 this 逐方法调。
const methods = useFlowCanvas()

/** 记录事件监听的假 Graph。 */
function createFakeGraph (overrides = {}) {
  const handlers = {}
  const graph = {
    on: (name, fn) => {
      (handlers[name] = handlers[name] || []).push(fn)
    },
    off: vi.fn(),
    zoom: vi.fn(() => 1),
    zoomTo: vi.fn(),
    resize: vi.fn(),
    translate: vi.fn(),
    clearCells: vi.fn(),
    getNodes: vi.fn(() => []),
    getEdges: vi.fn(() => []),
    getCellById: vi.fn(() => null),
    findViewByCell: vi.fn(() => null),
    getIncomingEdges: vi.fn(() => []),
    getOutgoingEdges: vi.fn(() => []),
    toJSON: vi.fn(() => ({ cells: [] })),
    handlers,
    ...overrides
  }
  return graph
}

/** 组件 this 桩：composable 方法都用 `this` 访问组件实例。 */
function createCtx (overrides = {}) {
  return {
    // composable 方法之间互相经 `this` 调用：默认带上全套，用例里再按需覆盖成 spy
    ...methods,
    graph: null,
    zoomPercent: 0,
    $t: key => key,
    $nextTick: fn => fn(),
    timerInterval: 50,
    portSideCache: {},
    ...overrides
  }
}

function fire (handlers, name, payload) {
  (handlers[name] || []).forEach(fn => fn(payload))
}

function makeNode (overrides = {}) {
  return {
    id: 'n1',
    shape: 'RETRIEVER',
    store: { data: { label: 'RE-abc', ...overrides.storeData } },
    getPorts: vi.fn(() => []),
    getPortsByGroup: vi.fn(() => []),
    getSize: vi.fn(() => ({ width: 264, height: 160 })),
    getPosition: vi.fn(() => ({ x: 0, y: 0 })),
    resize: vi.fn(),
    portProp: vi.fn(),
    attr: vi.fn(),
    ...overrides.cell
  }
}

beforeEach(() => {
  document.body.innerHTML = '<div id="advancedFLow"></div>'
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('initGraph：画布装配', () => {
  it('装配 Graph、写回缩放百分比并挂 scale 监听', () => {
    const ctx = createCtx({ getCanvasSize: () => ({ width: 1000, height: 500 }) })
    methods.initGraph.call(ctx)

    expect(graphInstances).toHaveLength(1)
    expect(ctx.graph).toBeTruthy()
    expect(ctx.zoomPercent).toBe(100) // 假 zoom() = 1
    // 差异配置：工作流自己的缩放范围与 flow-adaptive 连线器
    expect(ctx.graph.options.mousewheel).toEqual({ enabled: true, minScale: 0.2, maxScale: 1.6 })
    expect(ctx.graph.options.connecting.connector.name).toBe('flow-adaptive')
    expect(ctx.graph.options.container).toBe(document.getElementById('advancedFLow'))

    // scale 事件 → 缩放百分比同步
    fire(ctx.graph.handlers, 'scale', { sx: 0.5 })
    expect(ctx.zoomPercent).toBe(50)
  })

  it('createEdge：预览边为虚线并带 preview 标记', () => {
    const ctx = createCtx({ getCanvasSize: () => ({ width: 10, height: 10 }) })
    methods.initGraph.call(ctx)
    const edge = ctx.graph.options.connecting.createEdge()
    expect(edge.options.data).toEqual({ preview: true })
    expect(edge.options.attrs.line.strokeDasharray).toBe('6 5')
    expect(edge.options.attrs.line.targetMarker).toBeNull()
  })

  it('validateMagnet：只允许输出桩起连线', () => {
    const ctx = createCtx({ getCanvasSize: () => ({ width: 10, height: 10 }) })
    methods.initGraph.call(ctx)
    const { validateMagnet } = ctx.graph.options.connecting

    expect(validateMagnet({ magnet: { getAttribute: () => 'out' } })).toBe(true)
    expect(validateMagnet({
      magnet: { getAttribute: () => null, parentElement: { getAttribute: () => 'out' } }
    })).toBe(true)
    expect(validateMagnet({ magnet: { getAttribute: () => 'in' } })).toBe(false)
    expect(validateMagnet({ magnet: null })).toBe(false)
  })

  it('validateConnection：同节点/缺端/端口方向/重复边/成环都拒绝', () => {
    const ctx = createCtx({
      getCanvasSize: () => ({ width: 10, height: 10 }),
      wouldCreateCycle: vi.fn(() => false)
    })
    methods.initGraph.call(ctx)
    const { validateConnection } = ctx.graph.options.connecting
    const magnet = group => ({ getAttribute: () => group })
    const cell = id => ({ id })

    // 缺端 / 同节点
    expect(validateConnection({ sourceCell: null, targetCell: cell('b') })).toBe(false)
    expect(validateConnection({ sourceCell: cell('a'), targetCell: null })).toBe(false)
    expect(validateConnection({ sourceCell: cell('a'), targetCell: cell('a') })).toBe(false)
    // 端口方向不对
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('in'), targetMagnet: magnet('in')
    })).toBe(false)
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('out'), targetMagnet: magnet('out')
    })).toBe(false)
    // 目标磁铁没有属性时回退父元素
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('out'),
      targetMagnet: { getAttribute: () => null, parentElement: { getAttribute: () => 'in' } }
    })).toBe(true)
    // 重复同向边
    ctx.graph.getEdges = vi.fn(() => [
      { getSourceCellId: () => 'a', getTargetCellId: () => 'b' }
    ])
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('out'), targetMagnet: magnet('in')
    })).toBe(false)
    // 成环
    ctx.graph.getEdges = vi.fn(() => [])
    ctx.wouldCreateCycle = vi.fn(() => true)
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('out'), targetMagnet: magnet('in')
    })).toBe(false)
    // 合法连线
    ctx.wouldCreateCycle = vi.fn(() => false)
    expect(validateConnection({
      sourceCell: cell('a'), targetCell: cell('b'),
      sourceMagnet: magnet('out'), targetMagnet: magnet('in')
    })).toBe(true)
  })
})

describe('applyGraphTheme / getCanvasSize / getNodeDisplaySize', () => {
  it('applyGraphTheme：无 graph 直接返回；有 graph 只重写 paint', () => {
    const ctx = createCtx()
    methods.applyGraphTheme.call(ctx) // 无 graph：不抛错

    const edgeCell = { attr: vi.fn() }
    const node = { getPorts: () => [{ id: 'p1' }], portProp: vi.fn() }
    ctx.graph = createFakeGraph({ getEdges: () => [edgeCell], getNodes: () => [node] })
    methods.applyGraphTheme.call(ctx)

    expect(edgeCell.attr).toHaveBeenCalledWith('line', expect.objectContaining({ strokeWidth: 1.6 }))
    // 端口 paint：stroke/fill/dot-fill 三写
    expect(node.portProp).toHaveBeenCalledWith('p1', 'attrs/circle/stroke', expect.any(String))
    expect(node.portProp).toHaveBeenCalledWith('p1', 'attrs/circle/fill', expect.any(String))
    expect(node.portProp).toHaveBeenCalledWith('p1', 'attrs/dot/fill', expect.any(String))
  })

  it('getCanvasSize：优先取 .canvas-viewport 的内容尺寸，缺元素回落 document', () => {
    const ctx = createCtx()
    const area = document.createElement('div')
    area.className = 'canvas-viewport'
    Object.defineProperty(area, 'clientWidth', { value: 900 })
    Object.defineProperty(area, 'clientHeight', { value: 600 })
    const el = { querySelector: selector => (selector === '.canvas-viewport' ? area : null) }
    ctx.$el = el
    window.getComputedStyle = window.getComputedStyle || (() => ({}))
    const original = window.getComputedStyle
    window.getComputedStyle = () => ({ paddingLeft: '10', paddingRight: '20', paddingTop: '5', paddingBottom: '15' })
    expect(methods.getCanvasSize.call(ctx)).toEqual({ width: 870, height: 580 })
    window.getComputedStyle = original

    // 没有 viewport：用 document 尺寸
    ctx.$el = { querySelector: () => null }
    const size = methods.getCanvasSize.call(ctx)
    expect(size.width).toBe(document.documentElement.clientWidth)
    expect(size.height).toBe(document.documentElement.clientHeight)
  })

  it('getNodeDisplaySize：量卡片 DOM 再除以缩放；量不到回落默认尺寸', () => {
    const ctx = createCtx()
    const card = { getBoundingClientRect: () => ({ width: 528, height: 320 }) }
    ctx.graph = {
      zoom: () => 2,
      findViewByCell: () => ({ container: { querySelector: sel => (sel === '.ai-card-frame' ? card : null) } })
    }
    expect(methods.getNodeDisplaySize.call(ctx, { id: 'n1' })).toEqual({ width: 264, height: 160 })

    // 量不到（无 view / 宽度为 0）
    ctx.graph.findViewByCell = () => null
    expect(methods.getNodeDisplaySize.call(ctx, { id: 'n1' })).toEqual({ width: 264, height: 320 })
  })
})

describe('applyInitialLayout：首次加载按基准布局重排', () => {
  it('画布为空时不做任何事', () => {
    const ctx = createCtx({ $route: { params: { id: 'f1' } }, syncAllNodeGeometry: vi.fn(), layoutWorkflowNodes: vi.fn() })
    ctx.graph = createFakeGraph()
    methods.applyInitialLayout.call(ctx)
    expect(ctx.syncAllNodeGeometry).not.toHaveBeenCalled()
    expect(ctx.layoutWorkflowNodes).not.toHaveBeenCalled()
  })

  it('未迁移过的布局重排一次并记 localStorage；已迁移的保留用户布局', () => {
    const key = 'ragstudio:flow-layout-v016:f1'
    window.localStorage.removeItem(key)
    const ctx = createCtx({ $route: { params: { id: 'f1' } }, syncAllNodeGeometry: vi.fn(), layoutWorkflowNodes: vi.fn(), zoom: vi.fn() })
    ctx.graph = createFakeGraph({ getNodes: () => [{ id: 'n1' }] })
    methods.applyInitialLayout.call(ctx)
    expect(ctx.layoutWorkflowNodes).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(key)).toBe('1')
    expect(ctx.zoom).toHaveBeenCalledWith('fit')

    // 已迁移：不再重排，只做几何同步 + fit
    ctx.layoutWorkflowNodes.mockClear()
    methods.applyInitialLayout.call(ctx)
    expect(ctx.layoutWorkflowNodes).not.toHaveBeenCalled()
  })

  it('localStorage 不可用（无痕模式）也要完成本次重排', () => {
    const ctx = createCtx({ $route: { params: { id: 'f2' } }, syncAllNodeGeometry: vi.fn(), layoutWorkflowNodes: vi.fn(), zoom: vi.fn() })
    ctx.graph = createFakeGraph({ getNodes: () => [{ id: 'n1' }] })
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(() => methods.applyInitialLayout.call(ctx)).not.toThrow()
    } finally {
      Storage.prototype.getItem = original
      Storage.prototype.setItem = Storage.prototype.setItem
    }
    expect(ctx.layoutWorkflowNodes).toHaveBeenCalledTimes(1)
  })
})

describe('setGraphSize：防抖 resize', () => {
  it('连点只保留最后一次 resize', () => {
    vi.useFakeTimers()
    const ctx = createCtx({
      getCanvasSize: () => ({ width: 800, height: 400 }),
      graph: createFakeGraph()
    })
    methods.setGraphSize.call(ctx)
    methods.setGraphSize.call(ctx)
    expect(ctx.graph.resize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ctx.timerInterval + 10)
    expect(ctx.graph.resize).toHaveBeenCalledTimes(1)
    expect(ctx.graph.resize).toHaveBeenCalledWith(800, 400)
  })
})

describe('graphListenDone / runPendingArrange：排版等待', () => {
  function setupPending (cards) {
    const ctx = createCtx({
      nodeLoaded: true,
      syncGraphStats: vi.fn(),
      applyGraphTheme: vi.fn(),
      runPendingArrange: vi.fn(),
      applyInitialLayout: vi.fn(),
      arrangeRetryTimer: null,
      arrangeFallbackTimer: 7,
      lastCardSizeSignature: ''
    })
    ctx.graph = createFakeGraph({
      getNodes: () => cards.map(() => ({ id: 'n' })),
      findViewByCell: node => {
        const card = cards[0]
        return card
          ? { container: { querySelector: () => card } }
          : { container: { querySelector: () => null } }
      }
    })
    methods.graphListenDone.call(ctx)
    return ctx
  }

  it('render:done：解除加载态 → 刷统计/主题 → 等排版', () => {
    const ctx = setupPending([null])
    ctx.pendingArrange = false
    fire(ctx.graph.handlers, 'render:done', {})
    expect(ctx.nodeLoaded).toBe(false)
    expect(ctx.syncGraphStats).toHaveBeenCalled()
    expect(ctx.applyGraphTheme).toHaveBeenCalled()
    expect(ctx.runPendingArrange).toHaveBeenCalled()
  })

  it('卡片齐且高度稳定：排版一次并清标记', async () => {
    const raf = vi.fn(cb => setTimeout(() => cb(performance.now()), 0))
    vi.stubGlobal('requestAnimationFrame', raf)
    const card = { getBoundingClientRect: () => ({ height: 100 }) }
    const ctx = setupPending([card])
    ctx.pendingArrange = true
    ctx.lastCardSizeSignature = '100' // 预置上一轮签名：本轮相同 → 稳定
    methods.runPendingArrange.call(ctx)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ctx.applyInitialLayout).toHaveBeenCalled()
    expect(ctx.pendingArrange).toBe(false)
    expect(ctx.lastCardSizeSignature).toBe('')
    vi.unstubAllGlobals()
  })

  it('没开 pendingArrange 或已在重试：直接返回', () => {
    const raf = vi.fn(cb => setTimeout(() => cb(performance.now()), 0))
    vi.stubGlobal('requestAnimationFrame', raf)
    const ctx = setupPending([null])
    expect(methods.runPendingArrange.call(ctx)).toBeUndefined()

    ctx.pendingArrange = true
    ctx.arrangeRetryTimer = 123 // 上一次重试还没落地
    methods.runPendingArrange.call(ctx)
    expect(ctx.applyInitialLayout).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('卡片一直不出现：重试到上限后按兜底排版收尾', async () => {
    vi.useFakeTimers()
    const raf = vi.fn(cb => setTimeout(() => cb(performance.now()), 0))
    vi.stubGlobal('requestAnimationFrame', raf)
    const ctx = setupPending([null])
    ctx.pendingArrange = true
    // 直接以「最后一轮」进入：不再排 setTimeout 重试
    methods.runPendingArrange.call(ctx, 40)
    await vi.advanceTimersByTimeAsync(20)
    expect(ctx.pendingArrange).toBe(false)
    expect(ctx.applyInitialLayout).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('边与端口的事件监听', () => {
  it('mouseenter 挂删除按钮、mouseleave 摘掉', () => {
    const ctx = createCtx({ graph: createFakeGraph() })
    methods.graphListenMouseenter.call(ctx)
    methods.graphListenMouseleave.call(ctx)

    const edge = { addTools: vi.fn() }
    fire(ctx.graph.handlers, 'edge:mouseenter', { edge })
    expect(edge.addTools).toHaveBeenCalledWith({ name: 'button-remove', args: { distance: -40 } })

    const withTool = { hasTool: vi.fn(() => true), removeTool: vi.fn() }
    fire(ctx.graph.handlers, 'edge:mouseleave', { cell: withTool })
    expect(withTool.removeTool).toHaveBeenCalledWith('button-remove')
    const withoutTool = { hasTool: vi.fn(() => false), removeTool: vi.fn() }
    fire(ctx.graph.handlers, 'edge:mouseleave', { cell: withoutTool })
    expect(withoutTool.removeTool).not.toHaveBeenCalled()
  })

  it('edge:connected：预览边转正 + 记目标节点输入 + 刷新统计', () => {
    const ctx = createCtx({
      scheduleGeometrySync: vi.fn(),
      scheduleEdgeDecorations: vi.fn(),
      syncGraphStats: vi.fn(),
      updateOuputPortForSingleOutput: vi.fn()
    })
    ctx.graph = createFakeGraph()
    methods.graphListenConnected.call(ctx)

    const target = {
      id: 't1',
      portProp: vi.fn(),
      setData: vi.fn()
    }
    const source = { id: 's1', store: { data: { label: 'RE-1' } } }
    const edge = {
      getData: vi.fn(() => ({ preview: true })),
      setData: vi.fn(),
      attr: vi.fn(),
      getSourceCell: vi.fn(() => source),
      getTargetCell: vi.fn(() => target),
      getSourcePortId: vi.fn(() => 'sp'),
      getTargetPortId: vi.fn(() => 'tp')
    }
    fire(ctx.graph.handlers, 'edge:connected', { edge })

    expect(edge.setData).toHaveBeenCalledWith({ preview: false })
    expect(edge.attr).toHaveBeenCalledWith('line', expect.objectContaining({ strokeWidth: 1.6 }))
    expect(ctx.scheduleGeometrySync).toHaveBeenCalled()
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
    expect(ctx.syncGraphStats).toHaveBeenCalled()
    expect(target.portProp).toHaveBeenCalledWith('tp', expect.objectContaining({ group: 'in' }))
    expect(target.setData).toHaveBeenCalledWith({
      type: 'add',
      sourceNode: 's1',
      label: 'RE-1',
      key: 'sp'
    })
    expect(ctx.updateOuputPortForSingleOutput).toHaveBeenCalledWith(target)

    // 非预览边：不做样式还原（用全新 spy 断言，避免与前一段混在一起）
    const plainTarget = { id: 't2', portProp: vi.fn(), setData: vi.fn() }
    const plainSource = { id: 's2', store: { data: { label: 'Q' } } }
    const plain = {
      getData: vi.fn(() => ({})),
      setData: vi.fn(),
      attr: vi.fn(),
      getSourceCell: vi.fn(() => plainSource),
      getTargetCell: vi.fn(() => plainTarget),
      getSourcePortId: vi.fn(() => 'sp2'),
      getTargetPortId: vi.fn(() => 'tp2')
    }
    fire(ctx.graph.handlers, 'edge:connected', { edge: plain })
    expect(plain.setData).not.toHaveBeenCalled()
    expect(plain.attr).not.toHaveBeenCalled()
    expect(plainTarget.setData).toHaveBeenCalledWith(expect.objectContaining({ sourceNode: 's2', key: 'sp2' }))
  })

  it('edge:removed：无入边时恢复端口圆点；目标缺失也不抛错', () => {
    const ctx = createCtx({
      syncGraphStats: vi.fn(),
      updateOuputPortForSingleOutput: vi.fn()
    })
    const target = { setData: vi.fn(), portProp: vi.fn(), id: 't1' }
    const graph = createFakeGraph({ getCellById: vi.fn(() => target), getIncomingEdges: vi.fn(() => []) })
    ctx.graph = graph
    methods.graphListenRemoved.call(ctx)

    const cell = {
      store: { data: { target: { cell: 't1' }, source: { cell: 's1' } } },
      getSourcePortId: () => 'sp',
      getTargetPortId: () => 'tp'
    }
    fire(graph.handlers, 'edge:removed', { cell })
    expect(target.setData).toHaveBeenCalledWith({ type: 'remove', deleteInput: 's1', key: 'sp' })
    expect(target.portProp).toHaveBeenCalledWith('tp', expect.objectContaining({ group: 'in' }))
    expect(ctx.updateOuputPortForSingleOutput).toHaveBeenCalledWith(target)

    // 目标节点已不存在：只刷统计
    graph.getCellById = vi.fn(() => null)
    fire(graph.handlers, 'edge:removed', { cell })
    expect(ctx.updateOuputPortForSingleOutput).toHaveBeenLastCalledWith(null)
  })

  it('几何事件只打 rAF 标记；数据变化额外刷统计', () => {
    const ctx = createCtx({
      scheduleGeometrySync: vi.fn(),
      scheduleEdgeDecorations: vi.fn(),
      syncGraphStats: vi.fn()
    })
    ctx.graph = createFakeGraph()
    methods.graphListenGeometry.call(ctx)
    const h = ctx.graph.handlers

    fire(h, 'node:moving', {})
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalledTimes(1)
    fire(h, 'node:moved', {})
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(1)
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalledTimes(2)
    fire(h, 'node:resized', {})
    fire(h, 'node:added', {})
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(3)
    fire(h, 'node:change:data', {})
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(4)
    expect(ctx.syncGraphStats).toHaveBeenCalledTimes(1)

    // 预览边不触发几何同步，但装饰与统计要刷
    const previewEdge = { getData: () => ({ preview: true }) }
    fire(h, 'edge:added', { edge: previewEdge })
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(4)
    const realEdge = { getData: () => ({}) }
    fire(h, 'edge:added', { edge: realEdge })
    expect(ctx.scheduleGeometrySync).toHaveBeenCalledTimes(5)
    fire(h, 'edge:removed', {})
    fire(h, 'edge:connected', {})
    fire(h, 'scale', {})
    expect(ctx.scheduleEdgeDecorations.mock.calls.length).toBeGreaterThan(2)
    expect(ctx.syncGraphStats.mock.calls.length).toBe(5)
  })

  it('端口点击：拖过不进连线模式；out 进入、in 且有起点则接上', () => {
    const ctx = createCtx({
      beginClickConnection: vi.fn(),
      finishClickConnection: vi.fn(),
      selectEdge: vi.fn(),
      selectNodeView: vi.fn(),
      cancelConnection: vi.fn(),
      clearNodeSelection: vi.fn(),
      scheduleEdgeDecorations: vi.fn()
    })
    ctx.graph = createFakeGraph()
    methods.graphListenPorts.call(ctx)
    const h = ctx.graph.handlers

    // 按下 → 抬起（位移 10px > 4）
    fire(h, 'node:port:mousedown', { e: { clientX: 10, clientY: 10 } })
    fire(h, 'node:port:mouseup', { e: { clientX: 20, clientY: 10 } })
    expect(ctx.portPointerDown.dragged).toBe(true)

    // 拖过的 click 不再进入点击连线
    const node = { id: 'n1', getPort: vi.fn(() => ({ group: 'out' })) }
    fire(h, 'node:port:click', { node, port: 'p1' })
    expect(ctx.beginClickConnection).not.toHaveBeenCalled()

    // 没拖过：out 端口进入点击连线
    fire(h, 'node:port:mousedown', { e: { clientX: 0, clientY: 0 } })
    fire(h, 'node:port:mouseup', { e: { clientX: 1, clientY: 0 } })
    fire(h, 'node:port:click', { node, port: 'p1' })
    expect(ctx.beginClickConnection).toHaveBeenCalledWith(node, 'p1')

    // in 端口：有起点才接；没有配置直接返回
    ctx.connectingSource = 'q1'
    const inNode = { id: 'n2', getPort: vi.fn(() => ({ group: 'in' })) }
    fire(h, 'node:port:click', { node: inNode, port: 'p2' })
    expect(ctx.finishClickConnection).toHaveBeenCalledWith(inNode)
    const emptyNode = { id: 'n3', getPort: vi.fn(() => null) }
    fire(h, 'node:port:click', { node: emptyNode, port: 'p3' })
    expect(ctx.finishClickConnection).toHaveBeenCalledTimes(1)

    // 边点击 / 节点按下 / 空白点击
    fire(h, 'edge:click', { edge: { id: 'e1' } })
    expect(ctx.selectEdge).toHaveBeenCalledWith({ id: 'e1' })
    fire(h, 'node:mousedown', { node: { id: 'n1' } })
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.selectNodeView).toHaveBeenCalledWith('n1')
    fire(h, 'node:mousedown', { node: null })
    expect(ctx.selectNodeView).toHaveBeenCalledTimes(1)
    fire(h, 'blank:click', {})
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })

  it('setGraphEventAndNodeInfo：一次注册全部监听与节点形状', () => {
    const ctx = createCtx({ graph: createFakeGraph() })
    const spies = ['graphListenDone', 'graphListenConnected', 'graphListenRemoved', 'graphListenGeometry', 'graphListenPorts', 'registerCustomNodeBundle']
      .map(name => {
        const spy = vi.fn()
        ctx[name] = spy
        return spy
      })
    methods.setGraphEventAndNodeInfo.call(ctx)
    spies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1))
  })

  it('registerCustomNodeBundle：注册六种卡片形状并桥接回调', () => {
    const ctx = createCtx({
      deleteNode: vi.fn(),
      editCardHandle: vi.fn(),
      initCardHandle: vi.fn(),
      inputDeleteHandle: vi.fn()
    })
    registeredShapes.length = 0
    methods.registerCustomNodeBundle.call(ctx)

    expect(registeredShapes).toHaveLength(6)
    const names = registeredShapes.map(item => item.shape)
    expect(names).toEqual(['QUERY', 'RESPONSE', 'PRE_RETRIEVER', 'RETRIEVER', 'POST_RETRIEVER', 'RESPONSE_SYNTHESIZER'])
    // 内核把回调桥包进 Vue 形状的 render：渲染一次取出 props 验证桥接
    const bridge = registeredShapes[0].component.render().props
    bridge.onDeleteCardHandle('id-9')
    expect(ctx.deleteNode).toHaveBeenCalledWith('id-9')
    bridge.onEditCardHandle({ id: 'x' })
    expect(ctx.editCardHandle).toHaveBeenCalledWith({ id: 'x' })
    bridge.onInitCardHandle({ id: 'y' })
    expect(ctx.initCardHandle).toHaveBeenCalledWith({ id: 'y' })
    bridge.onInputDeleteHandle('inputVar', 'id-z')
    expect(ctx.inputDeleteHandle).toHaveBeenCalledWith('inputVar', 'id-z')
  })
})
