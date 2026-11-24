/**
 * useGraphEntityCrud —— 实体编辑/新增/删除抽屉的全部逻辑。
 *
 * 拆分缘由：GraphVisualization.vue 里「实体」这条线原先占 script 约 400 行：
 * 实体编辑抽屉（updateEntityApi）、新增实体抽屉（createEntityApi，含连带关系），
 * 删除实体（deleteEntityApi），以及三组「成功/失败/异常」分支和抽屉所需的派生数据
 * （类型信息、属性定义、关联关系列表）。集中到一个 composable 后，对应的抽屉组件
 * （GraphEntityDrawer / GraphEntityCreateDrawer）的绑定从主文件直接引用本 store。
 *
 * 行为保持不变：失败时保留抽屉与已填内容（错误提示由 axios 拦截器统一给出）；
 * 创建成功后先增量落画布再带 ensureEntity/ensureEdges 回源刷新，避免 limit 截断丢数据。
 */
import { computed, reactive, ref, nextTick } from 'vue'
import { updateEntityApi, deleteEntityApi, createEntityApi } from '@/features/graph/api/knowledgeGraph'
import { edgeLabelText } from '@/features/graph/lib/edge-label'
import { entityKey, isGraphApiSuccess } from '../lib/graph-schema'

export function useGraphEntityCrud (ctx) {
  const { props, proxy, emit, t, graphDataCache, graphCanvasRef, operationQueue, isBatchProcessing, OperationType } = ctx

  /* ── 实体编辑抽屉 ── */
  const editDrawerVisible = ref(false)
  const entityDrawerSaving = ref(false)

  /* ── 新增实体抽屉 ── */
  const createDrawerVisible = ref(false)
  const createEntitySaving = ref(false)

  const selectedEntityTypeName = computed(() =>
    ctx.selection.selectedEntity?.entity_type || ctx.selection.selectedEntity?.class || ''
  )

  const selectedEntityTypeInfo = computed(() => ({
    name: selectedEntityTypeName.value || t('modules.kb.entityType'),
    tone: ctx.tones.typeToneMap[selectedEntityTypeName.value] || 'blue'
  }))

  const selectedEntityPropertyDefs = computed(() => {
    const meta = props.schemaMapping?.entity_meta || {}
    const type = selectedEntityTypeName.value
    let list = meta[type]?.properties
    if (!list && type) {
      const matched = Object.keys(meta).find((key) => String(key).toLowerCase() === String(type).toLowerCase())
      list = matched ? meta[matched]?.properties : []
    }
    const defs = {}
    ;(Array.isArray(list) ? list : []).forEach((def) => {
      if (def?.name) {
        defs[def.name] = def
      }
    })
    return defs
  })

  const selectedEntityRelations = computed(() => {
    const entity = ctx.selection.selectedEntity
    if (!entity) {
      return []
    }
    const id = String(entityKey(entity))
    const entities = graphDataCache.value.entities || []
    const edges = graphDataCache.value.edges || []
    return edges
      .filter((edge) => {
        const source = String(edge.source_id ?? edge.source ?? '')
        const target = String(edge.target_id ?? edge.target ?? '')
        return source === id || target === id
      })
      .map((edge) => {
        const outgoing = String(edge.source_id ?? edge.source ?? '') === id
        const peerId = outgoing ? (edge.target_id ?? edge.target) : (edge.source_id ?? edge.source)
        const peer = entities.find((item) => String(entityKey(item)) === String(peerId))
        if (!peer) {
          return null
        }
        return {
          id: edge.edge_id ?? edge.id,
          direction: outgoing ? t('modules.kb.entityRelationOutgoing') : t('modules.kb.entityRelationIncoming'),
          label: edgeLabelText(edge),
          peer: {
            ...peer,
            name: peer.properties?.name || peer.entity_name || peer.entity_id
          }
        }
      })
      .filter(Boolean)
  })

  const createEntityPropertyDefs = computed(() => {
    const meta = props.schemaMapping?.entity_meta || {}
    const defs = {}
    Object.keys(meta).forEach((type) => {
      defs[type] = Array.isArray(meta[type]?.properties) ? meta[type].properties : []
    })
    return defs
  })

  function openCreateDrawer () {
    editDrawerVisible.value = false
    createDrawerVisible.value = true
  }

  async function handleCreateEntity (payload) {
    if (!payload || createEntitySaving.value) {
      return
    }
    const kbId = ctx.getKnowledgeBaseId()
    if (!kbId) {
      return
    }
    const relation = payload.relation
    const edgeInfo = relation
      ? {
        edgeId: relation.edgeId,
        edgeType: relation.edgeType,
        currentEntityId: relation.peerId,
        direction: relation.direction,
        properties: relation.properties || {}
      }
      : null
    createEntitySaving.value = true
    try {
      // 失败时保留抽屉与已填内容；错误提示由 axios 拦截器统一给出
      const response = await createEntityApi(
        kbId,
        payload.entityId,
        payload.entityType,
        payload.properties,
        edgeInfo
      ).catch((err) => ({
        success: false,
        message: err?.msg ?? err?.message ?? t('modules.kb.entityCreateFailed')
      }))
      if (!isGraphApiSuccess(response)) {
        return
      }
      createDrawerVisible.value = false
      applyCreatedEntity(payload)
      proxy.$message.success(
        relation ? t('modules.kb.createEntitySuccessWithRelation') : t('modules.kb.createEntitySuccess')
      )
    } finally {
      createEntitySaving.value = false
    }
  }

  /** 创建成功后先增量落到当前画布，再由服务端刷新校正（与旧「增加实体」同一套路径）。 */
  function applyCreatedEntity (payload) {
    const relation = payload.relation
    const entityData = {
      entity_id: payload.entityId,
      entity_type: payload.entityType,
      entity_name: payload.entityName,
      properties: payload.properties
    }

    isBatchProcessing.value = true
    const referenceId = relation?.peerId || ctx.selection.selectedEntity?.entity_id || ''
    const position = graphCanvasRef.value?.addNode?.(entityData, referenceId || undefined)
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      entityData.x = position.x
      entityData.y = position.y
    }
    graphDataCache.value.entities.push({ ...entityData })
    operationQueue.value.push({
      type: OperationType.ADD_ENTITY,
      data: { entity: entityData }
    })

    const ensureEdges = []
    if (relation) {
      const edgeData = {
        edge_id: relation.edgeId,
        edge_type: relation.edgeType,
        source_id: relation.sourceId,
        target_id: relation.targetId,
        properties: relation.properties || {}
      }
      graphDataCache.value.edges.push({ ...edgeData })
      graphCanvasRef.value?.addEdge?.(edgeData)
      operationQueue.value.push({
        type: OperationType.ADD_EDGE,
        data: { edge: edgeData }
      })
      ensureEdges.push({ ...edgeData })
    }

    // 新实体必须可见：清掉客户端搜索条件
    emit('search-clear')
    ctx.bumpLimitFromLocalEntityCount()
    ctx.requestServerRefresh({ ensureEntity: entityData, ensureEdges })
    isBatchProcessing.value = false

    nextTick(() => {
      const id = payload.entityId
      graphCanvasRef.value?.selectNodes?.([id])
      graphCanvasRef.value?.focusNode?.(id)
      ctx.selection.selectedEntity = entityData
    })
  }

  // 确定编辑
  /** 实体编辑抽屉保存：payload = { name, description, properties }（properties 已按模板类型解析） */
  async function handleEntityDrawerSave (payload) {
    if (!ctx.selection.selectedEntity || !payload) {
      return
    }

    const selected = ctx.selection.selectedEntity
    const entityId = selected.entity_id || selected.id
    const entityType = selected.entity_type || selected.class
    const properties = payload.properties || {}

    try {
      const kbId = ctx.getKnowledgeBaseId()
      if (!kbId) {
        return
      }

      entityDrawerSaving.value = true
      const response = await updateEntityApi(kbId, entityId, entityType, properties)

      if (isGraphApiSuccess(response)) {
        handleEntityUpdateSuccess(properties)
      } else {
        handleEntityUpdateFailure(response)
      }
    } catch (error) {
      handleEntityUpdateError(error)
    } finally {
      entityDrawerSaving.value = false
    }
  }

  // 处理实体更新成功
  function handleEntityUpdateSuccess (properties) {
    proxy.$message.success(proxy.$t('modules.kb.entityUpdateSuccess'))

    // 关闭编辑抽屉
    editDrawerVisible.value = false

    if (!ctx.selection.selectedEntity) {
      return
    }

    const updatedEntity = {
      ...ctx.selection.selectedEntity,
      properties: { ...properties }
    }
    const idx = graphDataCache.value.entities.findIndex(
      (e) => (e.entity_id || e.id) === (updatedEntity.entity_id || updatedEntity.id)
    )
    if (idx >= 0) {
      graphDataCache.value.entities[idx] = updatedEntity
    }
    ctx.selection.selectedEntity = updatedEntity

    if (graphCanvasRef.value?.updateNode) {
      graphCanvasRef.value.updateNode(updatedEntity)
      emit('refresh-graph-data', { incremental: true, updatedEntities: [updatedEntity] })
    } else {
      ctx.requestServerRefresh({ ensureEntity: updatedEntity })
    }
  }

  // 处理实体更新失败
  function handleEntityUpdateFailure (response) {
    console.error('实体更新失败:', response)
    const errorMsg = response?.detail || response?.message || proxy.$t('modules.kb.entityUpdateFailed')
    proxy.$message.error(errorMsg)
    ctx.requestServerRefresh()
    ctx.stopGraphLoading()
  }

  // 处理实体更新错误（axios 拦截器已统一提示，这里只留日志，避免双 toast）
  function handleEntityUpdateError (error) {
    console.error('调用实体更新API失败:', error)
    ctx.requestServerRefresh()
    ctx.stopGraphLoading()
  }

  /** 抽屉内点击关联实体：切换当前编辑对象（画布同步选中） */
  function handleEntityDrawerSelect (peer) {
    if (!peer) {
      return
    }
    ctx.selection.selectedEntity = peer
    graphCanvasRef.value?.selectNodes?.([peer.entity_id || peer.id])
  }

  /** 抽屉底部「定位实体」：关闭抽屉并居中到该节点 */
  function handleEntityDrawerLocate () {
    const entity = ctx.selection.selectedEntity
    if (!entity) {
      return
    }
    const id = entity.entity_id || entity.id
    editDrawerVisible.value = false
    graphCanvasRef.value?.selectNodes?.([id])
    graphCanvasRef.value?.focusNode?.(id)
  }

  // 删除节点
  async function handleDeleteNode () {
    ctx.selection.closeActionPopover()

    if (!ctx.selection.selectedEntity) {
      return
    }

    const entityId = ctx.selection.selectedEntity.entity_id
    const entityType = ctx.selection.selectedEntity.class || ctx.selection.selectedEntity.entity_type

    try {
      await proxy.$confirm(
        proxy.$t('modules.kb.deleteEntityConfirm', {
          name: ctx.selection.selectedEntity.entity_name || entityId
        }),
        proxy.$t('modules.kb.delete'),
        { type: 'warning' }
      )
    } catch {
      return
    }

    try {
      const kbId = ctx.getKnowledgeBaseId()
      if (!kbId) {
        return
      }

      // 调用后端删除实体接口
      const response = await deleteEntityApi(kbId, entityId, entityType)

      // 检查API响应
      if (isGraphApiSuccess(response)) {
        await handleNodeDeleteSuccess()
      } else {
        handleNodeDeleteFailure(response)
      }
    } catch (error) {
      handleNodeDeleteError(error)
    }
  }

  // 处理节点删除成功
  async function handleNodeDeleteSuccess () {
    // 关闭操作气泡卡片
    ctx.selection.closeActionPopover()

    ctx.requestServerRefresh({ deletedEntityId: ctx.selection.selectedEntity?.entity_id })
  }

  // 处理节点删除失败
  function handleNodeDeleteFailure (response) {
    console.error('实体删除失败:', response)
    const errorMsg = response?.message || proxy.$t('modules.kb.entityDeleteFailed')
    proxy.$message.error(errorMsg)
  }

  // 处理节点删除错误（axios 拦截器已统一提示，这里只留日志，避免双 toast）
  function handleNodeDeleteError (error) {
    console.error('调用实体删除API失败:', error)
  }

  return reactive({
    editDrawerVisible,
    entityDrawerSaving,
    createDrawerVisible,
    createEntitySaving,
    selectedEntityTypeInfo,
    selectedEntityPropertyDefs,
    selectedEntityRelations,
    createEntityPropertyDefs,
    openCreateDrawer,
    handleCreateEntity,
    handleEntityDrawerSave,
    handleEntityDrawerSelect,
    handleEntityDrawerLocate,
    handleDeleteNode
  })
}
