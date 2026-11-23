/**
 * useGraphRelationDrawer —— 「添加关系」抽屉与画布连线模式。
 *
 * 拆分缘由：添加关系有三个入口（摘要行按钮、节点气泡按钮、画布连线模式点起点/终点），
 * 原先对应的状态与函数（relationDrawerVisible/sourceId/targetId/saving、
 * isAddingEdgeMode/connectableNodes/起终点节点）散在 GraphVisualization.vue 的
 * 状态区与函数区两处。收进一个 composable 后，三个入口共用同一套打开逻辑，
 * 「同一时间只留一个抽屉」的互斥规则也集中在这里维护。
 */
import { reactive, ref } from 'vue'
import { createEdgeApi } from '@/features/graph/api/knowledgeGraph'
import { buildEnsureEdgePayload, isGraphApiSuccess } from '../lib/graph-schema'

export function useGraphRelationDrawer (ctx) {
  const { proxy, t } = ctx

  // 添加关系相关状态（抽屉内自选起点/终点）
  const drawerVisible = ref(false)
  const sourceId = ref('')
  const targetId = ref('')
  const saving = ref(false)

  // 添加边交互模式相关状态（画布连线模式：点起点再点终点）
  const isAddingEdgeMode = ref(false) // 是否处于添加边模式
  const connectableNodes = ref([]) // 可连接的节点列表
  const sourceNodeForEdge = ref(null) // 起始节点
  const targetNodeForEdge = ref(null) // 目标节点

  // 退出添加边模式
  function exitAddingEdgeMode () {
    isAddingEdgeMode.value = false
    sourceNodeForEdge.value = null
    targetNodeForEdge.value = null
    connectableNodes.value = []
  }

  /** 打开「添加关系」抽屉；node 为空时由抽屉内自选起点。 */
  function openRelationDrawer (node = ctx.selection?.selectedEntity) {
    ctx.selection?.closeActionPopover()
    exitAddingEdgeMode()
    // 同一时间只留一个抽屉：实体/边抽屉开着时先收起（实体抽屉的「添加关系」在未保存时禁用）
    // 直接写各 composable store 上的可见性字段（与原先对三个 ref 置 false 等价）
    if (ctx.entity) {
      ctx.entity.editDrawerVisible = false
    }
    if (ctx.edgeCrud) {
      ctx.edgeCrud.viewDrawerVisible = false
      ctx.edgeCrud.editDrawerVisible = false
    }
    sourceId.value = String(node?.entity_id ?? node?.id ?? '')
    targetId.value = ''
    drawerVisible.value = true
  }

  // 节点气泡「添加关系」：以当前选中实体为起点
  function handleAddEdge () {
    if (!ctx.selection?.selectedEntity) {
      return
    }
    openRelationDrawer(ctx.selection.selectedEntity)
  }

  /** 画布连线模式（点击起点再点终点）完成后打开同一个抽屉，两端预填。 */
  function openAddEdgeDrawer () {
    if (!sourceNodeForEdge.value || !targetNodeForEdge.value) {
      return
    }
    ctx.selection?.closeActionPopover()
    sourceId.value = String(sourceNodeForEdge.value.entity_id ?? '')
    targetId.value = String(targetNodeForEdge.value.entity_id ?? '')
    drawerVisible.value = true
    exitAddingEdgeMode()
  }

  // 处理添加边模式下的节点点击
  function handleNodeClickInEdgeMode (d) {
    // 检查是否点击了起始节点
    if (d.id === sourceNodeForEdge.value?.entity_id) {
      return
    }

    // 检查是否点击了可连接的节点
    if (connectableNodes.value.includes(d.id)) {
      // 保存目标节点
      targetNodeForEdge.value = d.data

      // 打开添加边抽屉
      openAddEdgeDrawer()

      // 注意：不退出连线模式，保持相关实体显示状态
    }
  }

  /** 创建关系（真实 createEdgeApi）；成功后带新边刷新，避免 limit 截断时看不到。 */
  async function handleRelationSave (relation) {
    if (!relation || saving.value) {
      return
    }
    const kbId = ctx.getKnowledgeBaseId()
    if (!kbId) {
      return
    }
    saving.value = true
    try {
      const response = await createEdgeApi(
        kbId,
        relation.edgeId,
        relation.edgeType,
        relation.properties,
        relation.sourceId,
        relation.targetId
      )
      if (!isGraphApiSuccess(response)) {
        proxy.$message.error(response?.message || t('modules.kb.edgeCreateFailed'))
        return
      }
      proxy.$message.success(t('modules.kb.edgeCreateSuccess'))
      drawerVisible.value = false
      ctx.requestServerRefresh({ ensureEdges: buildEnsureEdgePayload(relation) })
    } catch (error) {
      proxy.$message.error(`${t('modules.kb.edgeCreateFailed')}：${error.message || t('modules.kb.networkError')}`)
    } finally {
      saving.value = false
    }
  }

  return reactive({
    drawerVisible,
    sourceId,
    targetId,
    saving,
    isAddingEdgeMode,
    exitAddingEdgeMode,
    openRelationDrawer,
    handleAddEdge,
    openAddEdgeDrawer,
    handleRelationSave,
    handleNodeClickInEdgeMode
  })
}
