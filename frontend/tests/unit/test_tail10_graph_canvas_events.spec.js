// @vitest-environment jsdom
/**
 * GraphCanvas.vue —— 补齐 test_gviz_graph_editor.spec.js 没碰到的分支
 * （X6 假件沿用仓内先例：记录调用的 FakeGraph/FakeNode/FakeEdge）。
 *
 * 覆盖面：
 * - connecting 回调（createEdge/validateEdge/validateConnection）按连线模式取形与放行规则；
 * - 右键菜单（越界钳制、画布右键、复制/粘贴、点击外部与 ESC 关闭）；
 * - 键盘快捷键（Ctrl+C/V、Delete 删选中边、焦点在输入框时放行）；
 * - 框选结束把矩形内的边加入选中；选择变化的高亮/端口联动；Ctrl+mouseup 兜底；
 * - 节点拖动的防重叠（moving 即时纠正 / moved 递归复查 / 画布外随机落点）；
 * - 主题切换原地重绘（暗色、lightStroke 还原、marker/标签分支）；
 * - addNode：默认不选中、真被选中时超时兜底 unselect、Graph 缺失时重初始化、建点失败上报；
 * - expose 各方法的 Graph 缺失（卸载后）回落；deleteSelectedCells / addEdge 全分支。
 *
 * 渲染循环说明：addNode 的 50/150ms 兜底与防重叠的 10ms 递归用真定时器等到触发，
 * 不存在无法触发的 rAF/ResizeObserver 回调。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

import { THEME_CHANGE_EVENT } from '@/shared/lib/theme'

// ── X6 假件（与 test_gviz_graph_editor.spec.js 同族，补选中/失败开关） ─────────
const { FakeGraph, FakeNode, FakeEdge, FakeShapeEdge, registered } = vi.hoisted(() => {
  let idSeq = 0
  const registered = { nodes: {}, edges: {}, vueShapes: [] }

  function getAttr (obj, path) {
    return String(path).split('/').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
  }
  function setAttr (obj, path, value) {
    const keys = String(path).split('/')
    let cur = obj
    keys.slice(0, -1).forEach(key => {
      if (cur[key] === undefined || cur[key] === null) cur[key] = {}
      cur = cur[key]
    })
    cur[keys.at(-1)] = value
  }

  class FakeCell {
    constructor (options = {}) {
      this.id = options.id || `cell-${idSeq += 1}`
      this.shape = options.shape
      this._attrs = {}
      this._data = options.data || {}
      this._labels = []
      this.removed = false
    }
    attr (path, value) {
      if (arguments.length === 1) return getAttr(this._attrs, path)
      setAttr(this._attrs, path, value)
      return this
    }
    getData () { return this._data }
    replaceData (data) { this._data = data }
    remove () { this.removed = true }
  }

  class FakeNode extends FakeCell {
    constructor (options = {}) {
      super(options)
      this.x = options.x || 0
      this.y = options.y || 0
      this._ports = options.ports || [{ id: 'p1' }, { id: 'p2' }]
      this._portProps = {}
    }
    isNode () { return true }
    isEdge () { return false }
    getPorts () { return this._ports }
    portProp (path, prop, value) {
      this._portProps = this._portProps || {}
      this._portProps[`${path}|${prop}`] = value
    }
    getSize () { return { width: 56, height: 56 } }
    getAttrs () { return this._attrs }
    setAttrs (attrs) { Object.assign(this._attrs, attrs); return this }
    setPosition (x, y) { this.x = x; this.y = y }
    getBBox () { return { x: this.x || 0, y: this.y || 0, width: 56, height: 56 } }
  }

  class FakeEdge extends FakeCell {
    constructor (options = {}) {
      super(options)
      this._source = options.source || {}
      this._target = options.target || {}
      this._vertices = options.vertices || []
      this._sourceNode = options._sourceNode || null
      this._targetNode = options._targetNode || null
    }
    isNode () { return false }
    isEdge () { return true }
    getSource () { return this._source }
    getTarget () { return this._target }
    getSourceNode () { return this._sourceNode }
    getTargetNode () { return this._targetNode }
    getLabels () { return this._labels }
    setLabels (labels) { this._labels = labels }
    getVertices () { return this._vertices }
    getBBox () { return { x: this.x || 0, y: this.y || 0, width: 10, height: 10 } }
  }

  class FakeShapeEdge extends FakeEdge {}

  class FakeGraph {
    static instances = []
    static registerNode (name, config) { registered.nodes[name] = config }
    static registerEdge (name, config) { registered.edges[name] = config }
    constructor (options) {
      if (FakeGraph.failNext) {
        FakeGraph.failNext = false
        throw new Error('boom: graph init failed')
      }
      this.options = options
      this.handlers = {}
      this._cells = []
      this._plugins = []
      this._selected = []
      // 选中/撤销开关：用例按需拨动
      this.alwaysSelected = false
      this._canUndo = false
      this._canRedo = false
      this.failAddNode = false
      this.zoomCalls = []
      FakeGraph.instances.push(this)
    }
    on (name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn) }
    off (name, fn) { this.handlers[name] = (this.handlers[name] || []).filter(fn2 => fn2 !== fn) }
    emit (name, params = {}) { (this.handlers[name] || []).forEach(fn => fn(params)) }
    use (plugin) { this._plugins.push(plugin); return this }
    addNode (options) {
      if (this.failAddNode) throw new Error('addNode failed')
      const n = new FakeNode(options)
      this._cells.push(n)
      return n
    }
    addEdge (options) {
      if (this.failAddEdge) throw new Error('addEdge failed')
      const e = new FakeEdge(options)
      this._cells.push(e)
      return e
    }
    getCellById (id) { return this._cells.find(c => c.id === id) || null }
    getNodes () { return this._cells.filter(c => c.isNode()) }
    getEdges () { return this._cells.filter(c => c.isEdge()) }
    getCells () { return this._cells.slice() }
    getSelectedCells () { return this._selected }
    isSelected (cell) { return this.alwaysSelected || this._selected.includes(cell) }
    select (cell) { this.selectCalls = (this.selectCalls || []).concat(cell) }
    addToSelection (cell) { this.addSelectionCalls = (this.addSelectionCalls || []).concat(cell) }
    unselect (cell) { this.unselectCalls = (this.unselectCalls || []).concat(cell) }
    clearCells () { this._cells = [] }
    cleanSelection () { this._selected = [] }
    toJSON () { return { cells: this._cells.map(c => ({ id: c.id, shape: c.shape })) } }
    fromJSON () { this.loaded = true }
    getGraphArea () { return { width: 800, height: 600 } }
    clientToLocal (point) { return point }
    dispose () { this.disposed = true }
    drawBackground () {} drawGrid () {}
    zoom (delta) { this.zoomCalls.push(delta); return 1 }
    zoomToFit () { this.fitCalls = (this.fitCalls || 0) + 1 }
    resize (w, h2) { this.resizedWith = [w, h2] }
    exportSVG () { return '<svg />' }
    findViewByCell () { return null }
    canUndo () { return this._canUndo }
    canRedo () { return this._canRedo }
    undo () { this.undoCalls = (this.undoCalls || 0) + 1 }
    redo () { this.redoCalls = (this.redoCalls || 0) + 1 }
  }
  return { FakeGraph, FakeNode, FakeEdge, FakeShapeEdge, registered }
})

vi.mock('@antv/x6', () => ({
  Graph: FakeGraph,
  Node: FakeNode,
  Edge: FakeEdge,
  Shape: { Edge: FakeShapeEdge }
}))
vi.mock('@antv/x6-plugin-selection', () => ({ Selection: class { constructor (o) { this.o = o } } }))
vi.mock('@antv/x6-plugin-keyboard', () => ({ Keyboard: class { constructor (o) { this.o = o } } }))
vi.mock('@antv/x6-plugin-transform', () => ({ Transform: class { constructor (o) { this.o = o } } }))
vi.mock('@antv/x6-plugin-history', () => ({ History: class { constructor (o) { this.o = o } } }))
vi.mock('@antv/x6-plugin-clipboard', () => ({ Clipboard: class { constructor (o) { this.o = o } } }))
vi.mock('@antv/x6-vue-shape', () => ({ register: (shape) => registered.vueShapes.push(shape) }))

// nodeFactory 用 webpack require 拉 svg（vitest 解析不了），换成行为等价的桩
const { applyNodeThemeSpy } = vi.hoisted(() => ({ applyNodeThemeSpy: vi.fn() }))
vi.mock('@/features/graph/lib/nodeFactory', () => ({
  registerCustomNodes: vi.fn(),
  getNodeDefaultProperties: vi.fn(nodeType => ({ name: nodeType === 'entity' ? 'Entity' : nodeType, description: '', attributes: [] })),
  getGraphPalette: vi.fn(() => ({
    nodeFill: '#FFFFFF', nodeLabel: '#262626', portStroke: '#1993FF', portFill: '#fff',
    edgeStroke: '#1993FF', edgeDefaultStroke: '#000000', templateEdgeStroke: '#0077FF',
    edgeLabelFill: '#262626', edgeLabelBackground: '#FFFFFF', canvasBackground: '#F7F8FA',
    grid: '#D9D9D9', selection: '#1993FF', nodeSelectedStroke: '#1993FF',
    defaultNode: '#8C8C8C', nodeShadow: 'none'
  })),
  applyNodeTheme: applyNodeThemeSpy
}))

import GraphCanvas from '@/features/graph/components/GraphEditor/GraphCanvas.vue'

function evt (overrides = {}) {
  return {
    clientX: 100, clientY: 80,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    ctrlKey: false, metaKey: false,
    ...overrides
  }
}

async function mountCanvas () {
  const wrapper = await mountWithPlugins(GraphCanvas, {
    router: null,
    global: {
      components: { ElIcon: { name: 'ElIcon', setup (_, { slots }) { return () => slots.default?.() } } }
    }
  })
  await flush()
  await new Promise(resolve => setTimeout(resolve, 5))
  return wrapper
}

function editorGraph () {
  return FakeGraph.instances.at(-1)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 在画布容器里塞一块“框选橡皮筋”矩形。 */
function installRubberband (wrapper, rect = { left: 0, top: 0, right: 100, bottom: 100 }) {
  const el = document.createElement('div')
  el.className = 'x6-widget-selection-rubberband'
  el.getBoundingClientRect = () => rect
  wrapper.find('.x6-container').element.appendChild(el)
  return el
}

function keydown (options) {
  document.dispatchEvent(new KeyboardEvent('keydown', options))
}

beforeEach(() => {
  FakeGraph.instances.length = 0
  FakeGraph.failNext = false
  applyNodeThemeSpy.mockClear()
  document.documentElement.classList.remove('dark')
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('connecting 回调（连线模式）', () => {
  it('createEdge 按模式取形状与数据；validateEdge/validateConnection 按 enabled 与端点放行', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const connecting = graph.options.connecting

    // single（默认）
    let preview = connecting.createEdge()
    expect(preview.shape).toBe('single-arrow-edge')
    expect(preview._data.direction).toBe('single')
    expect(preview._data.enabled).toBe(true)

    wrapper.vm.setConnectionMode('double')
    preview = connecting.createEdge()
    expect(preview.shape).toBe('double-arrow-edge')

    wrapper.vm.setConnectionMode('self')
    preview = connecting.createEdge()
    expect(preview.shape).toBe('self-loop-edge')
    expect(wrapper.vm.getConnectionMode()).toBe('self')

    // 关闭连线：状态与校验一起翻面
    wrapper.vm.setConnectionMode(null)
    expect(connecting.validateEdge({ edge: { getTargetNode: () => ({}) } })).toBe(false)
    expect(connecting.validateConnection({ sourceMagnet: 's', targetMagnet: 't' })).toBe(false)

    // 开着但目标缺失 → 拒；两端齐全 → 放行
    wrapper.vm.setConnectionMode('single')
    expect(connecting.validateEdge({ edge: { getTargetNode: () => null } })).toBe(false)
    expect(connecting.validateEdge({ edge: { getTargetNode: () => ({}) } })).toBe(true)
    expect(connecting.validateConnection({ sourceMagnet: null, targetMagnet: 't' })).toBe(false)
    expect(connecting.validateConnection({ sourceMagnet: 's', targetMagnet: 't' })).toBe(true)
    wrapper.unmount()
  })
})

describe('右键菜单', () => {
  it('节点右键：越界坐标被钳制到屏幕内；点菜单外部/ESC 关闭；点菜单内部不关', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    graph.emit('node:contextmenu', { node: { id: 'n1', shape: 'entity-node' }, e: evt({ clientX: window.innerWidth + 500, clientY: window.innerHeight + 500 }) })
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(true)
    const style = wrapper.find('.context-menu').attributes('style')
    expect(style).toContain(`${window.innerWidth - 210}px`)
    expect(style).toContain(`${window.innerHeight - 170}px`)

    // 点在菜单内部：不关
    const menuEl = wrapper.find('.context-menu').element
    const inside = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(inside, 'target', { value: menuEl })
    document.dispatchEvent(inside)
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(true)

    // 点在菜单外部：关（target 必须是有 closest 的元素，真点击落在 body 上）
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(false)

    // ESC 关闭
    graph.emit('blank:contextmenu', { e: evt() })
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(true)
    keydown({ key: 'Escape' })
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('复制/粘贴：无选中时菜单项禁用不动作；有选中复制后再粘贴出副本并 emit node-select', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    // 画布右键：无选中节点 → 复制项 disabled，点了也不复制
    graph.emit('blank:contextmenu', { e: evt() })
    await flush()
    const items = wrapper.findAll('.menu-item')
    expect(items[0].classes()).toContain('disabled')
    await items[0].trigger('click')
    await items[1].trigger('click') // 粘贴：无副本 → 只关菜单
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(false)
    expect(wrapper.vm.hasCopiedNode).toBe(false)

    // 节点右键 → 复制 → 粘贴
    const source = graph.addNode({ shape: 'entity-node', data: { name: 'Person' } })
    graph.emit('node:contextmenu', { node: source, e: evt() })
    await flush()
    await wrapper.find('.menu-item').trigger('click')
    expect(wrapper.vm.hasCopiedNode).toBe(true)
    expect(wrapper.find('.context-menu').exists()).toBe(false)

    graph.emit('blank:contextmenu', { e: evt({ clientX: 30, clientY: 40 }) })
    await flush()
    await wrapper.findAll('.menu-item')[1].trigger('click')
    await flush()
    const pasted = graph.getNodes().at(-1)
    expect(pasted).not.toBe(source)
    expect(pasted._data.name).toBe('Person_Copy')
    expect(applyNodeThemeSpy).toHaveBeenCalled()
    // 粘贴成功 100ms 后 emit node-select
    await wait(120)
    expect(wrapper.emitted('node-select').at(-1)[0]).toBe(pasted)
    wrapper.unmount()
  })

  it('粘贴失败（addNode 抛错）走 reportError，菜单关闭', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const source = graph.addNode({ shape: 'entity-node', data: { name: 'P' } })
    graph.failAddNode = true
    graph.emit('node:contextmenu', { node: source, e: evt() })
    await flush()
    await wrapper.find('.menu-item').trigger('click')
    graph.emit('blank:contextmenu', { e: evt() })
    await flush()
    await wrapper.findAll('.menu-item')[1].trigger('click')
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('键盘快捷键', () => {
  it('焦点在输入框时不拦截快捷键', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    graph._selected = [graph.addNode({ shape: 'entity-node', data: { name: 'A' } })]

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    keydown({ key: 'c', ctrlKey: true })
    await flush()
    // 焦点在输入框：不复制（没有可粘贴副本）
    expect(wrapper.vm.hasCopiedNode).toBe(false)
    input.remove()
    wrapper.unmount()
  })

  it('Ctrl+C 复制选中节点、Ctrl+V 粘贴、Delete 删除选中边', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    const node = graph.addNode({ shape: 'entity-node', data: { name: 'A' } })
    graph._selected = [node]
    keydown({ key: 'c', ctrlKey: true })
    await flush()
    expect(wrapper.vm.hasCopiedNode).toBe(true)

    keydown({ key: 'v', ctrlKey: true })
    await wait(120)
    expect(graph.getNodes().length).toBe(2)

    const edge = graph.addEdge({ source: { cell: 'a' }, target: { cell: 'b' } })
    graph._selected = [edge]
    keydown({ key: 'Delete' })
    await flush()
    expect(edge.removed).toBe(true)
    wrapper.unmount()
  })
})

describe('选择联动与框选', () => {
  it('selection:changed：边高亮、节点显端口+描边；取消选中反向', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const addedNode = graph.addNode({ shape: 'entity-node' })
    const removedNode = graph.addNode({ shape: 'entity-node' })
    const addedEdge = graph.addEdge({})
    const removedEdge = graph.addEdge({})
    const plain = { isNode: () => false, isEdge: () => false }

    graph.emit('selection:changed', { added: [addedNode, addedEdge, plain], removed: [removedNode, removedEdge] })
    await flush()
    // 选中：端口可见 + 描边
    expect(addedNode._portProps['p1|attrs/circle/style/visibility']).toBe('visible')
    expect(addedNode.attr('body/stroke')).toBe('#1993FF')
    expect(addedEdge.attr('line/stroke')).toBe('#1993FF')
    // 取消：端口隐藏 + 描边隐藏
    expect(removedNode._portProps['p1|attrs/circle/style/visibility']).toBe('hidden')
    expect(removedNode.attr('body/stroke')).toBe('transparent')
    expect(removedEdge.attr('line/stroke')).toBe('#1993FF')
    wrapper.unmount()
  })

  it('selection:finished：橡皮筋矩形内的边加入选中并高亮；矩形外不动', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    installRubberband(wrapper)

    const inside = graph.addEdge({})
    inside.x = 10
    const outside = graph.addEdge({})
    outside.x = 500
    const noBBox = graph.addEdge({})
    noBBox.getBBox = undefined

    graph.emit('selection:finished')
    await flush()
    expect(graph.selectCalls).toEqual([inside])
    expect(inside.attr('line/stroke')).toBe('#1993FF')
    expect(outside.attr('line/stroke')).toBeUndefined()
    wrapper.unmount()
  })

  it('橡皮筋不存在时静默返回', async () => {
    const wrapper = await mountCanvas()
    editorGraph().emit('selection:finished')
    await flush()
    expect(editorGraph().selectCalls).toBeUndefined()
    wrapper.unmount()
  })

  it('edge:mouseup + Ctrl：超时兜底加入选中并高亮', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const edge = graph.addEdge({})
    graph.emit('edge:mouseup', { edge, e: evt({ ctrlKey: true }) })
    await wait(10)
    expect(graph.addSelectionCalls).toEqual([edge])
    expect(edge.attr('line/stroke')).toBe('#1993FF')
    wrapper.unmount()
  })
})

describe('节点拖动防重叠', () => {
  it('moving 即时纠正到安全位置；moved 后递归复查收敛', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const anchor = graph.addNode({ shape: 'entity-node' })
    const mover = graph.addNode({ shape: 'entity-node' })

    graph.emit('node:moving', { node: mover })
    // moving 纠正：mover 不再与 anchor 重叠（margin 10）
    const afterMove = mover.getBBox()
    expect(
      afterMove.x + afterMove.width + 10 <= anchor.getBBox().x ||
      anchor.getBBox().x + anchor.getBBox().width + 10 <= afterMove.x ||
      afterMove.y + afterMove.height + 10 <= anchor.getBBox().y ||
      anchor.getBBox().y + anchor.getBBox().height + 10 <= afterMove.y
    ).toBe(true)

    // moved：先重叠，处理后递归复查一次（10ms）收敛
    mover.setPosition(0, 0)
    graph.emit('node:moved', { node: mover })
    await wait(30)
    expect(mover.x).not.toBe(0)
    wrapper.unmount()
  })

  it('四个方向都放不下时落到画布内随机位置', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const big = graph.addNode({ shape: 'entity-node' })
    big.getBBox = () => ({ x: 0, y: 0, width: 800, height: 600 })
    const mover = graph.addNode({ shape: 'entity-node' })
    mover.setPosition(0, 0)

    graph.emit('node:moving', { node: mover })
    const pos = mover.getBBox()
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.x).toBeLessThanOrEqual(800)
    wrapper.unmount()
  })
})

describe('主题切换与 resize', () => {
  it('applyGraphTheme：暗色切亮色还原 lightStroke；marker/标签分支；选中节点描边', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    const node = graph.addNode({ shape: 'entity-node' })
    const styledEdge = graph.addEdge({ data: { lightStroke: '#1993FF' } })
    styledEdge.attr('line/targetMarker', { fill: '#000' })
    styledEdge.attr('line/sourceMarker', { fill: '#000' })
    styledEdge.setLabels([{ attrs: {} }])
    const plainEdge = graph.addEdge({ data: {} })

    // 选中节点 → 主题切换保住选中描边
    graph._selected = [node]
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
    await flush()
    expect(node.attr('body/stroke')).toBe('#1993FF')
    // lightStroke 还原 + marker 同步 + 标签底色
    expect(styledEdge.attr('line/stroke')).toBe('#1993FF')
    expect(styledEdge.attr('line/targetMarker/fill')).toBe('#1993FF')
    expect(styledEdge.attr('line/sourceMarker/stroke')).toBe('#1993FF')
    expect(styledEdge.attr('label/fill')).toBe('#262626')
    // 无 lightStroke → 主题色
    expect(plainEdge.attr('line/stroke')).toBe('#1993FF')

    // 暗色：lightStroke 不还原，用主题色
    document.documentElement.classList.add('dark')
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
    await flush()
    expect(styledEdge.attr('line/stroke')).toBe('#1993FF')
    document.documentElement.classList.remove('dark')
    wrapper.unmount()
  })

  it('resize 事件与 resizeGraph：按容器尺寸重设画布；卸载后为 no-op', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(graph.resizedWith).toEqual([0, 0])

    wrapper.vm.resizeGraph()
    expect(graph.resizedWith).toEqual([0, 0])

    wrapper.unmount()
    window.dispatchEvent(new Event('resize'))
  })

  it('画布空白点击：隐藏所有节点端口并 emit canvas-click', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = graph.addNode({ shape: 'entity-node' })
    node._portProps['p1|attrs/circle/style/visibility'] = 'visible'

    graph.emit('blank:click', { e: evt() })
    await flush()
    expect(node._portProps['p1|attrs/circle/style/visibility']).toBe('hidden')
    expect(wrapper.emitted('canvas-click')).toHaveLength(1)
    wrapper.unmount()
  })

  it('edge:connected 无源节点时静默返回', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    graph.emit('edge:connected', { edge: new FakeEdge({ _sourceNode: null, _targetNode: null }) })
    await flush()
    expect(wrapper.emitted('edge-select')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('addNode 的兜底分支', () => {
  it('节点真被自动选中时：两次超时兜底 unselect + 隐藏端口', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    graph.alwaysSelected = true

    const node = wrapper.vm.addNode('entity')
    expect(node).toBeTruthy()
    await wait(220)
    expect(graph.unselectCalls.length).toBeGreaterThanOrEqual(2)
    expect(node._portProps['p1|attrs/circle/style/visibility']).toBe('hidden')
    wrapper.unmount()
  })

  it('addNode 抛错：上报并返回 null', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    graph.failAddNode = true
    expect(wrapper.vm.addNode('entity')).toBeNull()
    wrapper.unmount()
  })

  it('Graph 初始化失败：上报错误；后续 addNode 触发重初始化成功', async () => {
    FakeGraph.failNext = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await mountCanvas()
    // initGraph 抛错 → reportError 出口；graph 仍为 null
    expect(FakeGraph.instances).toHaveLength(0)
    expect(wrapper.emitted('initialized')).toBeUndefined()

    // addNode：graph 缺失 → 记录错误并安排重初始化（容器还在 → 成功）
    expect(wrapper.vm.addNode('entity')).toBeNull()
    await wait(200)
    expect(FakeGraph.instances).toHaveLength(1)
    expect(wrapper.emitted('initialized')).toHaveLength(1)

    // 重初始化完成后 addNode 正常
    const node = wrapper.vm.addNode('entity')
    expect(node).toBeTruthy()
    expect(consoleError).toHaveBeenCalled()
    // 组件的“确保不选中”定时器在卸载后会拿到 null graph（既有缺陷），等它跑完再卸载
    await wait(220)
    wrapper.unmount()
  })

  it('卸载后 addNode：graph 缺失且容器已空 → 静默返回 null', async () => {
    const wrapper = await mountCanvas()
    wrapper.unmount()
    expect(wrapper.vm.addNode('entity')).toBeNull()
    await wait(150)
  })
})

describe('expose 方法在 Graph 缺失（卸载后）的回落', () => {
  it('update/undo/zoom/load/clear/export 系列全部安全返回', async () => {
    const wrapper = await mountCanvas()
    wrapper.unmount()

    expect(wrapper.vm.updateNodeProperties('n1', { name: 'X' })).toBeUndefined()
    expect(wrapper.vm.updateEdgeProperties('e1', { edge_type: 'A' })).toBeUndefined()
    expect(wrapper.vm.exportData()).toBeNull()
    expect(wrapper.vm.exportForSchema()).toEqual({ nodes: [], edges: [] })
    expect(wrapper.vm.exportSVG()).toBe('')
    expect(wrapper.vm.loadData({ cells: [] })).toBeUndefined()
    expect(wrapper.vm.loadData(null)).toBeUndefined()
    wrapper.vm.undo()
    wrapper.vm.redo()
    expect(wrapper.vm.canUndo).toBe(false)
    expect(wrapper.vm.canRedo).toBe(false)
    wrapper.vm.zoomIn()
    wrapper.vm.zoomOut()
    wrapper.vm.fitView()
    wrapper.vm.clearCanvas()
    expect(wrapper.vm.deleteSelectedCells()).toBe(0)
    expect(wrapper.vm.addEdge({})).toBeNull()
  })

  it('graph 在（挂载中）：undo/redo/zoom/load/clear 真正作用到 Graph', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    wrapper.vm.loadData({ cells: [{ id: 'x' }] })
    expect(graph.loaded).toBe(true)
    wrapper.vm.loadData({})

    graph._canUndo = true
    expect(wrapper.vm.canUndo).toBe(true)
    wrapper.vm.undo()
    expect(graph.undoCalls).toBe(1)
    graph._canUndo = false
    wrapper.vm.undo()
    expect(graph.undoCalls).toBe(1)

    graph._canRedo = true
    wrapper.vm.redo()
    expect(graph.redoCalls).toBe(1)

    wrapper.vm.zoomIn()
    wrapper.vm.zoomOut()
    expect(graph.zoomCalls).toEqual([0.1, -0.1])
    wrapper.vm.fitView()
    expect(graph.fitCalls).toBe(1)

    wrapper.vm.clearCanvas()
    expect(graph.getCells()).toHaveLength(0)
    expect(wrapper.vm.exportData().cells).toEqual([])
    wrapper.unmount()
  })

  it('updateNodeProperties / updateEdgeProperties 替换数据并刷新标签', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = graph.addNode({ shape: 'entity-node', data: { name: 'Old', properties: [{ stale: true }] } })
    wrapper.vm.updateNodeProperties(node.id, { name: 'New', properties: [{ fresh: true }] })
    expect(node._data.name).toBe('New')
    expect(node._data.properties).toEqual([{ fresh: true }])
    expect(node._attrs.label.text).toBe('New')

    const edge = graph.addEdge({ data: { edge_type: 'Old' } })
    wrapper.vm.updateEdgeProperties(edge.id, { edge_type: 'Relates', properties: [] })
    expect(edge._data.edge_type).toBe('Relates')
    expect(edge._labels[0].attrs.label.text).toBe('Relates')

    // 不存在的 id：静默
    wrapper.vm.updateNodeProperties('missing', { name: 'X' })
    wrapper.unmount()
  })

  it('exportForSchema：节点/边整理为 schema 入参（自环带 vertices）', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    graph.addNode({ shape: 'entity-node', id: 'n1', data: { name: 'A', description: 'd', properties: [{ name: 'p' }] } })
    const loop = graph.addEdge({ shape: 'self-loop-edge', id: 'e1', source: { cell: 'n1' }, target: { cell: 'n1' }, data: { edge_type: 'L' }, vertices: [{ x: 1, y: 2 }] })

    const schema = wrapper.vm.exportForSchema()
    expect(schema.nodes[0]).toMatchObject({ id: 'n1', data: { name: 'A', entity_type: 'A' } })
    expect(schema.edges[0]).toMatchObject({ id: 'e1', vertices: [{ x: 1, y: 2 }] })

    // 无 vertices 的边：vertices 字段缺省
    loop._vertices = []
    const schema2 = wrapper.vm.exportForSchema()
    expect(schema2.edges[0].vertices).toBeUndefined()
    wrapper.unmount()
  })

  it('deleteSelectedCells / addEdge 的成功与失败分支', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const a = graph.addNode({})
    const b = graph.addNode({})
    graph._selected = [a, b]
    expect(wrapper.vm.deleteSelectedCells()).toBe(2)
    expect(a.removed).toBe(true)
    expect(wrapper.emitted('canvas-click')).toHaveLength(1)

    graph._selected = []
    expect(wrapper.vm.deleteSelectedCells()).toBe(0)

    const edge = wrapper.vm.addEdge({ source: { cell: 'a' }, target: { cell: 'b' } })
    expect(edge).toBeTruthy()
    graph.failAddEdge = true
    expect(wrapper.vm.addEdge({})).toBeNull()
    wrapper.unmount()
  })

  it('卸载：dispose Graph 并解绑事件', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    wrapper.unmount()
    expect(graph.disposed).toBe(true)
    expect(FakeGraph.instances.at(-1)).toBe(graph)
  })
})

describe('Graph 缺失 / 异常 cell 的防御分支', () => {
  it('卸载后：setConnectionMode、主题事件、画布事件都安全降级', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    wrapper.unmount()

    // graph 置 null 后：setConnectionMode 走 console.warn 分支
    wrapper.vm.setConnectionMode('double')
    expect(consoleWarn).toHaveBeenCalledWith('Graph对象不存在')

    // 主题事件：graph 为 null → 直接返回
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))

    // 卸载前注册的画布事件还在假件上：graph 为 null 时各分支静默
    graph.emit('selection:finished')
    graph.emit('node:moving', { node: graph.getNodes()[0] })
    graph.emit('node:moved', { node: graph.getNodes()[0] })
    expect(true).toBe(true)
  })

  it('装饰函数抛错时被 try/catch 吞掉并 console.warn', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = await mountCanvas()
    const graph = editorGraph()

    const badEdge = graph.addEdge({})
    badEdge.attr = () => { throw new Error('attr boom') }
    const badNode = graph.addNode({})
    badNode.getPorts = () => { throw new Error('ports boom') }
    const badNode2 = graph.addNode({})
    badNode2.attr = () => { throw new Error('outline boom') }

    graph.emit('selection:changed', { added: [badEdge, badNode, badNode2], removed: [] })
    await flush()
    expect(consoleWarn).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Ctrl+单击节点只做多选；Ctrl+其它键走 switch default', async () => {
    const wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = graph.addNode({ shape: 'entity-node' })

    graph.emit('node:click', { node, e: evt({ ctrlKey: true }) })
    expect(wrapper.emitted('node-select')).toBeUndefined()

    graph._selected = [node]
    keydown({ key: 'x', ctrlKey: true })
    await flush()
    expect(wrapper.vm.hasCopiedNode).toBe(false)
    wrapper.unmount()
  })

  it('重初始化再次失败：catch 记录错误', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    FakeGraph.failNext = true
    const wrapper = await mountCanvas()

    expect(wrapper.vm.addNode('entity')).toBeNull()
    // re-init 定时器（100ms）触发前再让 Graph 构造失败一次
    FakeGraph.failNext = true
    await wait(200)
    expect(consoleError).toHaveBeenCalledWith('重新初始化失败:', expect.any(Error))
    await wait(100)
    wrapper.unmount()
  })
})
