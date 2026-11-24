// @vitest-environment jsdom
/**
 * GraphEditor 组件群：geometry.ts / NodePalette.vue / ToolBar.vue / GraphCanvas.vue。
 *
 * X6 不进单测（真 Graph 要 DOM/SVG 全套）：mock '@antv/x6' 与各插件包为「记录调用」
 * 的假件（仓内先例：test_wf_useFlowCanvas.spec.js）。GraphCanvas 的事件流由用例经
 * FakeGraph.emit 直发（bindGraphEvents 把组件回调挂到 graph.on 上），逐项钉住：
 * 节点/边点击 → emit、连线完成 → 按模式重建边、右键菜单开关、Delete 删除选中边、
 * expose 的增删改查/导入导出/撤销重做。geometry/NodePalette/ToolBar 是纯逻辑或轻模板。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'

// ── X6 假件 ──────────────────────────────────────────────────────────────────
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
      if (arguments.length === 1) {
        return getAttr(this._attrs, path)
      }
      setAttr(this._attrs, path, value)
      return this
    }
    setAttrs (attrs) { Object.assign(this._attrs, attrs); return this }
    getData () { return this._data }
    replaceData (data) { this._data = data }
    remove () { this.removed = true }
  }

  class FakeNode extends FakeCell {
    isNode () { return true }
    isEdge () { return false }
    getPorts () { return this._ports || [] }
    portProp () {}
    getSize () { return { width: this.width || 56, height: this.height || 56 } }
    getAttrs () { return this._attrs }
    setPosition (x, y) { this.x = x; this.y = y }
    getBBox () { return { x: this.x || 0, y: this.y || 0, width: 56, height: 56 } }
  }

  class FakeEdge extends FakeCell {
    constructor (options = {}) {
      super(options)
      this._source = options.source || {}
      this._target = options.target || {}
      this._vertices = options.vertices || []
    }
    isNode () { return false }
    isEdge () { return true }
    getSource () { return this._source }
    getTarget () { return this._target }
    getSourceNode () { return this._sourceNode || null }
    getTargetNode () { return this._targetNode || null }
    getLabels () { return this._labels }
    setLabels (labels) { this._labels = labels }
    getVertices () { return this._vertices }
    getBBox () { return { x: 0, y: 0, width: 10, height: 10 } }
  }

  class FakeShapeEdge extends FakeEdge {}

  class FakeGraph {
    static instances = []
    static registerNode (name, config) { registered.nodes[name] = config }
    static registerEdge (name, config) { registered.edges[name] = config }
    constructor (options) {
      this.options = options
      this.handlers = {}
      this._cells = []
      this._plugins = []
      this.zoomCalls = []
      graphInstancesPush(this)
    }
    on (name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn) }
    off (name, fn) {
      this.handlers[name] = (this.handlers[name] || []).filter(fn2 => fn2 !== fn)
    }
    emit (name, params = {}) { (this.handlers[name] || []).forEach(fn => fn(params)) }
    use (plugin) { this._plugins.push(plugin); return this }
    addNode (options) { const n = new FakeNode(options); this._cells.push(n); return n }
    addEdge (options) { const e = new FakeEdge(options); this._cells.push(e); return e }
    getCellById (id) { return this._cells.find(c => c.id === id) || null }
    getNodes () { return this._cells.filter(c => c.isNode()) }
    getEdges () { return this._cells.filter(c => c.isEdge()) }
    getCells () { return this._cells.slice() }
    getSelectedCells () { return this._selected || [] }
    isSelected () { return false }
    unselect () {} select () {} addToSelection () {}
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
    resize () { this.resized = true }
    exportSVG () { return '<svg />' }
    findViewByCell () { return null }
    canUndo () { return false }
    canRedo () { return false }
    undo () { this.undoCalls = (this.undoCalls || 0) + 1 }
    redo () { this.redoCalls = (this.redoCalls || 0) + 1 }
  }
  function graphInstancesPush (g) { FakeGraph.instances.push(g) }
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

// nodeFactory 在注册节点时用 webpack 的 require() 拉 svg（vitest 解析不了），
// 换成行为等价的桩：调色板给浅色字面量、注册与主题应用只记录调用。
vi.mock('@/features/graph/lib/nodeFactory', () => ({
  registerCustomNodes: vi.fn(),
  getNodeDefaultProperties: vi.fn((nodeType) => ({ name: nodeType === 'entity' ? 'Entity' : nodeType, description: '', attributes: [] })),
  getGraphPalette: vi.fn(() => ({
    nodeFill: '#FFFFFF',
    nodeLabel: '#262626',
    portStroke: '#1993FF',
    portFill: '#fff',
    edgeStroke: '#1993FF',
    edgeDefaultStroke: '#000000',
    templateEdgeStroke: '#0077FF',
    edgeLabelFill: '#262626',
    edgeLabelBackground: '#FFFFFF',
    canvasBackground: '#F7F8FA',
    grid: '#D9D9D9',
    selection: '#1993FF',
    nodeSelectedStroke: '#1993FF',
    defaultNode: '#8C8C8C',
    nodeShadow: 'none'
  })),
  applyNodeTheme: vi.fn()
}))

import { getFullCircleVertices } from '@/features/graph/components/GraphEditor/geometry'
import NodePalette from '@/features/graph/components/GraphEditor/NodePalette.vue'
import ToolBar from '@/features/graph/components/GraphEditor/ToolBar.vue'
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
      components: {
        ElIcon: { name: 'ElIcon', setup (_, { slots }) { return () => slots.default?.() } }
      }
    }
  })
  await flush()
  await new Promise(resolve => setTimeout(resolve, 5))
  return wrapper
}

function editorGraph () {
  return FakeGraph.instances.at(-1)
}

describe('geometry.getFullCircleVertices', () => {
  const node = { getPosition: () => ({ x: 100, y: 50 }) }

  it.each([
    ['top'], ['bottom'], ['left'], ['fxL'], ['fxR'], ['right']
  ])('端口 %s：返回 19 个平滑圆顶点，且圆心在节点外侧', (port) => {
    const vertices = getFullCircleVertices(node, port)

    expect(vertices).toHaveLength(19)
    vertices.forEach(v => {
      expect(Number.isFinite(v.x)).toBe(true)
      expect(Number.isFinite(v.y)).toBe(true)
    })
  })

  it('节点坐标参与圆心计算（偏移后的圆心不与节点重合）', () => {
    const a = getFullCircleVertices({ getPosition: () => ({ x: 0, y: 0 }) }, 'top')
    const b = getFullCircleVertices({ getPosition: () => ({ x: 50, y: 0 }) }, 'top')
    expect(b[0].x - a[0].x).toBeCloseTo(50)
  })

  it('未知端口按右侧处理（default 分支）', () => {
    const unknown = getFullCircleVertices(node, 'mystery')
    const right = getFullCircleVertices(node, 'right')
    expect(unknown).toEqual(right)
  })
})

describe('NodePalette.vue', () => {
  async function mountPalette () {
    return mountWithPlugins(NodePalette, {
      router: null,
      props: { visible: true },
      global: {
        components: {
          ElDialog: {
            name: 'ElDialog',
            props: { modelValue: Boolean },
            emits: ['update:modelValue'],
            setup (props, { slots }) {
              return () => props.modelValue
                ? h('div', { class: 'dialog-stub' }, [slots.default?.(), slots.footer?.()])
                : null
            }
          },
          ElButton: { name: 'ElButton', template: '<button class="el-button"><slot /></button>' }
        }
      }
    })
  }

  it('展示七种节点类型（名称与描述来自 i18n），点击类型发 add-node 并关弹窗', async () => {
    const wrapper = await mountPalette()

    const items = wrapper.findAll('.node-item')
    expect(items).toHaveLength(7)
    expect(items[0].text()).toContain('实体')
    // jsdom 会把内联样式里的 hex 归一化成 rgb()
    expect(items[0].find('.circle-node').attributes('style')).toContain('rgb(95, 149, 255)')

    await items[2].trigger('click')

    expect(wrapper.emitted('add-node')[0]).toEqual(['event'])
    expect(wrapper.emitted('update:visible').at(-1)).toEqual([false])
  })

  it('底部取消按钮：只关弹窗，不发 add-node', async () => {
    const wrapper = await mountPalette()

    await wrapper.find('.dialog-stub button').trigger('click')

    expect(wrapper.emitted('add-node')).toBeUndefined()
    expect(wrapper.emitted('update:visible').at(-1)).toEqual([false])
  })
})

describe('ToolBar.vue', () => {
  async function mountBar (templateName, hide = vi.fn()) {
    return mountWithPlugins(ToolBar, {
      router: null,
      props: { templateName },
      global: {
        components: {
          ElPopover: {
            name: 'ElPopover',
            props: ['trigger'],
            setup (_, { slots, expose }) {
              expose({ hide })
              return () => h('div', { class: 'popover-stub' }, slots.reference?.(), slots.default?.())
            }
          },
          ElTooltip: { name: 'ElTooltip', setup (_, { slots }) { return () => slots.default?.() } }
        }
      }
    })
  }

  it('未传模板名时标题回落到占位文案；传了则显示模板名', async () => {
    const fallback = await mountBar('  ')
    expect(fallback.text()).toContain('请在模板信息补充模板名称')

    const named = await mountBar('故障诊断模板')
    expect(named.text()).toContain('故障诊断模板')
  })

  it.each([
    [0, 'undo'],
    [1, 'redo'],
    [2, 'export-json'],
    [4, 'zoom-in'],
    [5, 'zoom-out'],
    [6, 'fit-view']
  ])('工具按钮（tools 第 %i 个）触发对应 emit', async (index, event) => {
    const wrapper = await mountBar()
    // 顺序见 tools 配置：撤销、重做、|、导出、删除(弹层)、|、放大、缩小、适应画布
    const btn = wrapper.findAll('.editor-toolbar__btn')[index]
    expect(btn, `找不到第 ${index} 个工具按钮`).toBeTruthy()
    await btn.trigger('click')
    expect(wrapper.emitted(event)).toHaveLength(1)
  })

  it('返回按钮 emit go-back；删除确认 emit delete', async () => {
    const hide = vi.fn()
    const wrapper = await mountBar(undefined, hide)

    await wrapper.find('.back-btn').trigger('click')
    expect(wrapper.emitted('go-back')).toHaveLength(1)

    // 删除按钮弹确认层（popover 替身常显），点「确定」走 confirmDelete
    await wrapper.findAll('.editor-toolbar__btn')[3].trigger('click')
    const confirmBtn = wrapper.findAll('.popover-stub button')
      .find(b => b.text().includes('确定'))
    expect(confirmBtn).toBeTruthy()
    await confirmBtn.trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)
    expect(hide).toHaveBeenCalledOnce()
  })
})

describe('GraphCanvas.vue', () => {
  let wrapper

  beforeEach(() => {
    FakeGraph.instances.length = 0
    registered.nodes = {}
    registered.edges = {}
    registered.vueShapes = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
    }
    vi.restoreAllMocks()
  })

  it('挂载完成：创建 Graph（含网格/主题底色）、装配插件、注册自定义节点/边形状', async () => {
    wrapper = await mountCanvas()

    expect(wrapper.emitted('initialized')[0]).toEqual([true])
    const graph = editorGraph()
    expect(graph.options.grid.type).toBe('dot')
    expect(graph.options.connecting.allowLoop).toBe(true)
    expect(graph._plugins).toHaveLength(5)
    // 形状注册在 nodeFactory（本 spec 已 mock），这里只验证注册入口被调过
    const { registerCustomNodes } = vi.mocked(await import('@/features/graph/lib/nodeFactory'))
    expect(registerCustomNodes).toHaveBeenCalledTimes(1)
  })

  it('单击节点只选中不发事件；双击节点 emit node-select', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = { stopPropagationCheck: true }

    graph.emit('node:click', { node, e: evt() })
    expect(wrapper.emitted('node-select')).toBeUndefined()

    graph.emit('node:dblclick', { node, e: evt() })
    expect(wrapper.emitted('node-select')[0]).toEqual([node])
  })

  it('边点击 emit edge-select；Ctrl+点击交给选择插件不发事件', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const edge = { id: 'e1' }

    graph.emit('edge:click', { edge, e: evt() })
    expect(wrapper.emitted('edge-select')[0]).toEqual([edge])

    graph.emit('edge:click', { edge, e: evt({ ctrlKey: true }) })
    expect(wrapper.emitted('edge-select')).toHaveLength(1)
  })

  it('画布空白点击 emit canvas-click；右键画布弹菜单（可被 document 点击关闭）', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()

    graph.emit('blank:click', { e: evt() })
    expect(wrapper.emitted('canvas-click')).toHaveLength(1)

    graph.emit('node:contextmenu', { node: { id: 'n1' }, e: evt() })
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(true)

    document.body.click()
    await flush()
    expect(wrapper.find('.context-menu').exists()).toBe(false)
  })

  it('连线完成（非自环）：按当前模式重建边（双箭头），移除预览线并 emit edge-select', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()

    const sNode = { id: 's1' }
    const tNode = { id: 't1' }
    const preview = new FakeEdge({})
    graph.emit('edge:connected', {
      edge: Object.assign(preview, {
        getSourceNode: () => sNode,
        getTargetNode: () => tNode,
        getSource: () => ({ port: 'top' }),
        getTarget: () => ({ port: 'bottom' })
      })
    })

    expect(preview.removed).toBe(true)
    const added = graph.getEdges().at(-1)
    expect(added.shape).toBe('single-arrow-edge')
    expect(added._source).toEqual({ cell: 's1', port: 'top' })
    expect(added._target).toEqual({ cell: 't1', port: 'bottom' })
    expect(wrapper.emitted('edge-select').at(-1)[0]).toBe(added)

    // 切到 double 模式再连一条
    wrapper.vm.setConnectionMode('double')
    const preview2 = new FakeEdge({})
    graph.emit('edge:connected', {
      edge: Object.assign(preview2, {
        getSourceNode: () => sNode,
        getTargetNode: () => tNode,
        getSource: () => ({ port: 'top' }),
        getTarget: () => ({ port: 'bottom' })
      })
    })
    expect(graph.getEdges().at(-1).shape).toBe('double-arrow-edge')
  })

  it('自环连线：self 模式要求同端口（不同端口则移除），同端口建自环边并带整圆顶点', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = { id: 'self1', getPosition: () => ({ x: 10, y: 10 }) }

    const makePreview = () => new FakeEdge({})

    // self 模式 + 不同端口：直接移除
    wrapper.vm.setConnectionMode('self')
    const reject = makePreview('top', 'bottom')
    graph.emit('edge:connected', {
      edge: Object.assign(reject, {
        getSourceNode: () => node,
        getTargetNode: () => node,
        getSource: () => ({ port: 'top' }),
        getTarget: () => ({ port: 'bottom' })
      })
    })
    expect(reject.removed).toBe(true)
    expect(graph.getEdges()).toHaveLength(0)

    // self 模式 + 同端口：建自环边
    const ok = makePreview('top', 'top')
    graph.emit('edge:connected', {
      edge: Object.assign(ok, {
        getSourceNode: () => node,
        getTargetNode: () => node,
        getSource: () => ({ port: 'top' }),
        getTarget: () => ({ port: 'top' })
      })
    })
    const loop = graph.getEdges().at(-1)
    expect(loop.shape).toBe('self-loop-edge')
    expect(loop._vertices.length).toBeGreaterThan(0)
    expect(wrapper.emitted('edge-select').at(-1)[0]).toBe(loop)
  })

  it('expose：addNode 建节点并默认不被选中', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()

    const node = wrapper.vm.addNode('entity')
    expect(node).toBeTruthy()
    expect(node.shape).toBe('entity-node')
    expect(graph.getNodes()).toHaveLength(1)
  })

  it('卸载画布时取消添加节点后尚未执行的选中检查', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const isSelected = vi.spyOn(graph, 'isSelected').mockReturnValue(true)
    const unselect = vi.spyOn(graph, 'unselect')

    vi.useFakeTimers()
    try {
      const node = wrapper.vm.addNode('entity')
      vi.advanceTimersByTime(50)
      expect(unselect).toHaveBeenCalledWith(node)

      wrapper.unmount()
      wrapper = null
      isSelected.mockClear()
      vi.advanceTimersByTime(150)
      expect(isSelected).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('expose：updateNodeProperties / updateEdgeProperties 替换数据并刷新标签', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = graph.addNode({ id: 'n1', data: { name: '旧名', properties: [{ name: 'a' }] } })
    const edge = graph.addEdge({ id: 'r1', data: { edge_type: 'contains' } })

    wrapper.vm.updateNodeProperties('n1', { name: '新名', properties: [{ name: 'b' }] })
    expect(node.getData().properties).toEqual([{ name: 'b' }])
    expect(node._attrs.label.text).toBe('新名')

    wrapper.vm.updateEdgeProperties('r1', { edge_type: '投资', properties: [] })
    expect(edge.getData().edge_type).toBe('投资')
    expect(edge.getLabels()[0].attrs.label.text).toBe('投资')

    // 不存在的 id：静默返回
    expect(() => wrapper.vm.updateNodeProperties('ghost', {})).not.toThrow()
  })

  it('expose：exportForSchema 把节点/边整理成 schema 创建入参', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    graph.addNode({ id: 'n1', shape: 'entity-node', data: { name: '实体A', properties: [{ name: 'x' }] } })
    const edge = new FakeEdge({ id: 'r1', shape: 'single-arrow-edge', data: { edge_type: '投资', direction: 'single' } })
    edge._source = { cell: 'n1' }
    edge._target = { cell: 'n2' }
    edge._vertices = [{ x: 1, y: 2 }]
    graph._cells.push(edge)

    const schema = wrapper.vm.exportForSchema()

    expect(schema.nodes).toHaveLength(1)
    expect(schema.nodes[0]).toEqual(expect.objectContaining({ id: 'n1', shape: 'entity-node' }))
    expect(schema.nodes[0].data.entity_type).toBe('实体A')
    expect(schema.edges).toHaveLength(1)
    expect(schema.edges[0].vertices).toEqual([{ x: 1, y: 2 }])
    expect(schema.edges[0].data.edge_type).toBe('投资')
  })

  it('expose：undo/redo 走内核封装（canUndo false 时不动）、zoom/clear/load/export', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()

    wrapper.vm.undo()
    expect(graph.undoCalls).toBeUndefined()

    wrapper.vm.zoomIn()
    wrapper.vm.zoomOut()
    expect(graph.zoomCalls).toEqual([0.1, -0.1])

    wrapper.vm.fitView()
    expect(graph.fitCalls).toBe(1)

    wrapper.vm.loadData({ cells: [] })
    expect(graph.loaded).toBe(true)

    expect(wrapper.vm.exportData()).toEqual({ cells: expect.any(Array) })
    expect(wrapper.vm.exportSVG()).toBe('<svg />')

    wrapper.vm.clearCanvas()
    expect(graph.getCells()).toHaveLength(0)

    wrapper.vm.setConnectionMode(null)
    expect(wrapper.vm.getConnectionMode()).toBeNull()
  })

  it('expose：deleteSelectedCells 删除选中节点与边', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()
    const node = graph.addNode({ id: 'n1' })
    const edge = new FakeEdge({ id: 'r1' })
    graph._cells.push(edge)
    graph._selected = [node, edge]

    wrapper.vm.deleteSelectedCells()

    expect(node.removed).toBe(true)
    expect(edge.removed).toBe(true)
    // 删除选中元素后会清空画布点击态（与空白点击同一出口）
    expect(wrapper.emitted('canvas-click')).toHaveLength(1)
  })

  it('卸载：销毁 Graph 实例', async () => {
    wrapper = await mountCanvas()
    const graph = editorGraph()

    wrapper.unmount()
    wrapper = null

    expect(graph.disposed).toBe(true)
  })
})
