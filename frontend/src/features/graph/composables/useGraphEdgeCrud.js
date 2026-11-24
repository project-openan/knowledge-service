/**
 * useGraphEdgeCrud —— 边的选中、气泡、查看/编辑抽屉与删除（边 CRUD）。
 *
 * 拆分缘由：GraphVisualization.vue 的 script 里「边」这条线（selectedEdge、边气泡、
 * 查看抽屉、编辑抽屉表单、updateEdgeApi/deleteEdgeApi 调用与各自的成败分支）散落在
 * 4 个区域共 250+ 行，是组件职责过载的主要来源之一。集中到一个 composable 后，
 * 模板里对应的两个抽屉也拆到 components/graph-visualization/GraphEdgeDrawers.vue，
 * 主文件只剩组合。
 *
 * 行为保持不变：
 * - 边气泡与实体气泡互斥（延迟弹出的计时器各自管理）；
 * - 编辑表单从 selectedEdge 深拷贝（JSON.parse(JSON.stringify(...))），BOOLEAN 属性
 *   提交前按 schema 定义转换（lib/graph-schema.convertBooleanProperties）；
 * - 更新成功走增量刷新（updateEdge + emit refresh-graph-data），失败/异常回源刷新。
 */
import { reactive, ref } from 'vue'
import { updateEdgeApi, deleteEdgeApi } from '@/features/graph/api/knowledgeGraph'
import { findEdgePropertyDef, convertBooleanProperties, isGraphApiSuccess } from '../lib/graph-schema'
import { CLICK_DELAY_MS } from '../lib/graph-geometry'

export function useGraphEdgeCrud (ctx) {
  const { props, route, proxy, emit, graphDataCache, graphCanvasRef } = ctx

  // 边相关状态
  const selectedEdge = ref(null)
  const edgeActionPopoverVisible = ref(false)
  const edgeActionPopoverPosition = ref({ x: 0, y: 0 })
  const viewDrawerVisible = ref(false) // 查看抽屉（原 edgeDrawerVisible）
  const editDrawerVisible = ref(false) // 编辑抽屉（原 edgeEditDrawerVisible）
  const viewCollapse = ref(['basic', 'properties'])
  const editCollapse = ref(['basic', 'properties'])
  const edgeEditForm = ref({
    edge_id: '',
    class: '',
    rid: '',
    source_id: '',
    target_id: '',
    in: '',
    out: '',
    properties: {}
  })
  // 边单击延迟计时器（与实体选中同款：区分单击弹气泡 / 双击进编辑）
  const edgeClickDelayTimer = ref(null)

  // 根据边类型和属性名获取属性定义（编辑抽屉里 BOOLEAN 属性要用下拉框）
  function getEdgePropertyDef (edgeType, propName) {
    return findEdgePropertyDef(props.schemaMapping?.adjacency_map || {}, edgeType, propName)
  }

  // 关闭边的操作气泡卡片
  function closeEdgeActionPopover () {
    edgeActionPopoverVisible.value = false
  }

  /** 清掉未触发的单击延迟计时器（双击 / 点空白时取消已排队的气泡） */
  function clearEdgeClickTimer () {
    if (edgeClickDelayTimer.value) {
      clearTimeout(edgeClickDelayTimer.value)
      edgeClickDelayTimer.value = null
    }
  }

  /** 画布单击边：延迟弹气泡，并高亮两端节点 */
  function handleCanvasEdgeClick (edge, pos) {
    clearEdgeClickTimer()
    selectedEdge.value = edge
    edgeActionPopoverPosition.value = ctx.selection.toContainerPosition(pos)
    edgeClickDelayTimer.value = setTimeout(() => {
      edgeClickDelayTimer.value = null
      edgeActionPopoverVisible.value = true
      // 边/实体气泡互斥
      ctx.selection?.closeActionPopover()
      const sourceId = edge.source_id || edge.source
      const targetId = edge.target_id || edge.target
      if (sourceId && targetId) {
        graphCanvasRef.value?.selectNodes?.([sourceId, targetId])
      }
    }, CLICK_DELAY_MS)
  }

  // 修改边（气泡「编辑」按钮）
  function handleEditEdge () {
    closeEdgeActionPopover()

    if (!selectedEdge.value) {
      return
    }

    // 复制当前边数据到编辑表单
    edgeEditForm.value = {
      edge_id: selectedEdge.value.edge_id || selectedEdge.value.id || '',
      class: selectedEdge.value.edge_type || selectedEdge.value.class || '',
      rid: selectedEdge.value.rid || '',
      source_id: selectedEdge.value.source_id || '',
      target_id: selectedEdge.value.target_id || '',
      in: selectedEdge.value.in || '',
      out: selectedEdge.value.out || '',
      properties: JSON.parse(JSON.stringify(selectedEdge.value.properties || {}))
    }

    ctx.openExclusiveDrawer('edgeEdit')
  }

  // 画布双击边：直接带数据进编辑抽屉
  function handleEdgeDoubleClickFromCanvas (edge) {
    if (!edge) {
      return
    }
    clearEdgeClickTimer()
    selectedEdge.value = edge
    edgeEditForm.value = {
      edge_id: edge.edge_id || edge.id || '',
      class: edge.edge_type || edge.class || '',
      rid: edge.rid || '',
      source_id: edge.source_id || edge.source || '',
      target_id: edge.target_id || edge.target || '',
      in: edge.in || '',
      out: edge.out || '',
      properties: JSON.parse(JSON.stringify(edge.properties || {}))
    }
    ctx.selection?.closeActionPopover()
    closeEdgeActionPopover()
    ctx.openExclusiveDrawer('edgeEdit')
  }

  // 关闭边查看抽屉
  function handleCloseEdgeDrawer () {
    viewDrawerVisible.value = false
  }

  // 确定编辑边
  async function handleConfirmEditEdge () {
    if (!selectedEdge.value) {
      console.error('❌ selectedEdge.value 为空，无法编辑边')
      return
    }

    const edgeId = selectedEdge.value.edge_id || selectedEdge.value.id
    const edgeType = selectedEdge.value.edge_type || selectedEdge.value.class
    // 转换BOOLEAN属性值
    const properties = convertBooleanProperties(edgeEditForm.value.properties, getEdgePropertyDef, edgeType)

    try {
      // 获取知识库ID
      const kbId = route.params.id || props.graphData.kbId
      if (!kbId) {
        console.error('❌ 无法获取知识库ID')
        proxy.$message.error(proxy.$t('modules.kb.cannotGetKbId'))
        return
      }

      // 调用后端API更新边
      const response = await updateEdgeApi(kbId, edgeId, edgeType, properties)

      // 检查API响应；成功与失败均触发查询更新数据
      if (response && response.success) {
        proxy.$message.success(proxy.$t('modules.kb.edgeUpdateSuccess'))

        // 1. 找到本地对应的边并更新属性
        const edge = props.graphData.edges.find(e => (e.edge_id || e.id) === edgeId)
        const updatedEdge = edge
          ? {
            ...edge,
            properties: { ...edgeEditForm.value.properties },
            edge_type: edgeEditForm.value.class,
            class: edgeEditForm.value.class
          }
          : null

        if (edge) {
          edge.properties = { ...edgeEditForm.value.properties }
        }

        // 2. 通知父组件同步数据
        if (updatedEdge && graphCanvasRef.value?.updateEdge) {
          const idx = graphDataCache.value.edges.findIndex((e) => (e.edge_id || e.id) === edgeId)
          if (idx >= 0) {
            graphDataCache.value.edges[idx] = updatedEdge
          }
          graphCanvasRef.value.updateEdge(updatedEdge)
          emit('refresh-graph-data', { incremental: true, updatedEdges: [updatedEdge] })
        } else {
          emit('refresh-graph-data', {
            entities: props.graphData.entities,
            edges: props.graphData.edges,
            edgeName: edgeId
          })
          ctx.requestServerRefresh()
        }

        // 3. 关闭编辑抽屉
        editDrawerVisible.value = false
      } else {
        console.error('边更新失败:', response)
        const errorMsg = response?.message || proxy.$t('modules.kb.edgeUpdateFailed')
        proxy.$message.error(errorMsg)
        ctx.requestServerRefresh()
      }
    } catch (error) {
      // axios 拦截器已统一提示，这里只留日志，避免双 toast
      console.error('调用边更新API失败:', error)
      ctx.requestServerRefresh()
    }
  }

  // 取消编辑边
  function handleCancelEditEdge () {
    editDrawerVisible.value = false
  }

  // 删除边
  async function handleDeleteEdge () {
    closeEdgeActionPopover()

    if (!selectedEdge.value) {
      return
    }

    const edgeId = selectedEdge.value.edge_id || selectedEdge.value.id
    const edgeType = selectedEdge.value.edge_type || selectedEdge.value.class

    try {
      await proxy.$confirm(
        proxy.$t('modules.kb.deleteEdgeConfirm', { name: edgeId }),
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

      // 调用后端删除边接口
      const response = await deleteEdgeApi(kbId, edgeId, edgeType)

      // 检查API响应
      if (isGraphApiSuccess(response)) {
        await handleEdgeDeleteSuccess(edgeId)
      } else {
        handleEdgeDeleteFailure(response)
      }
    } catch (error) {
      handleEdgeDeleteError(error)
    }
  }

  // 处理边删除成功
  async function handleEdgeDeleteSuccess (edgeId) {
    // 关闭操作气泡卡片
    closeEdgeActionPopover()

    ctx.requestServerRefresh({ deletedEdgeId: edgeId })
  }

  // 处理边删除失败
  function handleEdgeDeleteFailure (response) {
    console.error('边删除失败:', response)
    const errorMsg = response?.message || proxy.$t('modules.kb.edgeDeleteFailed')
    proxy.$message.error(errorMsg)
  }

  // 处理边删除错误（axios 拦截器已统一提示，这里只留日志，避免双 toast）
  function handleEdgeDeleteError (error) {
    console.error('调用边删除API失败:', error)
  }

  return reactive({
    selectedEdge,
    edgeActionPopoverVisible,
    edgeActionPopoverPosition,
    viewDrawerVisible,
    editDrawerVisible,
    viewCollapse,
    editCollapse,
    editForm: edgeEditForm,
    getEdgePropertyDef,
    closeEdgeActionPopover,
    clearEdgeClickTimer,
    handleCanvasEdgeClick,
    handleEditEdge,
    handleEdgeDoubleClickFromCanvas,
    handleCloseEdgeDrawer,
    handleConfirmEditEdge,
    handleCancelEditEdge,
    handleDeleteEdge
  })
}
