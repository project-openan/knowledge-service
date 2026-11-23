// @vitest-environment jsdom
/**
 * useGraphRelationDrawer —— 「添加关系」抽屉与画布连线模式。
 *
 * 三个入口共用一套打开逻辑：
 * - 摘要行 / 节点气泡：openRelationDrawer（node 为空时抽屉内自选起点）；
 * - 节点气泡「添加关系」：handleAddEdge（必须已选中实体）；
 * - 画布连线模式：点起点 → 点可连接终点 → openAddEdgeDrawer 两端预填。
 * 打开抽屉时先收其它抽屉（同一时间只留一个），保存走 createEdgeApi 真实调用链（mock）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'

import { createTestI18n } from './helpers/mount'

const { createEdgeApiMock } = vi.hoisted(() => ({ createEdgeApiMock: vi.fn() }))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  createEdgeApi: createEdgeApiMock
}))

import { useGraphRelationDrawer } from '@/features/graph/composables/useGraphRelationDrawer'

function makeCtx () {
  const i18n = createTestI18n()
  const t = i18n.global.t
  const proxy = {
    $t: t,
    $message: { success: vi.fn(), error: vi.fn() }
  }
  const selection = reactive({
    selectedEntity: null,
    closeActionPopover: vi.fn()
  })
  const ctx = {
    proxy,
    t,
    selection,
    entity: { editDrawerVisible: false },
    edgeCrud: { viewDrawerVisible: false, editDrawerVisible: false },
    getKnowledgeBaseId: () => 'kb-1',
    requestServerRefresh: vi.fn()
  }
  return { ctx, relation: useGraphRelationDrawer(ctx) }
}

const RELATION_PAYLOAD = {
  edgeId: 'r9',
  edgeType: 'Relates',
  properties: { weight: 1 },
  sourceId: 'a',
  targetId: 'b'
}

describe('useGraphRelationDrawer', () => {
  beforeEach(() => {
    createEdgeApiMock.mockReset()
  })

  describe('openRelationDrawer（摘要行 / 气泡入口）', () => {
    it('打开抽屉：预填起点、清空终点、收其它抽屉与气泡', () => {
      const { ctx, relation } = makeCtx()
      ctx.entity.editDrawerVisible = true
      ctx.edgeCrud.viewDrawerVisible = true
      ctx.edgeCrud.editDrawerVisible = true

      relation.openRelationDrawer({ entity_id: 'a' })

      expect(relation.drawerVisible).toBe(true)
      expect(relation.sourceId).toBe('a')
      expect(relation.targetId).toBe('')
      expect(ctx.entity.editDrawerVisible).toBe(false)
      expect(ctx.edgeCrud.viewDrawerVisible).toBe(false)
      expect(ctx.edgeCrud.editDrawerVisible).toBe(false)
      expect(ctx.selection.closeActionPopover).toHaveBeenCalledTimes(1)
    })

    it('不传 node 时以当前选中实体为起点（默认参数）', () => {
      const { ctx, relation } = makeCtx()
      ctx.selection.selectedEntity = { entity_id: 'sel-1' }

      relation.openRelationDrawer()

      expect(relation.sourceId).toBe('sel-1')
    })

    it('node 缺 entity_id 时回退 id；完全没 id 时起点为空串', () => {
      const { relation } = makeCtx()
      relation.openRelationDrawer({ id: 'legacy' })
      expect(relation.sourceId).toBe('legacy')

      relation.openRelationDrawer(null)
      expect(relation.sourceId).toBe('')
    })

    it('handleAddEdge：没有选中实体时直接返回，不开抽屉', () => {
      const { relation } = makeCtx()
      relation.handleAddEdge()
      expect(relation.drawerVisible).toBe(false)
    })

    it('handleAddEdge：以选中实体为起点打开抽屉', () => {
      const { ctx, relation } = makeCtx()
      ctx.selection.selectedEntity = { entity_id: 'sel-2' }

      relation.handleAddEdge()

      expect(relation.drawerVisible).toBe(true)
      expect(relation.sourceId).toBe('sel-2')
    })
  })

  describe('画布连线模式（点起点再点终点）', () => {
    // 注：连线模式的起终点节点（sourceNodeForEdge 等）是 composable 内部 ref，
    // 不在返回的 store 上 —— 画布进入连线模式后由内部置位。这里只测 store 暴露面。

    it('openAddEdgeDrawer：缺起点或终点时是空操作', () => {
      const { relation } = makeCtx()

      relation.openAddEdgeDrawer()
      expect(relation.drawerVisible).toBe(false)
    })

    it('连线下点节点：起点未设 / 节点不可连接时都不开抽屉', () => {
      const { relation } = makeCtx()
      relation.isAddingEdgeMode = true

      relation.handleNodeClickInEdgeMode({ id: 'a', data: { entity_id: 'a' } })
      expect(relation.drawerVisible).toBe(false)

      relation.handleNodeClickInEdgeMode({ id: 'zzz', data: { entity_id: 'zzz' } })
      expect(relation.drawerVisible).toBe(false)
    })

    it('exitAddingEdgeMode：退出连线模式并复位可连接列表', () => {
      const { relation } = makeCtx()
      relation.isAddingEdgeMode = true

      relation.exitAddingEdgeMode()

      expect(relation.isAddingEdgeMode).toBe(false)
      expect(relation.drawerVisible).toBe(false)
    })
  })

  describe('handleRelationSave（抽屉保存 → createEdgeApi）', () => {
    it('成功：提示、关抽屉、带 ensureEdges 回源刷新', async () => {
      const { ctx, relation } = makeCtx()
      createEdgeApiMock.mockResolvedValue({ success: true })

      await relation.handleRelationSave(RELATION_PAYLOAD)

      expect(createEdgeApiMock).toHaveBeenCalledWith('kb-1', 'r9', 'Relates', { weight: 1 }, 'a', 'b')
      expect(ctx.proxy.$message.success).toHaveBeenCalledWith('关系创建成功')
      expect(relation.drawerVisible).toBe(false)
      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({
        ensureEdges: [{
          edge_id: 'r9',
          edge_type: 'Relates',
          source_id: 'a',
          target_id: 'b',
          properties: { weight: 1 }
        }]
      })
      expect(relation.saving).toBe(false)
    })

    it('失败响应：只报错，抽屉留着（已填内容不丢），也不回源刷新', async () => {
      const { ctx, relation } = makeCtx()
      createEdgeApiMock.mockResolvedValue({ success: false, message: '拓扑校验失败' })
      relation.openRelationDrawer({ entity_id: 'a' })

      await relation.handleRelationSave(RELATION_PAYLOAD)

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('拓扑校验失败')
      expect(relation.drawerVisible).toBe(true)
      expect(ctx.requestServerRefresh).not.toHaveBeenCalled()
      expect(relation.saving).toBe(false)
    })

    it('请求异常：带上原始错误信息的错误提示', async () => {
      const { ctx, relation } = makeCtx()
      createEdgeApiMock.mockRejectedValue(new Error('boom'))

      await relation.handleRelationSave(RELATION_PAYLOAD)

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('关系创建失败：boom')
      expect(relation.saving).toBe(false)
    })

    it('异常没有 message 时兜底「网络错误」文案', async () => {
      const { ctx, relation } = makeCtx()
      createEdgeApiMock.mockRejectedValue({})

      await relation.handleRelationSave(RELATION_PAYLOAD)

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('关系创建失败：网络错误')
    })

    it('保存中重复提交被忽略（saving 防抖）', async () => {
      const { relation } = makeCtx()
      let resolveApi
      createEdgeApiMock.mockReturnValue(new Promise((resolve) => { resolveApi = resolve }))

      const first = relation.handleRelationSave(RELATION_PAYLOAD)
      const second = relation.handleRelationSave(RELATION_PAYLOAD)
      resolveApi({ success: true })
      await Promise.all([first, second])

      expect(createEdgeApiMock).toHaveBeenCalledTimes(1)
    })

    it('空 payload 直接返回；没有知识库 ID 时连 API 都不调', async () => {
      const { ctx, relation } = makeCtx()

      await relation.handleRelationSave(null)
      expect(createEdgeApiMock).not.toHaveBeenCalled()

      ctx.getKnowledgeBaseId = () => null
      await relation.handleRelationSave(RELATION_PAYLOAD)
      expect(createEdgeApiMock).not.toHaveBeenCalled()
      expect(relation.saving).toBe(false)
    })
  })
})
