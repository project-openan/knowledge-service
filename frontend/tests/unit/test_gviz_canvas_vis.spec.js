// @vitest-environment jsdom
/**
 * GraphCanvasVis.vue —— vis-network 画布封装。
 *
 * vis-network 用 FakeNetwork 替身（记录事件回调 / setOptions / moveTo / DataSet 引用），
 * 事件流（click / hover / zoom / afterDrawing / dragEnd / stabilization）由用例直接派发，
 * 逐项钉住：画布事件 → 对外 emit 的映射、可见性状态机（悬浮/选中/持久隐藏）、
 * 增删改节点的落点计算、缩放方法、坐标缓存、主题切换与 resetToken 重建。
 * 真正的 canvas 绘制（ctxRenderer 回调）只有真实渲染循环会调，替身覆盖不到 —— 见文件尾说明。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { flush, mountWithPlugins } from './helpers/mount'

// ── vis-network 替身 ─────────────────────────────────────────────────────────
const { FakeNetwork } = vi.hoisted(() => {
  class FakeNetwork {
    static instances = []
    constructor (container, data, options) {
      this.container = container
      this.data = data
      this.options = options
      this.handlers = {}
      this.scale = 1
      this.positions = {}
      this.viewPosition = { x: 0, y: 0 }
      this.moveToCalls = []
      this.setOptionsCalls = []
      this.redraws = 0
      this.destroyed = false
      this.body = { nodes: {} }
      FakeNetwork.instances.push(this)
    }
    on (event, cb) { (this.handlers[event] ||= []).push(cb) }
    off (event, cb) {
      this.handlers[event] = (this.handlers[event] || []).filter(fn => fn !== cb)
    }
    emit (event, params = {}) { (this.handlers[event] || []).forEach(cb => cb(params)) }
    getScale () { return this.scale }
    getPositions () { return this.positions }
    getViewPosition () { return this.viewPosition }
    moveTo (opts) {
      this.moveToCalls.push(opts)
      if (opts && opts.scale != null) {
        this.scale = opts.scale
      }
    }
    setOptions (opts) { this.setOptionsCalls.push(opts) }
    redraw () { this.redraws += 1 }
    getNodeAt () { return null }
    getEdgeAt () { return null }
    focus () {}
    selectNodes (ids) { this.selectedIds = ids }
    fit () { this.fitCalls = (this.fitCalls || 0) + 1 }
    setSize () { this.setSizeCalls = (this.setSizeCalls || 0) + 1 }
    destroy () {
      this.destroyed = true
      this.emit('destroy')
    }
    canvasToDOM (p) { return { x: p.x, y: p.y } }
    DOMtoCanvas (p) { return { x: p.x, y: p.y } }
  }
  return { FakeNetwork }
})
vi.mock('vis-network', () => ({ Network: FakeNetwork }))

import GraphCanvasVis from '@/features/graph/components/GraphCanvasVis.vue'

const GRAPH_DATA = {
  entities: [
    { entity_id: 'e1', entity_type: 'Scene', properties: { name: '场景甲' } },
    { entity_id: 'e2', entity_type: 'Resource', entity_name: '资源乙' }
  ],
  edges: [{ edge_id: 'r1', edge_type: 'Relates', source_id: 'e1', target_id: 'e2', properties: { relationship_keywords: ['关注'] } }]
}

let rafQueue = []
function pumpRaf () {
  const cbs = rafQueue
  rafQueue = []
  cbs.forEach(cb => cb())
}

async function mountCanvas (extraProps = {}, { graphData = GRAPH_DATA } = {}) {
  const wrapper = await mountWithPlugins(GraphCanvasVis, {
    router: null, // 画布组件不读路由
    attachTo: document.body,
    props: {
      graphData,
      graphId: 'g1',
      colorMap: { Scene: '#8045ff' },
      edgeColorMap: { Relates: '#9aa0a6' },
      ...extraProps
    }
  })
  await flush()
  await flushPromises()
  return wrapper
}

function net () {
  return FakeNetwork.instances.at(-1)
}

/** 让画布容器量出非零尺寸（jsdom 默认全是 0），供展开按钮视口裁剪 / resize 判断用 */
function sizeContainer (wrapper) {
  const el = wrapper.find('.graph-canvas-vis-core').element
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 })
  Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true })
  return el
}

describe('GraphCanvasVis.vue', () => {
  let wrapper

  beforeEach(() => {
    FakeNetwork.instances.length = 0
    rafQueue = []
    localStorage.clear()
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class {
      observe () {}
      unobserve () {}
      disconnect () {}
    })
    // jsdom 的 canvas 2d context 返回 null；组件两条读 canvas 的路径都做了 null 兜底，
    // 这里补一个最小替身让「量字宽 / 颜色归一化」的正向分支跑到
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      fillStyle: '#000000',
      font: '',
      measureText: (text) => ({ width: String(text).length * 7 })
    }))
  })

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('挂载后创建 vis-network：小图默认开力导向，DataSet 与图数据同步', async () => {
    wrapper = await mountCanvas()

    expect(FakeNetwork.instances).toHaveLength(1)
    const network = net()
    expect(network.data.nodes.getIds()).toEqual(['e1', 'e2'])
    expect(network.data.edges.getIds()).toEqual(['r1'])
    expect(network.options.physics.enabled).toBe(true)
    // groups 按主题色板构建，缺 default 兜底
    expect(Object.keys(network.options.groups)).toContain('Scene')
    expect(Object.keys(network.options.groups)).toContain('default')
    wrapper.unmount()
    wrapper = null
  })

  it('inline 标签模式：同步数据时边就带常显标签（取业务类型或第一个关键词）', async () => {
    wrapper = await mountCanvas({ edgeLabelDisplayMode: 'inline' })

    expect(net().data.edges.get('r1').label).toBe('Relates')

    // hover 模式（默认）同步时标签留空，靠悬浮气泡展示
    const wrapper2 = await mountCanvas()
    expect(net().data.edges.get('r1').label).toBe('')
    wrapper2.unmount()
  })

  it('click 节点：emit node-click（实体对象 + 视口坐标）', async () => {
    wrapper = await mountCanvas()

    net().emit('click', { pointer: { DOM: { x: 15, y: 25 } }, nodes: ['e1'], edges: [] })

    expect(wrapper.emitted('node-click')).toHaveLength(1)
    const [entity, pos] = wrapper.emitted('node-click')[0]
    expect(entity.entity_id).toBe('e1')
    expect(pos).toEqual({ x: 15, y: 25 })
  })

  it('400ms 内点同一节点两次：第二次走 node-double-click（不再发 node-click）', async () => {
    wrapper = await mountCanvas()

    net().emit('click', { pointer: { DOM: { x: 1, y: 1 } }, nodes: ['e1'] })
    net().emit('click', { pointer: { DOM: { x: 1, y: 1 } }, nodes: ['e1'] })

    expect(wrapper.emitted('node-click')).toHaveLength(1)
    expect(wrapper.emitted('node-double-click')).toHaveLength(1)
  })

  it('click 边：emit edge-click；同一边快速两击 → edge-double-click', async () => {
    wrapper = await mountCanvas()

    net().emit('click', { pointer: { DOM: { x: 2, y: 2 } }, nodes: [], edges: ['r1'] })
    expect(wrapper.emitted('edge-click')).toHaveLength(1)

    net().emit('click', { pointer: { DOM: { x: 2, y: 2 } }, nodes: [], edges: ['r1'] })
    expect(wrapper.emitted('edge-double-click')).toHaveLength(1)
  })

  it('click 空白处：emit container-click', async () => {
    wrapper = await mountCanvas()

    net().emit('click', { nodes: [], edges: [] })

    expect(wrapper.emitted('container-click')).toHaveLength(1)
  })

  it('doubleClick 事件直接映射到节点/边双击', async () => {
    wrapper = await mountCanvas()

    net().emit('doubleClick', { nodes: ['e2'] })
    net().emit('doubleClick', { nodes: [], edges: ['r1'] })

    expect(wrapper.emitted('node-double-click')[0][0].entity_id).toBe('e2')
    expect(wrapper.emitted('edge-double-click')[0][0].edge_id).toBe('r1')
  })

  it('hoverNode：rAF 合并后高亮相邻边（加宽 + 换悬浮色）；blurNode 恢复', async () => {
    wrapper = await mountCanvas()

    net().emit('hoverNode', { node: 'e1' })
    pumpRaf()

    const edge = net().data.edges.get('r1')
    expect(edge.width).toBe(2)
    expect(edge.color.color).toBeTruthy()

    net().emit('blurNode')
    const restored = net().data.edges.get('r1')
    expect(restored.width).toBe(1.4)
    expect(net().redraws).toBeGreaterThan(0)
  })

  it('hoverEdge（悬浮模式）：显示完整标签气泡，mousemove 跟随，blurEdge 关闭', async () => {
    wrapper = await mountCanvas()

    net().emit('hoverEdge', { edge: 'r1', pointer: { DOM: { x: 40, y: 50 } } })
    await flush()

    expect(wrapper.find('.graph-canvas-vis__edge-popover').exists()).toBe(true)
    expect(wrapper.find('.graph-canvas-vis__edge-popover').text()).toBe('Relates')

    net().emit('mousemove', { pointer: { DOM: { x: 60, y: 70 } } })
    await flush()
    expect(wrapper.find('.graph-canvas-vis__edge-popover').attributes('style')).toContain('left: 60px')

    net().emit('blurEdge')
    await flush()
    expect(wrapper.find('.graph-canvas-vis__edge-popover').exists()).toBe(false)
  })

  it('inline 模式下 hoverEdge 不再弹悬浮气泡（标签已常显）', async () => {
    wrapper = await mountCanvas({ edgeLabelDisplayMode: 'inline' })

    net().emit('hoverEdge', { edge: 'r1', pointer: { DOM: { x: 40, y: 50 } } })

    expect(wrapper.find('.graph-canvas-vis__edge-popover').exists()).toBe(false)
  })

  it('zoom 事件：上报缩放比例', async () => {
    wrapper = await mountCanvas()
    net().scale = 1.5

    net().emit('zoom')

    expect(wrapper.emitted('zoom-change')[0]).toEqual([1.5])
  })

  it('dragEnd：把节点坐标写进 localStorage 坐标缓存', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 10, y: 20 }, e2: { x: 110, y: 120 } }

    net().emit('dragEnd')

    const cached = JSON.parse(localStorage.getItem('kg_positions_g1'))
    expect(cached.e1).toEqual({ x: 10, y: 20 })
    expect(wrapper.emitted('after-drawing').length).toBeGreaterThan(0)
  })

  it('stabilizationIterationsDone：停物理、解锁节点、按 100% 居中并上报', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 0, y: 0 }, e2: { x: 30, y: 0 } }

    net().emit('stabilizationIterationsDone')

    const lastSetOptions = net().setOptionsCalls.at(-1)
    expect(lastSetOptions.physics.enabled).toBe(false)
    expect(net().data.nodes.get('e1').fixed).toBe(false)
    expect(net().moveToCalls.at(-1).scale).toBe(1)
    expect(wrapper.emitted('zoom-change')[0]).toEqual([1])
    expect(wrapper.emitted('after-drawing').length).toBeGreaterThan(0)
  })

  it('启动时已有坐标缓存：跳过力导向，稳表后直接收拢布局', async () => {
    localStorage.setItem('kg_positions_g1', JSON.stringify({ e1: { x: 5, y: 5 }, e2: { x: 205, y: 105 } }))
    wrapper = await mountCanvas()

    const network = net()
    expect(network.options.physics.enabled).toBe(false)
    expect(network.options.interaction.dragNodes).toBe(true)

    // initNetwork 里 nextTick + setTimeout(0) 的收拢链
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(network.moveToCalls.at(-1).scale).toBe(1)
    expect(wrapper.emitted('zoom-change')[0]).toEqual([1])
  })

  it('超大图（>200 节点）：关物理、网格初始布局；未过 300 渲染阈值时 hover 保留', async () => {
    const big = {
      entities: Array.from({ length: 210 }, (_, i) => ({ entity_id: `n${i}`, entity_type: 'Scene' })),
      edges: []
    }
    wrapper = await mountCanvas({}, { graphData: big })

    const network = net()
    expect(network.options.physics.enabled).toBe(false)
    // 210 节点过的是 200 的物理阈值，不是 300 的渲染降级阈值
    expect(network.options.interaction.hover).toBe(true)
    expect(network.options.interaction.dragNodes).toBe(true)
    // 简单网格布局给每个节点都安排了坐标
    expect(network.data.nodes.length).toBe(210)
  })

  it('画布空白处按下拖动：按位移平移视口；松开后停止', async () => {
    wrapper = await mountCanvas()
    const el = sizeContainer(wrapper)
    net().viewPosition = { x: 0, y: 0 }

    el.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 90 }))
    window.dispatchEvent(new MouseEvent('mouseup', {}))

    expect(net().moveToCalls).toEqual([
      { position: { x: -40, y: 10 }, animation: false }
    ])

    // 松开后再次移动不再平移
    const before = net().moveToCalls.length
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200 }))
    expect(net().moveToCalls.length).toBe(before)
  })

  it('afterDrawing：裁剪节点边界并触发展开按钮重算 + after-drawing 上报', async () => {
    wrapper = await mountCanvas()
    sizeContainer(wrapper)
    net().positions = { e1: { x: 100, y: 100 } }
    net().body.nodes = { e1: { id: 'e1' } }

    net().emit('afterDrawing')
    pumpRaf()

    expect(net().body.nodes.e1.distanceToBorder).toBeTypeOf('function')
    expect(net().body.nodes.e1.__rsCircleBorderClip).toBe(true)
    expect(wrapper.emitted('after-drawing').length).toBeGreaterThan(0)
  })

  it('展开按钮浮层：有出向边的节点渲染 +/- 按钮，点击 emit toggle-expand', async () => {
    wrapper = await mountCanvas()
    sizeContainer(wrapper)
    net().positions = { e1: { x: 100, y: 100 } }
    net().body.nodes = { e1: { id: 'e1' } }

    net().emit('afterDrawing')
    pumpRaf()
    await flush()

    const fab = wrapper.find('.node-expand-fab')
    expect(fab.exists()).toBe(true)

    await fab.trigger('click')
    expect(wrapper.emitted('toggle-expand')[0]).toEqual(['e1'])
  })

  it('缩放过小时（< 0.35）不渲染展开按钮，避免全图视口内塞满 DOM', async () => {
    wrapper = await mountCanvas()
    sizeContainer(wrapper)
    net().scale = 0.2
    net().positions = { e1: { x: 100, y: 100 } }
    net().body.nodes = { e1: { id: 'e1' } }

    net().emit('afterDrawing')
    pumpRaf()

    expect(wrapper.find('.node-expand-fab').exists()).toBe(false)
  })

  it('expose：zoomIn / zoomOut / resetZoom / setZoomScale 都落到 network.moveTo 并上报', async () => {
    wrapper = await mountCanvas()

    wrapper.vm.zoomIn()
    expect(net().moveToCalls.at(-1).scale).toBeCloseTo(1.2)

    wrapper.vm.zoomOut()
    expect(net().moveToCalls.at(-1).scale).toBeCloseTo(1)

    wrapper.vm.resetZoom()
    expect(net().moveToCalls.at(-1).scale).toBe(1)
    expect(wrapper.emitted('zoom-change').at(-1)).toEqual([1])

    wrapper.vm.setZoomScale(2)
    expect(net().moveToCalls.at(-1).scale).toBe(2)

    wrapper.vm.setZoomScale('abc')
    wrapper.vm.setZoomScale(99)
    expect(net().moveToCalls.at(-1).scale).toBe(5)

    expect(wrapper.vm.getScale()).toBe(5)
    expect(wrapper.vm.getNetwork()).toBe(net())
  })

  it('expose：fit 带动画（动画结束才上报比例），fitImmediate 立即上报', async () => {
    wrapper = await mountCanvas()

    wrapper.vm.fit()
    expect(net().fitCalls).toBe(1)
    expect(wrapper.emitted('zoom-change')).toBeUndefined()

    net().scale = 0.8
    net().emit('animationFinished')
    expect(wrapper.emitted('zoom-change')[0]).toEqual([0.8])
    // 回调是一次性的：再次触发不再上报
    net().emit('animationFinished')
    expect(wrapper.emitted('zoom-change')).toHaveLength(1)

    wrapper.vm.fitImmediate()
    expect(net().fitCalls).toBe(2)
    expect(wrapper.emitted('zoom-change').at(-1)).toEqual([0.8])
  })

  it('expose：focusNode / selectNodes（过滤空 id）', async () => {
    wrapper = await mountCanvas()
    const focusSpy = vi.spyOn(net(), 'focus')
    const selectSpy = vi.spyOn(net(), 'selectNodes')

    wrapper.vm.focusNode('e1')
    expect(focusSpy).toHaveBeenCalledWith('e1', { animation: true })

    wrapper.vm.selectNodes(['e1', null, undefined])
    expect(selectSpy).toHaveBeenCalledWith(['e1'])

    wrapper.vm.selectNodes('not-array')
    expect(selectSpy).toHaveBeenCalledWith([])
  })

  it('expose：getNodePosition 的 id 归一化与兜底查找', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 1, y: 2 } }

    expect(wrapper.vm.getNodePosition('e1')).toEqual({ x: 1, y: 2 })
    expect(wrapper.vm.getNodePosition(null)).toBeNull()
    expect(wrapper.vm.getNodePosition('ghost')).toBeNull()
  })

  it('expose：getViewCenterInCanvas 优先 getViewPosition，异常/缺失时兜底 {0,0}', async () => {
    wrapper = await mountCanvas()
    net().viewPosition = { x: 12, y: 34 }
    expect(wrapper.vm.getViewCenterInCanvas()).toEqual({ x: 12, y: 34 })

    net().viewPosition = { x: NaN, y: NaN }
    net().body.view = { translation: { x: -50, y: -25 } }
    expect(wrapper.vm.getViewCenterInCanvas()).toEqual({ x: 50, y: 25 })

    net().body.view = null
    expect(wrapper.vm.getViewCenterInCanvas()).toEqual({ x: 0, y: 0 })
  })

  it('expose：getSnapshotDataUrl 从 vis 内部 canvas 导出 PNG；无 network 时为空串', async () => {
    wrapper = await mountCanvas()
    net().canvas = { frame: { canvas: { toDataURL: () => 'data:image/png;base64,AA' } } }
    expect(wrapper.vm.getSnapshotDataUrl()).toBe('data:image/png;base64,AA')
    wrapper.unmount()
    wrapper = null

    const before = await mountCanvas()
    expect(before.vm.getSnapshotDataUrl()).toBe('')
    before.unmount()
    wrapper = null
  })

  it('expose：addNode 无坐标时在关联节点旁落点；无参考时给兜底坐标', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 0, y: 0 } }

    const pos = wrapper.vm.addNode({ entity_id: 'e9', entity_type: 'Scene', entity_name: '新' }, 'e1')
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true)
    expect(net().data.nodes.get('e9').id).toBe('e9')

    await new Promise(resolve => setTimeout(resolve, 5))
    // 新节点入图后物理被关掉、fixed 解锁
    expect(net().data.nodes.get('e9').fixed).toBe(false)
    expect(net().setOptionsCalls.at(-1).physics.enabled).toBe(false)
  })

  it('expose：updateNode 存在则更新（保坐标）、不存在则新增；updateEdge 同理', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 7, y: 8 } }

    wrapper.vm.updateNode({ entity_id: 'e1', entity_type: 'Scene', properties: { name: '改名' } })
    expect(net().data.nodes.get('e1').group).toBe('Scene')

    wrapper.vm.updateNode({ entity_id: 'e3', entity_type: 'Resource' })
    expect(net().data.nodes.getIds()).toContain('e3')

    wrapper.vm.updateEdge({ edge_id: 'r1', edge_type: 'Owns', source_id: 'e1', target_id: 'e2' })
    wrapper.vm.updateEdge({ edge_id: 'r2', edge_type: 'Owns', source_id: 'e2', target_id: 'e1' })
    expect(net().data.edges.get('r1')).toBeTruthy()
    expect(net().data.edges.getIds()).toContain('r2')

    wrapper.vm.removeEdge('r2')
    expect(net().data.edges.getIds()).not.toContain('r2')
    wrapper.vm.removeNode('e3')
    expect(net().data.nodes.getIds()).not.toContain('e3')
  })

  // centerView 只出现在 setup return（供模板/父组件经 getNetwork 之外的路径调用），
  // 未列入 defineExpose，外部不可达 —— 不强测（父组件 centerGraph 走 getNetwork() 直调 network）。
  it('expose：compactLayoutToFit 在 <2 个有效节点时是安全空操作', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 0, y: 0 } }

    expect(() => wrapper.vm.compactLayoutToFit()).not.toThrow()
    expect(net().moveToCalls).toHaveLength(0)
  })

  it('expose：syncVisibilityFromHiddenProps 按持久隐藏列表隐藏节点及其连边', async () => {
    wrapper = await mountCanvas()

    wrapper.setProps({ persistentlyHiddenNodeIds: ['e2'] })
    await flush()
    await flushPromises()

    expect(net().data.nodes.get('e2').hidden).toBe(true)
    expect(net().data.edges.get('r1').hidden).toBe(true)
    expect(wrapper.emitted('after-drawing').length).toBeGreaterThan(0)
  })

  it('edgeLabelDisplayMode 变为 inline：边标签批量落 DataSet 并重绘', async () => {
    wrapper = await mountCanvas()

    wrapper.setProps({ edgeLabelDisplayMode: 'inline' })
    await flush()

    expect(net().data.edges.get('r1').label).toBe('Relates')
    expect(net().redraws).toBeGreaterThan(0)
  })

  it('colorMap 变化：setOptions 更新 groups 并重绘', async () => {
    wrapper = await mountCanvas()

    wrapper.setProps({ colorMap: { Scene: '#09aa57' } })
    await flush()

    expect(net().setOptionsCalls.at(-1).groups.Scene).toBeTruthy()
    expect(net().redraws).toBeGreaterThan(0)
  })

  it('resetToken 变化：销毁旧画布并重建（清坐标缓存后重走挂载流程）', async () => {
    wrapper = await mountCanvas()
    net().positions = { e1: { x: 1, y: 1 } }
    net().emit('dragEnd')
    expect(localStorage.getItem('kg_positions_g1')).toBeTruthy()

    wrapper.setProps({ resetToken: 1 })
    await flush()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
    await flush()

    expect(FakeNetwork.instances).toHaveLength(2)
    expect(net().destroyed).toBe(false)
    expect(localStorage.getItem('kg_positions_g1')).toBeNull()
  })

  it('主题切换事件：原地更新颜色 options 并重绘（不重建 Network）', async () => {
    wrapper = await mountCanvas()
    const setOptionsCount = net().setOptionsCalls.length

    window.dispatchEvent(new CustomEvent('ragstudio:theme-change', { detail: { theme: 'dark' } }))

    expect(net().setOptionsCalls.length).toBe(setOptionsCount + 1)
    expect(net().setOptionsCalls.at(-1).groups).toBeTruthy()
    expect(net().redraws).toBeGreaterThan(0)
    expect(FakeNetwork.instances).toHaveLength(1)
  })

  it('ResizeObserver 回调：容器有尺寸时触发重绘（rAF 合并）', async () => {
    wrapper = await mountCanvas()
    sizeContainer(wrapper)
    let observerCb
    vi.stubGlobal('ResizeObserver', class {
      constructor (cb) { observerCb = cb }
      observe () {}
      disconnect () {}
    })

    // 重新挂一个用能拿到 cb 的 stub 的实例
    wrapper.unmount()
    wrapper = await mountCanvas()
    sizeContainer(wrapper)
    observerCb()

    pumpRaf()
    expect(net().redraws).toBeGreaterThan(0)
  })

  it('图数据变化：增量同步（新增节点进 DataSet）', async () => {
    wrapper = await mountCanvas()

    wrapper.setProps({
      graphData: {
        entities: [...GRAPH_DATA.entities, { entity_id: 'e3', entity_type: 'Scene' }],
        edges: GRAPH_DATA.edges
      }
    })
    await flush()
    await flushPromises()

    expect(net().data.nodes.getIds()).toEqual(['e1', 'e2', 'e3'])
  })

  it('图数据清空：走全量同步（缓存全清）', async () => {
    wrapper = await mountCanvas()

    wrapper.setProps({ graphData: { entities: [], edges: [] } })
    await flush()
    await flushPromises()

    expect(net().data.nodes.length).toBe(0)
    expect(net().data.edges.length).toBe(0)
  })

  it('卸载：销毁 network、清空浮层状态', async () => {
    wrapper = await mountCanvas()
    const network = net()

    wrapper.unmount()
    wrapper = null

    expect(network.destroyed).toBe(true)
  })
})
