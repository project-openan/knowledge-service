// X6 编辑器内核（lib/x6-editor-core.js）的单测。
// 不拉真 X6（重、且要 DOM）：@antv/x6 与各插件全部换成可断言的桩，
// 聚焦「参数组装 + 分支」—— 内核的硬要求是装配参数与拆分前逐字一致。
import { vi } from 'vitest'

vi.mock('@antv/x6', () => {
  const registerNode = vi.fn()
  const registerEdge = vi.fn()
  class Graph {
    constructor (options) {
      this.options = options
    }
  }
  Graph.registerNode = registerNode
  Graph.registerEdge = registerEdge
  return { Graph }
})
/** 造一个可 new 的插件桩：构造参数记在实例 options 上，构造次数记在类的静态 calls。
 *  ⚠️ 必须是 function 声明（会被提升），vi.mock 工厂里才能引用到。 */
function makePluginStub (kind) {
  class Stub {
    constructor (options) {
      this.kind = kind
      this.options = options
      Stub.calls.push(options)
    }
  }
  Stub.calls = []
  return Stub
}

// ⚠️ vi.mock 工厂会被提升到文件顶部，桩类必须在工厂内部定义（外面引用会拿不到）
vi.mock('@antv/x6-plugin-selection', () => ({ Selection: makePluginStub('selection') }))
vi.mock('@antv/x6-plugin-keyboard', () => ({ Keyboard: makePluginStub('keyboard') }))
vi.mock('@antv/x6-plugin-transform', () => ({ Transform: makePluginStub('transform') }))
vi.mock('@antv/x6-plugin-history', () => ({ History: makePluginStub('history') }))
vi.mock('@antv/x6-plugin-clipboard', () => ({ Clipboard: makePluginStub('clipboard') }))
vi.mock('@antv/x6-vue-shape', () => ({ register: vi.fn() }))

import { h } from 'vue'
import { Graph } from '@antv/x6'
import { Selection } from '@antv/x6-plugin-selection'
import { Transform } from '@antv/x6-plugin-transform'
import { register } from '@antv/x6-vue-shape'
import {
  mergeGraphOptions,
  createEditorGraph,
  createTemplateEditorPlugins,
  attachEditorPlugins,
  registerVueShape,
  registerNodeShape,
  registerEdgeShape,
  setPortsVisibility,
  applyPortPaint,
  setNodeSelectedOutline,
  setEdgeStroke,
  cellViewContainer,
  setElementClass,
  editorEdgeLineAttrs,
  wouldCreateCycleInEdges,
  edgePairsOf,
  hasEdgeBetween,
  graphCanUndo,
  graphCanRedo,
  graphUndo,
  graphRedo,
  bindGraphEvents
} from '@/features/graph/lib/x6-editor-core'

/** 造一个可断言 attr 写入的 node 桩。 */
function makeNode (ports) {
  const calls = []
  return {
    calls,
    getPorts: () => ports,
    portProp: vi.fn((...args) => calls.push(['portProp', ...args])),
    attr: vi.fn((...args) => calls.push(['attr', ...args]))
  }
}

function makeGraphStub () {
  return {
    use: vi.fn(),
    getEdges: vi.fn(() => []),
    getCellById: vi.fn(),
    findViewByCell: vi.fn(),
    canUndo: vi.fn(() => false),
    canRedo: vi.fn(() => false),
    undo: vi.fn(),
    redo: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}

describe('mergeGraphOptions', () => {
  it('纯对象递归合并，调用方覆盖内核默认值', () => {
    const merged = mergeGraphOptions(
      { grid: { size: 10, visible: true }, connecting: { allowBlank: false, snap: { radius: 20 } } },
      { grid: { size: 20 }, connecting: { snap: { radius: 40 } } }
    )
    expect(merged).toEqual({
      grid: { size: 20, visible: true },
      connecting: { allowBlank: false, snap: { radius: 40 } }
    })
  })

  it('数组 / 函数 / null 整值覆盖；undefined 跳过；override 可为空', () => {
    const fn = () => {}
    const base = { list: [1], interacting: () => 'base', modifiers: 'a' }
    expect(mergeGraphOptions(base, { list: [2], interacting: fn, modifiers: null, skipped: undefined }))
      .toEqual({ list: [2], interacting: fn, modifiers: null })
    expect(mergeGraphOptions(base, null)).toEqual(base)
    expect(mergeGraphOptions(base, {})).toEqual(base)
  })

  it('非纯对象覆盖纯对象时整值替换（含 null 覆盖对象）', () => {
    expect(mergeGraphOptions({ nested: { a: 1 } }, { nested: null })).toEqual({ nested: null })
    expect(mergeGraphOptions({ nested: { a: 1 } }, { nested: 5 })).toEqual({ nested: 5 })
  })
})

describe('createEditorGraph', () => {
  it('装配公共默认并允许覆盖', () => {
    const graph = createEditorGraph({ grid: { size: 10 } })
    expect(graph).toBeInstanceOf(Graph)
    expect(graph.options).toMatchObject({
      panning: true,
      mousewheel: { enabled: true },
      connecting: { allowBlank: false, snap: { radius: 20 } },
      grid: { size: 10 }
    })
  })

  it('不传 options 时也带全公共默认', () => {
    const graph = createEditorGraph()
    expect(graph.options).toEqual({
      panning: true,
      mousewheel: { enabled: true },
      connecting: { allowBlank: false, snap: { radius: 20 } }
    })
  })
})

describe('createTemplateEditorPlugins / attachEditorPlugins', () => {
  it('插件清单与配置逐字一致（顺序即 use 顺序）', () => {
    Selection.calls.length = 0
    const isNode = vi.fn(() => true)
    const plugins = createTemplateEditorPlugins()
    expect(plugins.map(p => p.kind)).toEqual(['selection', 'keyboard', 'transform', 'history', 'clipboard'])
    expect(Selection.calls).toHaveLength(1)
    expect(Selection.calls[0]).toEqual(expect.objectContaining({
      enabled: true,
      multiple: true,
      movable: true,
      showNodeSelectionBox: false,
      showEdgeSelectionBox: true,
      rubberband: false,
      className: 'my-selection',
      content: false
    }))
    // filter 回调按 cell.isNode() || cell.isEdge() 放行
    expect(Selection.calls[0].filter({ isNode })).toBe(true)
    expect(Selection.calls[0].filter({ isNode: vi.fn(() => false), isEdge: isNode })).toBe(true)
    expect(plugins[2].options).toEqual({ resizing: false, rotating: false })
    expect(Transform.calls[Transform.calls.length - 1]).toEqual({ resizing: false, rotating: false })
  })

  it('按顺序 use 到 Graph 上并返回 graph；空清单不 use', () => {
    const graph = makeGraphStub()
    const plugins = [{ id: 'p1' }, { id: 'p2' }]
    expect(attachEditorPlugins(graph, plugins)).toBe(graph)
    expect(graph.use.mock.calls.map(c => c[0].id)).toEqual(['p1', 'p2'])
    const empty = makeGraphStub()
    attachEditorPlugins(empty, null)
    expect(empty.use).not.toHaveBeenCalled()
  })
})

describe('registerVueShape', () => {
  it('注册 shape + 桥接 render；props 缺省为空对象', () => {
    const component = { name: 'Card' }
    const props = { onDelete: () => {} }
    registerVueShape({ shape: 'flow-card', component, props })
    const arg = register.mock.calls.at(-1)[0]
    expect(arg.shape).toBe('flow-card')
    const vnode = arg.component.render()
    expect(vnode.type).toBe(component)
    expect(vnode.props).toBe(props)

    registerVueShape({ shape: 'plain', component })
    expect(register.mock.calls.at(-1)[0].component.render().props).toEqual({})
  })
})

describe('registerNodeShape / registerEdgeShape', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Graph.registerNode.mockClear()
    Graph.registerEdge.mockClear()
  })

  it('注册走 Graph.registerNode/registerEdge 第三参 true', () => {
    registerNodeShape('tpl-node', { width: 1 })
    expect(Graph.registerNode).toHaveBeenCalledWith('tpl-node', { width: 1 }, true)
    registerEdgeShape('tpl-edge', { attrs: {} })
    expect(Graph.registerEdge).toHaveBeenCalledWith('tpl-edge', { attrs: {} }, true)
  })

  it('重复注册静默忽略；其他错误经 console.error 暴露', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    Graph.registerNode.mockImplementationOnce(() => {
      throw new Error('Shape `x` already registered')
    })
    expect(() => registerNodeShape('x', {})).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    Graph.registerNode.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    registerNodeShape('x', {})
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('节点 x 注册失败'), expect.any(Error))

    Graph.registerEdge.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    registerEdgeShape('y', {})
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('边 y 注册失败'), expect.any(Error))
  })
})

describe('setPortsVisibility / applyPortPaint', () => {
  it('按 visible 批量写端口 visibility', () => {
    const node = makeNode([{ id: 'p1' }, { id: 'p2' }])
    setPortsVisibility(node, true)
    expect(node.calls).toEqual([
      ['portProp', 'p1', 'attrs/circle/style/visibility', 'visible'],
      ['portProp', 'p2', 'attrs/circle/style/visibility', 'visible']
    ])
    node.calls.length = 0
    setPortsVisibility(node, false)
    expect(node.calls[0][3]).toBe('hidden')
  })

  it('没有端口 / 没有 getPorts 时安全返回', () => {
    expect(() => setPortsVisibility(makeNode([]), true)).not.toThrow()
    expect(() => setPortsVisibility({}, true)).not.toThrow()
    expect(() => setPortsVisibility({ getPorts: () => undefined }, true)).not.toThrow()
  })

  it('applyPortPaint 写 stroke/fill；dotFill 缺省不写 dot', () => {
    const node = makeNode([{ id: 'p1' }])
    applyPortPaint(node, { circleStroke: '#fff', circleFill: '#000' })
    expect(node.calls).toEqual([
      ['portProp', 'p1', 'attrs/circle/stroke', '#fff'],
      ['portProp', 'p1', 'attrs/circle/fill', '#000']
    ])
    node.calls.length = 0
    applyPortPaint(node, { circleStroke: 'a', circleFill: 'b', dotFill: 'c' })
    expect(node.calls[2]).toEqual(['portProp', 'p1', 'attrs/dot/fill', 'c'])
    // getPorts 返回 null/undefined 时按空端口处理
    expect(() => applyPortPaint({ getPorts: () => null }, { circleStroke: 'a', circleFill: 'b' })).not.toThrow()
  })
})

describe('setNodeSelectedOutline / setEdgeStroke', () => {
  it('选中描边 / 取消隐藏描边', () => {
    const node = makeNode([])
    setNodeSelectedOutline(node, true, { nodeSelectedStroke: '#f00' })
    expect(node.calls).toEqual([
      ['attr', 'body/strokeWidth', 1],
      ['attr', 'body/stroke', '#f00']
    ])
    node.calls.length = 0
    setNodeSelectedOutline(node, false, { nodeSelectedStroke: '#f00' })
    expect(node.calls).toEqual([
      ['attr', 'body/strokeWidth', 0],
      ['attr', 'body/stroke', 'transparent']
    ])
  })

  it('setEdgeStroke 默认 2px；null 边安全', () => {
    const attr = vi.fn()
    setEdgeStroke({ attr }, '#123')
    expect(attr).toHaveBeenCalledWith('line/stroke', '#123')
    expect(attr).toHaveBeenCalledWith('line/strokeWidth', 2)
    setEdgeStroke({ attr }, '#456', 4)
    expect(attr).toHaveBeenCalledWith('line/strokeWidth', 4)
    expect(() => setEdgeStroke(null, '#000')).not.toThrow()
    expect(() => setEdgeStroke({}, '#000')).not.toThrow()
  })
})

describe('cellViewContainer / setElementClass', () => {
  it('字符串走 getCellById，对象直接找视图；找不到返回 null', () => {
    const cell = { id: 'c1' }
    const container = { tagName: 'DIV' }
    const graph = makeGraphStub()
    graph.getCellById.mockReturnValue(cell)
    graph.findViewByCell.mockReturnValue({ container })
    expect(cellViewContainer(graph, 'c1')).toBe(container)
    expect(graph.getCellById).toHaveBeenCalledWith('c1')
    expect(cellViewContainer(graph, cell)).toBe(container)

    graph.getCellById.mockReturnValue(undefined)
    expect(cellViewContainer(graph, 'ghost')).toBeNull()
    graph.findViewByCell.mockReturnValue(undefined)
    expect(cellViewContainer(graph, cell)).toBeNull()
    expect(cellViewContainer(null, cell)).toBeNull()
    expect(cellViewContainer({}, null)).toBeNull()
  })

  it('setElementClass 按 force 语义 add/remove；null 元素安全', () => {
    const add = vi.fn()
    const remove = vi.fn()
    setElementClass({ classList: { add, remove } }, 'selected', true)
    expect(add).toHaveBeenCalledWith('selected')
    setElementClass({ classList: { add, remove } }, 'selected', false)
    expect(remove).toHaveBeenCalledWith('selected')
    expect(() => setElementClass(null, 'x', true)).not.toThrow()
  })
})

describe('editorEdgeLineAttrs', () => {
  it('默认 2px + classic 箭头（颜色同 stroke）', () => {
    expect(editorEdgeLineAttrs({ stroke: '#abc' })).toEqual({
      stroke: '#abc',
      strokeWidth: 2,
      targetMarker: { name: 'classic', size: 6, fill: '#abc', stroke: '#abc' }
    })
  })

  it('fill / roundCaps / 关闭箭头的差异参数', () => {
    const attrs = editorEdgeLineAttrs({ stroke: '#fff', fill: 'none', roundCaps: true, targetMarker: false })
    expect(attrs).toEqual({
      stroke: '#fff',
      strokeWidth: 2,
      fill: 'none',
      strokeLinejoin: 'round',
      strokeLinecap: 'round'
    })
    // fill 未传则不写
    expect('fill' in editorEdgeLineAttrs({ stroke: '#fff' })).toBe(false)
    // 完全无参也能拿到骨架
    expect(editorEdgeLineAttrs()).toEqual({ stroke: undefined, strokeWidth: 2, targetMarker: { name: 'classic', size: 6, fill: undefined, stroke: undefined } })
  })
})

describe('wouldCreateCycleInEdges', () => {
  const chain = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' }
  ]

  it('从 target 顺出边能走回 source 即成环', () => {
    expect(wouldCreateCycleInEdges(chain, 'd', 'a')).toBe(true) // a→b→c→d，加 d→a 成环
    expect(wouldCreateCycleInEdges(chain, 'c', 'a')).toBe(true) // a→b→c，加 c→a 成环
    expect(wouldCreateCycleInEdges(chain, 'a', 'c')).toBe(false) // c 的出边走不到 a
    expect(wouldCreateCycleInEdges(chain, 'a', 'd')).toBe(false)
  })

  it('空图 / 自环', () => {
    expect(wouldCreateCycleInEdges([], 'a', 'b')).toBe(false)
    expect(wouldCreateCycleInEdges([{ source: 'a', target: 'a' }], 'a', 'a')).toBe(true)
  })

  it('菱形分叉：重访节点跳过（seen 分支），不误判也不漏判', () => {
    // 有环：leaf→root 使 root→x→leaf→root 成环，x 被两条路径重复入队
    const cyclic = [
      { source: 'root', target: 'x' },
      { source: 'root', target: 'leaf' },
      { source: 'x', target: 'leaf' },
      { source: 'leaf', target: 'root' }
    ]
    expect(wouldCreateCycleInEdges(cyclic, 'root', 'x')).toBe(true)
    expect(wouldCreateCycleInEdges(cyclic, 'x', 'root')).toBe(true)
    // 无环菱形（去掉 leaf→root）：同样的重复入队，正确返回 false
    const acyclic = cyclic.slice(0, 3)
    expect(wouldCreateCycleInEdges(acyclic, 'zzz', 'root')).toBe(false)
    expect(wouldCreateCycleInEdges(acyclic, 'root', 'x')).toBe(false)
  })
})

describe('edgePairsOf / hasEdgeBetween', () => {
  it('从 graph 取边对，可排除拖拽预览边', () => {
    const mkEdge = (s, t, preview) => ({
      getSourceCellId: () => s,
      getTargetCellId: () => t,
      getData: () => (preview ? { preview } : null)
    })
    const graph = makeGraphStub()
    graph.getEdges.mockReturnValue([mkEdge('a', 'b'), mkEdge('b', 'c', true)])

    expect(edgePairsOf(graph)).toEqual([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' }
    ])
    expect(edgePairsOf(graph, { excludePreview: true })).toEqual([{ source: 'a', target: 'b' }])
    // 缺 graph / 缺 getEdges 安全
    expect(edgePairsOf(null)).toEqual([])
    expect(edgePairsOf({})).toEqual([])
  })

  it('hasEdgeBetween 判同向存在', () => {
    const edges = [
      { getSourceCellId: () => 'a', getTargetCellId: () => 'b' },
      { getSourceCellId: () => 'b', getTargetCellId: () => 'a' }
    ]
    expect(hasEdgeBetween(edges, 'a', 'b')).toBe(true)
    expect(hasEdgeBetween(edges, 'b', 'a')).toBe(true)
    expect(hasEdgeBetween(edges, 'a', 'c')).toBe(false)
    expect(hasEdgeBetween(null, 'a', 'b')).toBe(false)
    expect(hasEdgeBetween([], 'a', 'b')).toBe(false)
  })
})

describe('撤销 / 重做', () => {
  it('canUndo/canRedo：null graph 一律 false', () => {
    expect(graphCanUndo(null)).toBe(false)
    expect(graphCanRedo(undefined)).toBe(false)
    const graph = makeGraphStub()
    graph.canUndo.mockReturnValue(true)
    graph.canRedo.mockReturnValue(true)
    expect(graphCanUndo(graph)).toBe(true)
    expect(graphCanRedo(graph)).toBe(true)
  })

  it('undo/redo 只在可用时触发', () => {
    const graph = makeGraphStub()
    graphUndo(graph)
    graphRedo(graph)
    expect(graph.undo).not.toHaveBeenCalled()
    expect(graph.redo).not.toHaveBeenCalled()

    graph.canUndo.mockReturnValue(true)
    graph.canRedo.mockReturnValue(true)
    graphUndo(graph)
    graphRedo(graph)
    expect(graph.undo).toHaveBeenCalledTimes(1)
    expect(graph.redo).toHaveBeenCalledTimes(1)
    expect(() => graphUndo(null)).not.toThrow()
    expect(() => graphRedo(null)).not.toThrow()
  })
})

describe('bindGraphEvents', () => {
  it('逐个挂 graph.on，返回的解绑函数逐个 off；null graph 返回空函数', () => {
    const graph = makeGraphStub()
    const onBlank = vi.fn()
    const onEdge = vi.fn()
    const unbind = bindGraphEvents(graph, { 'blank:click': onBlank, 'edge:click': onEdge })
    expect(graph.on).toHaveBeenCalledTimes(2)
    expect(graph.on).toHaveBeenCalledWith('blank:click', onBlank)

    unbind()
    expect(graph.off).toHaveBeenCalledTimes(2)
    expect(graph.off).toHaveBeenCalledWith('edge:click', onEdge)

    const noop = bindGraphEvents(null, {})
    expect(typeof noop).toBe('function')
    expect(() => noop()).not.toThrow()
  })
})
