// @vitest-environment jsdom
/**
 * useGraphEntityCrud —— 实体编辑/新增/删除抽屉的全部逻辑（API 全 mock）。
 *
 * 钉四条线：
 * - 派生数据：选中实体的类型信息 / 属性定义（含大小写不敏感回退）/ 关联关系列表；
 * - 编辑：updateEntityApi 成功 → 本地缓存 + 画布增量更新；失败 → 抽屉保留 + 回源刷新；
 * - 新增：createEntityApi 失败时抽屉与已填内容保留；成功先增量落画布（含连带关系），
 *   再带 ensureEntity/ensureEdges 回源刷新，超 limit 时先抬高 limit；
 * - 删除：确认取消返回；成功带 deletedEntityId 回源刷新。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'

import { createTestI18n } from './helpers/mount'

const { updateEntityApiMock, deleteEntityApiMock, createEntityApiMock } = vi.hoisted(() => ({
  updateEntityApiMock: vi.fn(),
  deleteEntityApiMock: vi.fn(),
  createEntityApiMock: vi.fn()
}))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  updateEntityApi: updateEntityApiMock,
  deleteEntityApi: deleteEntityApiMock,
  createEntityApi: createEntityApiMock
}))

import { useGraphEntityCrud } from '@/features/graph/composables/useGraphEntityCrud'

function makeCtx (overrides = {}) {
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
    props: {
      schemaMapping: { entity_meta: {}, adjacency_map: {} },
      graphData: { entities: [], edges: [] }
    },
    proxy,
    emit: vi.fn(),
    t,
    selection,
    graphDataCache: ref({ entities: [], edges: [] }),
    graphCanvasRef: ref({}),
    operationQueue: ref([]),
    isBatchProcessing: ref(false),
    OperationType: { ADD_ENTITY: 'addEntity', ADD_EDGE: 'addEdge' },
    getKnowledgeBaseId: () => 'kb-1',
    tones: { typeToneMap: {} },
    requestServerRefresh: vi.fn(),
    stopGraphLoading: vi.fn(),
    bumpLimitFromLocalEntityCount: vi.fn(),
    ...overrides
  }
  return { ctx, entity: useGraphEntityCrud(ctx) }
}

describe('useGraphEntityCrud', () => {
  beforeEach(() => {
    updateEntityApiMock.mockReset()
    deleteEntityApiMock.mockReset()
    createEntityApiMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('派生数据（抽屉渲染所需）', () => {
    it('selectedEntityTypeInfo：类型名缺省时落「实体类型」，tone 缺省时落 blue', () => {
      const { ctx, entity } = makeCtx()

      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'Scene' }
      expect(entity.selectedEntityTypeInfo).toEqual({ name: 'Scene', tone: 'blue' })

      ctx.selection.selectedEntity = { entity_id: 'e2' }
      expect(entity.selectedEntityTypeInfo.name).toBe('实体类型')
      expect(entity.selectedEntityTypeInfo.tone).toBe('blue')
    })

    it('selectedEntityPropertyDefs：命中类型名精确匹配；大小写不同也能匹配到', () => {
      const { ctx, entity } = makeCtx({
        props: {
          schemaMapping: {
            entity_meta: {
              Scene: { properties: [{ name: 'name' }, { name: 'level' }] },
              scene: { properties: [{ name: 'fallback' }] }
            }
          },
          graphData: { entities: [], edges: [] }
        }
      })
      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'Scene' }
      expect(entity.selectedEntityPropertyDefs).toEqual({ name: { name: 'name' }, level: { name: 'level' } })

      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'SCENE' }
      // 大小写不敏感匹配按 meta 的键顺序命中第一个（Scene），取它的属性表
      expect(entity.selectedEntityPropertyDefs).toEqual({ name: { name: 'name' }, level: { name: 'level' } })

      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'Ghost' }
      expect(entity.selectedEntityPropertyDefs).toEqual({})
    })

    it('selectedEntityRelations：出向/入向各标方向，对端实体名取 properties.name 优先', () => {
      const { ctx, entity } = makeCtx()
      ctx.graphDataCache.value = {
        entities: [
          { entity_id: 'a', entity_name: 'A-raw' },
          { entity_id: 'b', properties: { name: 'B-props' } },
          { entity_id: 'c', entity_name: 'C-raw' }
        ],
        edges: [
          { edge_id: 'r1', source_id: 'a', target_id: 'b', edge_type: 'Relates' },
          { edge_id: 'r2', source_id: 'c', target_id: 'a', edge_type: 'Owns', properties: { since: '2020' } },
          { edge_id: 'r3', source_id: 'a', target_id: 'ghost' } // 对端实体不在画布 → 过滤
        ]
      }
      ctx.selection.selectedEntity = { entity_id: 'a' }

      expect(entity.selectedEntityRelations).toEqual([
        {
          id: 'r1',
          direction: '指向',
          label: 'Relates',
          peer: { entity_id: 'b', properties: { name: 'B-props' }, name: 'B-props' }
        },
        { id: 'r2', direction: '来自', label: 'Owns', peer: { entity_id: 'c', entity_name: 'C-raw', name: 'C-raw' } }
      ])
    })

    it('selectedEntityRelations：未选中实体时为空', () => {
      const { entity } = makeCtx()
      expect(entity.selectedEntityRelations).toEqual([])
    })

    it('createEntityPropertyDefs：类型 → 属性数组（非数组落空数组）', () => {
      const { entity } = makeCtx({
        props: {
          schemaMapping: {
            entity_meta: {
              Scene: { properties: [{ name: 'name' }] },
              Ghost: { properties: 'not-array' }
            }
          },
          graphData: { entities: [], edges: [] }
        }
      })

      expect(entity.createEntityPropertyDefs).toEqual({ Scene: [{ name: 'name' }], Ghost: [] })
    })
  })

  describe('抽屉开关与选择/定位', () => {
    it('openCreateDrawer：开新增抽屉并收起编辑抽屉', () => {
      const { entity } = makeCtx()
      entity.editDrawerVisible = true

      entity.openCreateDrawer()

      expect(entity.createDrawerVisible).toBe(true)
      expect(entity.editDrawerVisible).toBe(false)
    })

    it('handleEntityDrawerSelect：切换选中实体并同步画布选中', async () => {
      const graphCanvasRef = ref({ selectNodes: vi.fn() })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      const peer = { entity_id: 'peer-1' }

      entity.handleEntityDrawerSelect(peer)

      // selection 是 reactive store：写进去的 peer 被包成代理，但指向同一份数据
      expect(ctx.selection.selectedEntity).toEqual(peer)
      expect(graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['peer-1'])

      entity.handleEntityDrawerSelect(null)
      expect(ctx.selection.selectedEntity).toEqual(peer)
    })

    it('handleEntityDrawerLocate：关编辑抽屉 + 画布选中并聚焦该节点', () => {
      const graphCanvasRef = ref({ selectNodes: vi.fn(), focusNode: vi.fn() })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      ctx.selection.selectedEntity = { entity_id: 'e9' }
      entity.editDrawerVisible = true

      entity.handleEntityDrawerLocate()

      expect(entity.editDrawerVisible).toBe(false)
      expect(graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['e9'])
      expect(graphCanvasRef.value.focusNode).toHaveBeenCalledWith('e9')

      ctx.selection.selectedEntity = null
      entity.editDrawerVisible = true
      entity.handleEntityDrawerLocate()
      expect(entity.editDrawerVisible).toBe(true)
    })
  })

  describe('handleEntityDrawerSave（编辑保存 → updateEntityApi）', () => {
    function selectedCtx () {
      const graphCanvasRef = ref({ updateNode: vi.fn() })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'Scene', properties: { name: '旧名' } }
      return { ctx, entity, graphCanvasRef }
    }

    it('无选中实体或空 payload 时直接返回', async () => {
      const { ctx, entity } = makeCtx()

      await entity.handleEntityDrawerSave({ properties: {} })
      expect(updateEntityApiMock).not.toHaveBeenCalled()

      ctx.selection.selectedEntity = { entity_id: 'e1' }
      await entity.handleEntityDrawerSave(null)
      expect(updateEntityApiMock).not.toHaveBeenCalled()
    })

    it('成功且画布可用：更新缓存与画布、发增量事件、关抽屉', async () => {
      const { ctx, entity, graphCanvasRef } = selectedCtx()
      ctx.graphDataCache.value.entities.push({ entity_id: 'e1', properties: { name: '旧名' } })
      updateEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleEntityDrawerSave({ properties: { name: '新名' } })

      expect(updateEntityApiMock).toHaveBeenCalledWith('kb-1', 'e1', 'Scene', { name: '新名' })
      expect(ctx.proxy.$message.success).toHaveBeenCalledWith('实体更新成功')
      expect(entity.editDrawerVisible).toBe(false)
      expect(ctx.graphDataCache.value.entities[0].properties).toEqual({ name: '新名' })
      expect(ctx.selection.selectedEntity.properties).toEqual({ name: '新名' })
      expect(graphCanvasRef.value.updateNode).toHaveBeenCalledTimes(1)
      expect(ctx.emit).toHaveBeenCalledWith('refresh-graph-data', {
        incremental: true,
        updatedEntities: [expect.objectContaining({ properties: { name: '新名' } })]
      })
      expect(entity.entityDrawerSaving).toBe(false)
    })

    it('画布不可用（updateNode 缺失）：回源刷新兜底', async () => {
      const { ctx, entity } = makeCtx()
      ctx.selection.selectedEntity = { entity_id: 'e1', entity_type: 'Scene' }
      updateEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleEntityDrawerSave({ properties: {} })

      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({ ensureEntity: expect.any(Object) })
    })

    it('失败响应：错误提示 + 回源刷新，抽屉保留（已填内容不丢）', async () => {
      const { ctx, entity } = selectedCtx()
      entity.editDrawerVisible = true
      updateEntityApiMock.mockResolvedValue({ success: false, message: '约束冲突' })

      await entity.handleEntityDrawerSave({ properties: { name: '新名' } })

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('约束冲突')
      expect(entity.editDrawerVisible).toBe(true)
      expect(ctx.requestServerRefresh).toHaveBeenCalledTimes(1)
      expect(ctx.stopGraphLoading).toHaveBeenCalledTimes(1)
      expect(entity.entityDrawerSaving).toBe(false)
    })

    it('API 抛异常：只留日志 + 回源刷新', async () => {
      const { ctx, entity } = selectedCtx()
      updateEntityApiMock.mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error')

      await entity.handleEntityDrawerSave({ properties: {} })

      expect(errSpy).toHaveBeenCalled()
      expect(ctx.requestServerRefresh).toHaveBeenCalledTimes(1)
    })

    it('拿不到知识库 ID 时静默返回', async () => {
      const { ctx, entity } = makeCtx({ getKnowledgeBaseId: () => null })
      ctx.selection.selectedEntity = { entity_id: 'e1' }

      await entity.handleEntityDrawerSave({ properties: {} })

      expect(updateEntityApiMock).not.toHaveBeenCalled()
      expect(entity.entityDrawerSaving).toBe(false)
    })
  })

  describe('handleCreateEntity（新增实体 → createEntityApi）', () => {
    const CREATE_PAYLOAD = {
      entityId: 'ent-9',
      entityType: 'Scene',
      entityName: '新实体',
      properties: { name: '新实体' }
    }

    it('无 payload / 保存中 / 无知识库 ID 时直接返回', async () => {
      const { ctx, entity } = makeCtx()

      await entity.handleCreateEntity(null)
      expect(createEntityApiMock).not.toHaveBeenCalled()

      let release
      createEntityApiMock.mockReturnValue(new Promise((resolve) => { release = resolve }))
      const first = entity.handleCreateEntity(CREATE_PAYLOAD)
      await entity.handleCreateEntity(CREATE_PAYLOAD) // saving 中 → 忽略
      release({ success: true })
      await first
      expect(createEntityApiMock).toHaveBeenCalledTimes(1)

      const solo = makeCtx({ getKnowledgeBaseId: () => null })
      await solo.entity.handleCreateEntity(CREATE_PAYLOAD)
      expect(createEntityApiMock).toHaveBeenCalledTimes(1)
    })

    it('失败响应（含接口抛错被 catch 成 failure）：抽屉保留、不动画布', async () => {
      const { ctx, entity } = makeCtx()
      entity.createDrawerVisible = true
      createEntityApiMock.mockResolvedValue({ success: false, message: 'ID 重复' })

      await entity.handleCreateEntity(CREATE_PAYLOAD)

      expect(ctx.proxy.$message.success).not.toHaveBeenCalled()
      expect(entity.createDrawerVisible).toBe(true)
      expect(ctx.graphDataCache.value.entities).toHaveLength(0)
      expect(entity.createEntitySaving).toBe(false)
    })

    it('接口抛错时转成失败响应（axios 拦截器已提示，抽屉与已填内容保留）', async () => {
      const { entity } = makeCtx()
      entity.createDrawerVisible = true
      createEntityApiMock.mockRejectedValue(new Error('boom'))

      await entity.handleCreateEntity(CREATE_PAYLOAD)

      expect(entity.createDrawerVisible).toBe(true)
      expect(entity.createEntitySaving).toBe(false)
    })

    it('成功（无连带关系）：增量落画布 + 入操作队列 + 回源刷新，清搜索并选中新节点', async () => {
      const graphCanvasRef = ref({
        addNode: vi.fn(() => ({ x: 10, y: 20 })),
        selectNodes: vi.fn(),
        focusNode: vi.fn()
      })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      entity.createDrawerVisible = true
      createEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleCreateEntity(CREATE_PAYLOAD)
      await nextTick()

      expect(entity.createDrawerVisible).toBe(false)
      expect(ctx.proxy.$message.success).toHaveBeenCalledWith('实体已添加到知识图谱')
      expect(ctx.graphDataCache.value.entities[0]).toEqual(expect.objectContaining({
        entity_id: 'ent-9',
        entity_type: 'Scene',
        x: 10,
        y: 20
      }))
      expect(ctx.operationQueue.value).toEqual([
        { type: 'addEntity', data: { entity: expect.objectContaining({ entity_id: 'ent-9' }) } }
      ])
      expect(ctx.emit).toHaveBeenCalledWith('search-clear')
      expect(ctx.bumpLimitFromLocalEntityCount).toHaveBeenCalledTimes(1)
      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({
        ensureEntity: expect.objectContaining({ entity_id: 'ent-9' }),
        ensureEdges: []
      })
      expect(graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['ent-9'])
      expect(graphCanvasRef.value.focusNode).toHaveBeenCalledWith('ent-9')
      expect(ctx.selection.selectedEntity).toEqual(expect.objectContaining({ entity_id: 'ent-9' }))
    })

    it('成功（带连带关系）：连边一起落画布与队列，成功文案带关系', async () => {
      const graphCanvasRef = ref({
        addNode: vi.fn(() => null),
        addEdge: vi.fn(),
        selectNodes: vi.fn(),
        focusNode: vi.fn()
      })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      createEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleCreateEntity({
        ...CREATE_PAYLOAD,
        relation: {
          edgeId: 'r9',
          edgeType: 'Relates',
          peerId: 'a',
          sourceId: 'a',
          targetId: 'ent-9',
          properties: { w: 2 }
        }
      })
      await nextTick()

      expect(ctx.proxy.$message.success).toHaveBeenCalledWith('实体与关联关系已添加到知识图谱')
      expect(ctx.graphDataCache.value.edges[0]).toEqual({
        edge_id: 'r9',
        edge_type: 'Relates',
        source_id: 'a',
        target_id: 'ent-9',
        properties: { w: 2 }
      })
      expect(graphCanvasRef.value.addEdge).toHaveBeenCalledTimes(1)
      expect(ctx.operationQueue.value.map(op => op.type)).toEqual(['addEntity', 'addEdge'])
      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({
        ensureEntity: expect.any(Object),
        ensureEdges: [expect.objectContaining({ edge_id: 'r9' })]
      })
    })

    it('画布 addNode 没给坐标时实体不带 x/y（交给画布自动布局）', async () => {
      const graphCanvasRef = ref({ addNode: vi.fn(() => ({ x: NaN, y: NaN })) })
      const { ctx, entity } = makeCtx({ graphCanvasRef })
      createEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleCreateEntity(CREATE_PAYLOAD)

      expect(ctx.graphDataCache.value.entities[0].x).toBeUndefined()
    })
  })

  describe('handleDeleteNode（删除实体 → deleteEntityApi）', () => {
    function deletingCtx () {
      const { ctx, entity } = makeCtx()
      ctx.selection.selectedEntity = {
        entity_id: 'e1',
        class: 'Scene',
        entity_name: '节点A'
      }
      return { ctx, entity }
    }

    it('确认取消时直接返回，不调 API', async () => {
      const { ctx, entity } = deletingCtx()
      ctx.proxy.$confirm = vi.fn().mockRejectedValue(new Error('cancel'))

      await entity.handleDeleteNode()

      expect(deleteEntityApiMock).not.toHaveBeenCalled()
    })

    it('确认后删除成功：关气泡 + 带 deletedEntityId 回源刷新', async () => {
      const { ctx, entity } = deletingCtx()
      ctx.proxy.$confirm = vi.fn().mockResolvedValue()
      deleteEntityApiMock.mockResolvedValue({ success: true })

      await entity.handleDeleteNode()

      expect(deleteEntityApiMock).toHaveBeenCalledWith('kb-1', 'e1', 'Scene')
      expect(ctx.selection.closeActionPopover).toHaveBeenCalled()
      expect(ctx.requestServerRefresh).toHaveBeenCalledWith({ deletedEntityId: 'e1' })
    })

    it('失败响应：错误提示（缺 message 兜底「实体删除失败」）', async () => {
      const { ctx, entity } = deletingCtx()
      ctx.proxy.$confirm = vi.fn().mockResolvedValue()
      deleteEntityApiMock.mockResolvedValue({ success: false })

      await entity.handleDeleteNode()

      expect(ctx.proxy.$message.error).toHaveBeenCalledWith('实体删除失败')
    })

    it('API 抛异常：只留日志（axios 拦截器已提示）', async () => {
      const { ctx, entity } = deletingCtx()
      ctx.proxy.$confirm = vi.fn().mockResolvedValue()
      deleteEntityApiMock.mockRejectedValue(new Error('boom'))
      const errSpy = vi.spyOn(console, 'error')

      await entity.handleDeleteNode()

      expect(errSpy).toHaveBeenCalled()
      expect(ctx.proxy.$message.error).not.toHaveBeenCalled()
    })

    it('没选中实体或拿不到知识库 ID 时不调 API', async () => {
      const { ctx, entity } = makeCtx()
      await entity.handleDeleteNode()
      expect(deleteEntityApiMock).not.toHaveBeenCalled()

      ctx.selection.selectedEntity = { entity_id: 'e1' }
      ctx.getKnowledgeBaseId = () => null
      ctx.proxy.$confirm = vi.fn().mockResolvedValue()
      await entity.handleDeleteNode()
      expect(deleteEntityApiMock).not.toHaveBeenCalled()
    })
  })
})
