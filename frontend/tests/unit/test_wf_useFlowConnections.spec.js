// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'

// 连线交互：拖拽校验、点击-点击连线、选中与删除、Esc 取消。
// X6 用假 graph（beginClickConnection 的预览边用真 Shape.Edge 造）。
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

import { useFlowConnections } from '@/features/workflow/composables/useFlowConnections'
import { useFlowGeometry } from '@/features/workflow/composables/useFlowGeometry'
import { useFlowDrawer } from '@/features/workflow/composables/useFlowDrawer'
import { edgePairsOf } from '@/features/graph/lib/x6-editor-core'
import { deletion, settleDeletion } from '@/shared/composables/deletion'

const methods = useFlowConnections()

function createCtx (overrides = {}) {
  return {
    ...methods,
    ...useFlowGeometry(),
    ...useFlowDrawer(),
    graph: null,
    $t: (key, params) => key + (params ? '|' + Object.values(params).join('|') : ''),
    $message: Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
    $nextTick: fn => fn(),
    connectingSource: '',
    connectingSourceLabel: '',
    connectingPortId: '',
    previewEdgeId: '',
    connectionTargetId: '',
    selectedEdge: null,
    hoveredPortEl: null,
    currentNodeId: '',
    cancelConnection: vi.fn(),
    clearNodeSelection: vi.fn(),
    scheduleEdgeDecorations: vi.fn(),
    syncGraphStats: vi.fn(),
    ...overrides
  }
}

function createFakeGraph (overrides = {}) {
  return {
    getNodes: vi.fn(() => []),
    getEdges: vi.fn(() => []),
    getCellById: vi.fn(() => null),
    getIncomingEdges: vi.fn(() => []),
    getOutgoingEdges: vi.fn(() => []),
    removeEdge: vi.fn(),
    addEdge: vi.fn(),
    findViewByCell: vi.fn(() => null),
    clientToLocal: vi.fn((x, y) => ({ x, y })),
    ...overrides
  }
}

function makeNode ({ id = 'n1', shape = 'RETRIEVER' } = {}) {
  return {
    id,
    shape,
    getPort: vi.fn(() => ({ group: 'out', args: { x: 264, y: 0 } })),
    getPortsByGroup: vi.fn(group => [{ id: `${id}-${group}-port` }]),
    getPosition: vi.fn(() => ({ x: 0, y: 0 }))
  }
}

function makeEdge ({ id = 'e1', sourceId = 'q1', targetId = 'r1', data } = {}) {
  return {
    id,
    getSourceCellId: () => sourceId,
    getTargetCellId: () => targetId,
    getSourcePortId: () => 'sp',
    getTargetPortId: () => 'tp',
    getData: () => data,
    setTarget: vi.fn()
  }
}

afterEach(() => {
  settleDeletion(false)
  vi.unstubAllGlobals()
})

describe('成环与去重的规则装配', () => {
  it('wouldCreateCycle：从 target 顺出边走回 source 即成环', () => {
    const a = makeEdge({ sourceId: 'a', targetId: 'b' })
    const b = makeEdge({ sourceId: 'b', targetId: 'c' })
    const ctx = createCtx({ graph: createFakeGraph({ getEdges: () => [a, b] }) })
    // a→b→c：a→c 会成环；c→a 不会
    // 语义：新增 c→a 会沿 a→b→c 回到 c（成环）；新增 a→c 则不会
    expect(methods.wouldCreateCycle.call(ctx, 'a', 'c')).toBe(false)
    expect(methods.wouldCreateCycle.call(ctx, 'c', 'a')).toBe(true)
  })

  it('wouldCreateCycleInEdges 直接透传内核算法；预览边可排除', () => {
    const preview = makeEdge({ id: 'p', sourceId: 'a', targetId: 'b', data: { preview: true } })
    const real = makeEdge({ sourceId: 'b', targetId: 'c' })
    const graph = createFakeGraph({ getEdges: () => [preview, real] })
    // b→c 已在边集里（不构成环）；再补 c→b 才成环
    expect(methods.wouldCreateCycleInEdges.call(createCtx({ graph }), [{ source: 'b', target: 'c' }], 'b', 'c')).toBe(false)
    expect(methods.wouldCreateCycleInEdges.call(createCtx({ graph }), [{ source: 'b', target: 'c' }], 'c', 'b')).toBe(true)
    // 内核 edgePairsOf 排除预览边
    expect(edgePairsOf(graph, { excludePreview: true })).toEqual([{ source: 'b', target: 'c' }])
  })
})

describe('handleCanvasKeydown：键盘连线/选中', () => {
  function keyEvent (key, target) {
    return {
      key,
      target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }
  }

  it('非 Enter/空格：直接返回', () => {
    const ctx = createCtx()
    const event = keyEvent('Tab', {})
    methods.handleCanvasKeydown.call(ctx, event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('Enter 在输出端口：进入点击连线；输入端口且有起点：接上', () => {
    const portEl = document.createElement('div')
    portEl.className = 'x6-port-body'
    portEl.setAttribute('port-group', 'out')
    portEl.setAttribute('port', 'p1')
    const cell = document.createElement('div')
    cell.className = 'x6-cell'
    cell.setAttribute('data-cell-id', 'n1')
    cell.appendChild(portEl)

    const node = makeNode({ id: 'n1' })
    const ctx = createCtx({
      graph: createFakeGraph({ getCellById: () => node }),
      beginClickConnection: vi.fn(),
      finishClickConnection: vi.fn()
    })
    methods.handleCanvasKeydown.call(ctx, keyEvent('Enter', portEl))
    expect(ctx.beginClickConnection).toHaveBeenCalledWith(node, 'p1')

    portEl.setAttribute('port-group', 'in')
    ctx.connectingSource = 'q1'
    methods.handleCanvasKeydown.call(ctx, keyEvent('Enter', portEl))
    expect(ctx.finishClickConnection).toHaveBeenCalledWith(node)
  })

  it('Enter 在边上：选中该边并阻止默认行为', () => {
    const edgeEl = document.createElement('div')
    edgeEl.className = 'x6-edge'
    edgeEl.setAttribute('data-cell-id', 'e1')
    const edge = makeEdge({ data: {} })
    const ctx = createCtx({
      graph: createFakeGraph({ getCellById: () => edge }),
      selectEdge: vi.fn()
    })
    const event = keyEvent('Enter', edgeEl)
    methods.handleCanvasKeydown.call(ctx, event)
    expect(ctx.selectEdge).toHaveBeenCalledWith(edge)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()

    // 预览边不可选中
    const preview = makeEdge({ data: { preview: true } })
    ctx.graph.getCellById = () => preview
    const event2 = keyEvent('Enter', edgeEl)
    methods.handleCanvasKeydown.call(ctx, event2)
    expect(ctx.selectEdge).toHaveBeenCalledTimes(1)

    // 端口缺失的节点：返回
    const portEl = document.createElement('div')
    portEl.className = 'x6-port-body'
    portEl.setAttribute('port-group', 'out')
    portEl.setAttribute('port', 'p9')
    cellOf(portEl, 'ghost')
    ctx.graph.getCellById = () => null
    const event3 = keyEvent('Enter', portEl)
    expect(() => methods.handleCanvasKeydown.call(ctx, event3)).not.toThrow()
    expect(event3.preventDefault).toHaveBeenCalled()
  })

  function event () {
    return { preventDefault: vi.fn() }
  }

  function cellOf (portEl, id) {
    const cell = document.createElement('div')
    cell.className = 'x6-cell'
    cell.setAttribute('data-cell-id', id)
    cell.appendChild(portEl)
    document.body.appendChild(cell)
    return cell
  }
})

describe('selectEdge / removeSelectedEdge：连线选中与删除', () => {
  it('selectEdge：记下两端显示名并刷新装饰', () => {
    const ctx = createCtx({
      graph: createFakeGraph(),
      nodeDisplayName: id => `名-${id}`
    })
    methods.selectEdge.call(ctx, makeEdge({ id: 'e1' }))
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.selectedEdge).toEqual({ id: 'e1', sourceLabel: '名-q1', targetLabel: '名-r1' })
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })

  it('removeSelectedEdge：未选中直接返回；确认后删边；取消则保留选中', async () => {
    const ctx = createCtx({ graph: createFakeGraph({ removeEdge: vi.fn() }) })
    await methods.removeSelectedEdge.call(ctx)
    expect(ctx.graph.removeEdge).not.toHaveBeenCalled()

    ctx.selectedEdge = { id: 'e1', sourceLabel: 'a', targetLabel: 'b' }
    const pending = methods.removeSelectedEdge.call(ctx)
    await Promise.resolve()
    settleDeletion(false)
    await pending
    expect(ctx.selectedEdge).toEqual({ id: 'e1', sourceLabel: 'a', targetLabel: 'b' })
    expect(ctx.graph.removeEdge).not.toHaveBeenCalled()

    const pending2 = methods.removeSelectedEdge.call(ctx)
    await Promise.resolve()
    settleDeletion(true)
    await pending2
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.graph.removeEdge).toHaveBeenCalledWith('e1')
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })
})

describe('节点选中态', () => {
  it('selectNodeView：先清后选；clearNodeSelection 遍历所有节点', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    const a = makeNode({ id: 'a' })
    const b = makeNode({ id: 'b' })
    const graph = createFakeGraph({
      getNodes: () => [a, b],
      getCellById: id => ({ a, b }[id]),
      findViewByCell: node => ({ container: node.id === 'a' ? containerA : containerB })
    })
    const ctx = createCtx({ graph })
    methods.selectNodeView.call(ctx, 'a')
    expect(containerA.classList.contains('selected')).toBe(true)
    expect(containerB.classList.contains('selected')).toBe(false)

    methods.clearNodeSelection.call(ctx)
    expect(containerA.classList.contains('selected')).toBe(false)
    expect(containerB.classList.contains('selected')).toBe(false)

    // 无视图/无节点不抛错
    ctx.graph.findViewByCell = () => null
    expect(() => methods.selectNodeView.call(ctx, 'a')).not.toThrow()
    expect(() => methods.clearNodeSelection.call(createCtx())).not.toThrow()
  })
})

describe('Esc 与预览边', () => {
  it('handleConnectionKey：连线中 Esc 取消；选中边时 Esc 只清选中', () => {
    const ctx = createCtx({ connectingSource: 'q1', cancelConnection: vi.fn() })
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    methods.handleConnectionKey.call(ctx, event)
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()

    const ctx2 = createCtx({ selectedEdge: { id: 'e1' } })
    const event2 = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
    methods.handleConnectionKey.call(ctx2, event2)
    expect(ctx2.selectedEdge).toBeNull()
    expect(ctx2.scheduleEdgeDecorations).toHaveBeenCalled()

    // 非 Esc / 什么都没有：不动
    const ctx3 = createCtx()
    methods.handleConnectionKey.call(ctx3, { key: 'Enter' })
    expect(ctx3.selectedEdge).toBeNull()
  })

  it('beginClickConnection：挂一条虚线预览边并进入连线模式', () => {
    const node = makeNode({ id: 'q1' })
    const graph = createFakeGraph()
    const ctx = createCtx({ graph, nodeDisplayName: vi.fn(id => `名-${id}`) })
    methods.beginClickConnection.call(ctx, node, 'q1-out-port')
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.selectedEdge).toBeNull()
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(ctx.connectingSource).toBe('q1')
    expect(ctx.connectingSourceLabel).toBe('名-q1')
    expect(ctx.connectingPortId).toBe('q1-out-port')
    expect(graph.addEdge).toHaveBeenCalledTimes(1)
    const edge = graph.addEdge.mock.calls[0][0]
    expect(edge.getData().preview).toBe(true)
    expect(ctx.previewEdgeId).toBe(edge.id)
    expect(ctx.scheduleEdgeDecorations).toHaveBeenCalled()
  })

  it('updateClickConnection：悬停可连的输入端口时高亮并记目标', () => {
    const preview = makeEdge({ id: 'preview-1', data: { preview: true } })
    const graph = createFakeGraph({ getCellById: () => preview })
    const portEl = document.createElement('div')
    portEl.className = 'x6-port-body'
    portEl.setAttribute('port-group', 'in')
    const cellEl = document.createElement('div')
    cellEl.className = 'x6-cell'
    cellEl.setAttribute('data-cell-id', 't1')
    cellEl.appendChild(portEl)
    document.body.appendChild(cellEl)
    vi.stubGlobal('document', document)
    const originalElementFromPoint = document.elementFromPoint
    document.elementFromPoint = () => portEl

    const ctx = createCtx({
      graph,
      connectingSource: 'q1',
      previewEdgeId: 'preview-1',
      wouldCreateCycle: vi.fn(() => false),
      nodeDisplayName: id => `名-${id}`
    })
    ctx.connectionTargetId = ''
    methods.updateClickConnection.call(ctx, { clientX: 10, clientY: 20 })
    expect(preview.setTarget).toHaveBeenCalledWith({ x: 10, y: 20 })
    expect(ctx.hoveredPortEl).toBe(portEl)
    expect(portEl.classList.contains('is-target')).toBe(true)
    expect(ctx.connectionTargetId).toBe('t1')
    document.elementFromPoint = originalElementFromPoint
  })

  it('updateClickConnection：没有连线中/没有预览边/边已消失：直接返回', () => {
    const ctx = createCtx()
    methods.updateClickConnection.call(ctx, { clientX: 0, clientY: 0 })
    ctx.previewEdgeId = 'p'
    ctx.connectingSource = 'q1'
    ctx.graph = createFakeGraph({ getCellById: () => null })
    methods.updateClickConnection.call(ctx, { clientX: 0, clientY: 0 })
    expect(ctx.connectionTargetId).toBe('')
  })

  it('updateClickConnection：目标不可连（成环/自己/非输入端口）时不高亮', () => {
    const preview = makeEdge({ id: 'preview-2', data: { preview: true } })
    const portEl = document.createElement('div')
    portEl.className = 'x6-port-body'
    portEl.setAttribute('port-group', 'out')
    const cellEl = document.createElement('div')
    cellEl.className = 'x6-cell'
    cellEl.setAttribute('data-cell-id', 'q1')
    cellEl.appendChild(portEl)
    document.body.appendChild(cellEl)
    const originalElementFromPoint = document.elementFromPoint
    document.elementFromPoint = () => portEl

    const ctx = createCtx({
      graph: createFakeGraph({ getCellById: () => preview }),
      connectingSource: 'q1',
      previewEdgeId: 'preview-2'
    })
    ctx.hoveredPortEl = portEl // 模拟上一次悬停
    methods.updateClickConnection.call(ctx, { clientX: 1, clientY: 1 })
    expect(portEl.classList.contains('is-target')).toBe(false)
    expect(ctx.hoveredPortEl).toBeNull()
    expect(ctx.connectionTargetId).toBe('')
    document.elementFromPoint = originalElementFromPoint
  })

  it('clearHoveredPort：摘掉高亮并清目标', () => {
    const portEl = document.createElement('div')
    portEl.classList.add('is-target')
    const ctx = createCtx({ hoveredPortEl: portEl, connectionTargetId: 't1' })
    methods.clearHoveredPort.call(ctx)
    expect(portEl.classList.contains('is-target')).toBe(false)
    expect(ctx.hoveredPortEl).toBeNull()
    expect(ctx.connectionTargetId).toBe('')
    // 没有悬停元素也安全
    methods.clearHoveredPort.call(createCtx())
  })

  it('finishClickConnection：缺端口/自连/成环取消；成功建边并提示', () => {
    // 缺目标输入端口
    const badTarget = makeNode({ id: 't' })
    badTarget.getPortsByGroup = vi.fn(() => [])
    const ctx = createCtx({
      connectingSource: 'q1',
      connectingPortId: 'q-out',
      cancelConnection: vi.fn()
    })
    methods.finishClickConnection.call(ctx, badTarget)
    expect(ctx.cancelConnection).toHaveBeenCalled()
    expect(ctx.$message.warning).not.toHaveBeenCalled()

    // 自连：警告 + 取消
    const self = makeNode({ id: 'q1' })
    const ctx2 = createCtx({
      connectingSource: 'q1',
      connectingPortId: 'q-out',
      cancelConnection: vi.fn()
    })
    methods.finishClickConnection.call(ctx2, self)
    expect(ctx2.$message.warning).toHaveBeenCalledWith('modules.workflow.connectionCycle')
    expect(ctx2.cancelConnection).toHaveBeenCalled()

    // 已有同向边：不重复建，也不提示成功
    const target = makeNode({ id: 't' })
    const graph = createFakeGraph({
      getEdges: () => [makeEdge({ sourceId: 'q1', targetId: 't' })]
    })
    const ctx3 = createCtx({
      graph,
      connectingSource: 'q1',
      connectingPortId: 'q-out',
      cancelConnection: vi.fn()
    })
    methods.finishClickConnection.call(ctx3, target)
    expect(graph.addEdge).not.toHaveBeenCalled()
    expect(ctx3.$message.success).not.toHaveBeenCalled()
    expect(ctx3.cancelConnection).toHaveBeenCalled()
    expect(ctx3.syncGraphStats).toHaveBeenCalled()

    // 成功：建边 + 成功提示
    graph.getEdges = vi.fn(() => [])
    methods.finishClickConnection.call(ctx3, target)
    expect(graph.addEdge).toHaveBeenCalledWith(expect.objectContaining({
      source: { cell: 'q1', port: 'q-out' },
      target: { cell: 't', port: 't-in-port' }
    }))
    expect(ctx3.$message.success).toHaveBeenCalledWith('modules.workflow.connectionCreated')
  })

  it('cancelConnection：清悬停/删预览边/复位状态；抽屉开着时不清节点选中', () => {
    const preview = makeEdge({ id: 'preview-3' })
    const graph = createFakeGraph({ getCellById: () => preview, removeEdge: vi.fn() })
    const ctx = createCtx({
      graph,
      previewEdgeId: 'preview-3',
      connectingSource: 'q1',
      connectingSourceLabel: '名-q1',
      connectingPortId: 'p',
      connectionTargetId: 't',
      clearNodeSelection: vi.fn(),
      currentNodeId: 'drawer-node'
    })
    methods.cancelConnection.call(ctx)
    expect(graph.removeEdge).toHaveBeenCalledWith(preview)
    expect(ctx.previewEdgeId).toBe('')
    expect(ctx.connectingSource).toBe('')
    expect(ctx.connectingPortId).toBe('')
    expect(ctx.connectionTargetId).toBe('')
    expect(ctx.clearNodeSelection).not.toHaveBeenCalled() // 抽屉开着不清

    // 没开抽屉：清节点选中；预览边已消失也不抛错
    ctx.currentNodeId = ''
    graph.getCellById = vi.fn(() => null)
    methods.cancelConnection.call(ctx)
    expect(ctx.clearNodeSelection).toHaveBeenCalled()
    expect(methods.cancelConnection.call(createCtx())).toBeUndefined()
  })
})
