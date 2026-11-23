// @vitest-environment jsdom
/**
 * useGraphEdgeCrud —— 边的选中气泡、查看/编辑抽屉与删除（边 CRUD）。
 *
 * mock 掉 updateEdgeApi / deleteEdgeApi 后逐方法钉行为：
 * - 单击边延迟弹气泡（与实体气泡互斥）并高亮两端节点；双击直接进编辑；
 * - 编辑表单从 selectedEdge 深拷贝（改表单不污染原数据）；
 * - 更新成功：本地缓存/画布增量更新 + emit refresh-graph-data（画布 updateEdge 可用时）；
 *   画布不可用或找不到本地边 → 回源刷新兜底；失败/异常 → 回源刷新 + 错误提示。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'

import { createTestI18n } from './helpers/mount'

const { updateEdgeApiMock, deleteEdgeApiMock } = vi.hoisted(() => ({
  updateEdgeApiMock: vi.fn(),
  deleteEdgeApiMock: vi.fn()
}))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  updateEdgeApi: updateEdgeApiMock,
  deleteEdgeApi: deleteEdgeApiMock
}))

import { CLICK_DELAY_MS } from '@/features/graph/lib/graph-geometry'
import { useGraphEdgeCrud } from '@/features/graph/composables/useGraphEdgeCrud'

function makeCtx (overrides = {}) {
  const i18n = createTestI18n()
  const t = i18n.global.t
  const proxy = {
    $t: t,
    $message: { success: vi.fn(), error: vi.fn() }
  }
  const selection = reactive({
    selectedEdge: null,
    closeActionPopover: vi.fn(),
    toContainerPosition: (pos) => ({ x: (pos?.x ?? 0) - 10, y: (pos?.y ?? 0) - 10 })
  })
  const ctx = {
    props: {
      schemaMapping: { adjacency_map: {} },
      graphData: { entities: [], edges: [] }
    },
    route: { params: { id: 'kb-1' } },
    proxy,
    emit: vi.fn(),
    selection,
    graphDataCache: ref({ entities: [], edges: [] }),
    graphCanvasRef: ref({}),
    openExclusiveDrawer: vi.fn(),
    requestServerRefresh: vi.fn(),
    getKnowledgeBaseId: () => 'kb-1',
    ...overrides
  }
  return { ctx, edge: useGraphEdgeCrud(ctx) }
}

const EDGE = {
  edge_id: 'r1',
  edge_type: 'Relates',
  rid: '#10:1',
  source_id: 'a',
  target_id: 'b',
  in: 'inR',
  out: 'outR',
  properties: { weight: 1 }
}

describe('useGraphEdgeCrud', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    updateEdgeApiMock.mockReset()
    deleteEdgeApiMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('getEdgePropertyDef（边属性定义查找）', () => {
    it('从 schemaMapping.adjacency_map 查边类型的属性定义', () => {
      const { ctx, edge } = makeCtx({
        props: {
          schemaMapping: {
            adjacency_map: {
              A: { B: [{ edge_type: 'Relates', properties: [{ name: 'weight', type: 'BOOLEAN' }] }] }
            }
          },
          graphData: { entities: [], edges: [] }
        }
      })

      expect(edge.getEdgePropertyDef('Relates', 'weight')).toEqual({ name: 'weight', type: 'BOOLEAN' })
      expect(edge.getEdgePropertyDef('Relates', 'missing')).toBeNull()
      expect(edge.getEdgePropertyDef('', 'weight')).toBeNull()
    })
  })

  describe('handleCanvasEdgeClick（画布单击边）', () => {
    it('延迟 CLICK_DELAY_MS 弹气泡，收实体气泡并高亮两端节点', () => {
      const graphCanvasRef = ref({ selectNodes: vi.fn() })
      const { edge } = makeCtx({ graphCanvasRef })

      edge.handleCanvasEdgeClick(EDGE, { x: 110, y: 60 })

      expect(edge.selectedEdge).toEqual(EDGE)
      expect(edge.edgeActionPopoverPosition).toEqual({ x: 100, y: 50 })
      expect(edge.edgeActionPopoverVisible).toBe(false)

      vi.advanceTimersByTime(CLICK_DELAY_MS)

      expect(edge.edgeActionPopoverVisible).toBe(true)
      expect(graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['a', 'b'])
    })

    it('双击边：取消待弹气泡、深拷贝表单、直接开边编辑抽屉', () => {
      const { ctx, edge } = makeCtx()

      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      vi.advanceTimersByTime(CLICK_DELAY_MS + 50)

      expect(edge.edgeActionPopoverVisible).toBe(false)
      expect(edge.editForm).toEqual({
        edge_id: 'r1',
        class: 'Relates',
        rid: '#10:1',
        source_id: 'a',
        target_id: 'b',
        in: 'inR',
        out: 'outR',
        properties: { weight: 1 }
      })
      expect(ctx.openExclusiveDrawer).toHaveBeenCalledWith('edgeEdit')
    })

    it('双击空边（点空白）是空操作', () => {
      const { ctx, edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(null)
      expect(ctx.openExclusiveDrawer).not.toHaveBeenCalled()
    })

    it('编辑表单是深拷贝：改表单属性不影响 selectedEdge', () => {
      const { edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(EDGE)

      edge.editForm.properties.weight = 999
      expect(edge.selectedEdge.properties.weight).toBe(1)
    })
  })

  describe('handleEditEdge（气泡「编辑」）与抽屉开关', () => {
    it('无选中边时只关气泡；有选中边时填表单并开编辑抽屉', () => {
      const { ctx, edge } = makeCtx()

      edge.handleEditEdge()
      expect(ctx.openExclusiveDrawer).not.toHaveBeenCalled()

      edge.handleCanvasEdgeClick(EDGE, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS)
      edge.handleEditEdge()

      expect(edge.editForm.edge_id).toBe('r1')
      expect(edge.editForm.class).toBe('Relates')
      expect(ctx.openExclusiveDrawer).toHaveBeenCalledWith('edgeEdit')
      expect(edge.edgeActionPopoverVisible).toBe(false)
    })

    it('handleEdgeDoubleClickFromCanvas 里缺 rid/in/out 字段时落空串，source/target 支持旧字段名', () => {
      const { edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas({ id: 'r2', class: 'Owns', source: 'x', target: 'y' })

      expect(edge.editForm).toEqual(expect.objectContaining({
        edge_id: 'r2',
        class: 'Owns',
        source_id: 'x',
        target_id: 'y'
      }))
    })

    it('handleCloseEdgeDrawer / handleCancelEditEdge 各自关闭对应抽屉', () => {
      const { edge } = makeCtx()
      edge.viewDrawerVisible = true
      edge.editDrawerVisible = true

      edge.handleCloseEdgeDrawer()
      expect(edge.viewDrawerVisible).toBe(false)

      edge.handleCancelEditEdge()
      expect(edge.editDrawerVisible).toBe(false)
    })

    it('closeEdgeActionPopover / clearEdgeClickTimer 是独立的收尾动作', () => {
      const { edge } = makeCtx()
      edge.handleCanvasEdgeClick(EDGE, { x: 0, y: 0 })
      edge.clearEdgeClickTimer()
      vi.advanceTimersByTime(CLICK_DELAY_MS + 50)
      expect(edge.edgeActionPopoverVisible).toBe(false)

      edge.handleCanvasEdgeClick(EDGE, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS)
      edge.closeEdgeActionPopover()
      expect(edge.edgeActionPopoverVisible).toBe(false)
    })
  })

  describe('handleConfirmEditEdge（编辑抽屉确定 → updateEdgeApi）', () => {
    it('无选中边时打日志并返回，不调 API', async () => {
      const { ctx, edge } = makeCtx()
      const errSpy = vi.spyOn(console, 'error')

      await edge.handleConfirmEditEdge()

      expect(updateEdgeApiMock).not.toHaveBeenCalled()
      expect(errSpy).toHaveBeenCalled()
    })

    it('成功且画布可用：更新本地缓存/画布，发增量刷新事件，关编辑抽屉', async () => {
      const graphCanvasRef = ref({ updateEdge: vi.fn() })
      const { ctx, edge } = makeCtx({ graphCanvasRef })
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      const cacheEdge = { ...EDGE }
      ctx.props.graphData.edges.push(cacheEdge)
      ctx.graphDataCache.value.edges.push({ ...EDGE })

      updateEdgeApiMock.mockResolvedValue({ success: true })
      edge.editForm.properties.weight = 3
      await edge.handleConfirmEditEdge()

      expect(updateEdgeApiMock).toHaveBeenCalledWith('kb-1', 'r1', 'Relates', { weight: 3 })
      expect(cacheEdge.properties).toEqual({ weight: 3 })
      expect(graphCanvasRef.value.updateEdge).toHaveBeenCalledTimes(1)
      expect(ctx.emit).toHaveBeenCalledWith('refresh-graph-data', {
        incremental: true,
        updatedEdges: [expect.objectContaining({ properties: { weight: 3 } })]
      })
      expect(edge.editDrawerVisible).toBe(false)
    })

    it('画布不可用（updateEdge 缺失）：走全量事件 + 回源刷新兜底', async () => {
      const { ctx, edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      ctx.props.graphData.edges.push({ ...EDGE })

      updateEdgeApiMock.mockResolvedValue({ success: true })
      await edge.handleConfirmEditEdge()

      expect(ctx.emit).toHaveBeenCalledWith('refresh-graph-data', expect.objectContaining({
        entities: ctx.props.graphData.entities,
        edges: ctx.props.graphData.edges,
        edgeName: 'r1'
      }))
      expect(ctx.requestServerRefresh).toHaveBeenCalledTimes(1)
      expect(edge.editDrawerVisible).toBe(false)
    })

    it('成功但本地缓存里找不到这条边：同样走全量兜底', async () => {
      const graphCanvasRef = ref({ updateEdge: vi.fn() })
      const { ctx, edge } = makeCtx({ graphCanvasRef })
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      // graphData.edges 为空 → find 不到 edge → updatedEdge 为 null → else 分支

      updateEdgeApiMock.mockResolvedValue({ success: true })
      await edge.handleConfirmEditEdge()

      expect(graphCanvasRef.value.updateEdge).not.toHaveBeenCalled()
      expect(ctx.emit).toHaveBeenCalledWith('refresh-graph-data', expect.objectContaining({ edgeName: 'r1' }))
    })

    it('失败响应：错误提示 + 回源刷新，抽屉不关', async () => {
      const { ctx, edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      updateEdgeApiMock.mockResolvedValue({ success: false, message: '并发冲突' })

      await edge.handleConfirmEditEdge()

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('并发冲突')
      expect(ctx.requestServerRefresh).toHaveBeenCalledTimes(1)
      expect(edge.editDrawerVisible).toBe(false)
    })

    it('失败响应缺 message 时兜底「关系更新失败」', async () => {
      const { ctx, edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      updateEdgeApiMock.mockResolvedValue({ success: false })

      await edge.handleConfirmEditEdge()

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('关系更新失败')
    })

    it('拿不到知识库 ID：提示 cannotGetKbId，不调 API', async () => {
      const { ctx, edge } = makeCtx({ getKnowledgeBaseId: () => null, route: { params: {} } })
      edge.handleEdgeDoubleClickFromCanvas(EDGE)

      await edge.handleConfirmEditEdge()

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('无法获取知识库ID')
      expect(updateEdgeApiMock).not.toHaveBeenCalled()
    })

    it('API 抛异常：只留日志 + 回源刷新（axios 拦截器已提示过，避免双 toast）', async () => {
      const { ctx, edge } = makeCtx()
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      updateEdgeApiMock.mockRejectedValue(new Error('network down'))

      await edge.handleConfirmEditEdge()

      expect(ctx.proxy.$message.error).not.toHaveBeenCalled()
      expect(ctx.requestServerRefresh).toHaveBeenCalledTimes(1)
    })
  })

  describe('handleDeleteEdge（删除边 → deleteEdgeApi）', () => {
    it('确认弹窗取消时直接返回', async () => {
      const { ctx, edge } = makeCtx()
      proxyConfirm(ctx, () => Promise.reject(new Error('cancel')))
      edge.handleCanvasEdgeClick(EDGE, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS)

      await edge.handleDeleteEdge()

      expect(deleteEdgeApiMock).not.toHaveBeenCalled()
    })

    it('确认后删除成功：关气泡 + 带 deletedEdgeId 回源刷新', async () => {
      const { ctx, edge } = makeCtx()
      proxyConfirm(ctx, () => Promise.resolve())
      deleteEdgeApiMock.mockResolvedValue({ success: true })
      edge.handleCanvasEdgeClick(EDGE, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS)

      await edge.handleDeleteEdge()

      expect(deleteEdgeApiMock).toHaveBeenCalledWith('kb-1', 'r1', 'Relates')
      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({ deletedEdgeId: 'r1' })
      expect(edge.edgeActionPopoverVisible).toBe(false)
    })

    it('失败响应：错误提示（缺 message 兜底「关系删除失败」），不回源刷新', async () => {
      const { ctx, edge } = makeCtx()
      proxyConfirm(ctx, () => Promise.resolve())
      deleteEdgeApiMock.mockResolvedValue({ success: false })
      edge.handleEdgeDoubleClickFromCanvas(EDGE)

      await edge.handleDeleteEdge()

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('关系删除失败')
      expect(ctx.requestServerRefresh).not.toHaveBeenCalled()
    })

    it('API 抛异常：只留日志，不重复提示', async () => {
      const { ctx, edge } = makeCtx()
      proxyConfirm(ctx, () => Promise.resolve())
      deleteEdgeApiMock.mockRejectedValue(new Error('boom'))
      edge.handleEdgeDoubleClickFromCanvas(EDGE)
      const errSpy = vi.spyOn(console, 'error')

      await edge.handleDeleteEdge()

      expect(errSpy).toHaveBeenCalled()
      expect(ctx.proxy.$message.error).not.toHaveBeenCalled()
    })

    it('确认后拿不到知识库 ID：不调 API', async () => {
      const { ctx, edge } = makeCtx({ getKnowledgeBaseId: () => null })
      proxyConfirm(ctx, () => Promise.resolve())
      edge.handleEdgeDoubleClickFromCanvas(EDGE)

      await edge.handleDeleteEdge()

      expect(deleteEdgeApiMock).not.toHaveBeenCalled()
    })

    it('没选中边时是空操作', async () => {
      const { edge } = makeCtx()
      await edge.handleDeleteEdge()
      expect(deleteEdgeApiMock).not.toHaveBeenCalled()
    })
  })
})

/** 给 ctx.proxy 换一个可控的 $confirm 实现（删除前的确认弹窗） */
function proxyConfirm (ctx, impl) {
  ctx.proxy.$confirm = vi.fn(impl)
}
