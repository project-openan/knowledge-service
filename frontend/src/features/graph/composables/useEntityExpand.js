/**
 * useEntityExpand —— 实体展开/收起（画布节点右上角 +/- 图标）。
 *
 * 拆分缘由：展开/收起原先整块写在 GraphVisualization.vue（约 2368-2529 行）：
 * entityExpandState（Map）+ hiddenNodeIds（Set）两个手动画布同步的状态、DFS 收集
 * 出向子孙、收起/展开/切换三个动作。图遍历部分已抽到 lib/graph-descendants（纯函数），
 * 这个 composable 只负责「状态落盘 + 通知画布刷可见性」。
 *
 * 行为保持不变：
 * - Map/Set 整体替换（而不是原地改）以触发响应式更新；
 * - 收起子树时把子孙 id 记入 hiddenNodeIds，画布按 persistentlyHiddenNodeIds 隐藏；
 * - 展开时整棵出向子树全部展示（不做分层），仍有出向边的中间节点标记为已展开（显示减号）。
 */
import { computed, reactive, ref, nextTick } from 'vue'
import { getOutgoingDescendants, hasOutgoingEdgeFrom } from '../lib/graph-descendants'

export function useEntityExpand (ctx) {
  const { proxy, graphDataCache, graphCanvasRef } = ctx

  // 实体展开/收起状态管理
  const entityExpandState = ref(new Map()) // 存储实体的展开/收起状态：key=entityId, value=isExpanded
  /** 持久隐藏的节点 id（统一为 string，与 vis DataSet id 比对时一致） */
  const hiddenNodeIds = ref(new Set())

  /** 供 GraphCanvasVis 与 hiddenNodeIds 同步（Set 整体替换后触发更新） */
  const persistentlyHiddenNodeIdsList = computed(() => [...hiddenNodeIds.value])

  /** 供画布节点右上角展开/收起图标与 entityExpandState 同步 */
  const entityExpandStateForCanvas = computed(() => {
    const m = {}
    entityExpandState.value.forEach((v, k) => {
      m[String(k)] = v !== false
    })
    return m
  })

  /**
   * 同步画布可见性：须在 nextTick 执行，以便子组件已收到 persistentlyHiddenNodeIds；
   * 具体逻辑在 GraphCanvasVis.syncVisibilityFromHiddenProps（含悬浮一跳与 network.redraw）。
   */
  function updateNodeVisibility () {
    if (!graphCanvasRef.value) {
      return
    }
    nextTick(() => {
      graphCanvasRef.value?.syncVisibilityFromHiddenProps?.()
    })
  }

  /**
   * 收起实体的出向子实体
   * @param {Object} entity - 要收起的实体对象
   */
  function collapseEntity (entity) {
    if (!entity) {
      return
    }

    const entityId = entity.entity_id || entity.id
    const edges = graphDataCache.value.edges || []
    const entities = graphDataCache.value.entities || []

    // 获取所有出向子孙实体
    const descendants = getOutgoingDescendants(entityId, edges, entities)

    descendants.forEach(desc => {
      const descId = String(desc.entity_id || desc.id)
      hiddenNodeIds.value.add(descId)
    })

    hiddenNodeIds.value = new Set(hiddenNodeIds.value)

    entityExpandState.value.set(entityId, false)
    entityExpandState.value = new Map(entityExpandState.value)

    if (graphCanvasRef.value) {
      updateNodeVisibility()
    }

    proxy.$message.success(proxy.$t('modules.kb.collapseSuccess'))
  }

  /**
   * 展开实体的出向子实体（整棵出向子树全部展示，不做分层）
   * @param {Object} entity - 要展开的实体对象
   */
  function expandEntity (entity) {
    if (!entity) {
      return
    }

    const entityId = entity.entity_id || entity.id
    const edges = graphDataCache.value.edges || []
    const entities = graphDataCache.value.entities || []

    const allDescendants = getOutgoingDescendants(entityId, edges, entities)

    allDescendants.forEach((desc) => {
      const id = String(desc.entity_id || desc.id)
      hiddenNodeIds.value.delete(id)
    })

    hiddenNodeIds.value = new Set(hiddenNodeIds.value)

    entityExpandState.value.set(entityId, true)

    // 子树全部可见时，仍有出向边的中间节点也应为「已展开」，右上角显示减号
    allDescendants.forEach((desc) => {
      const nid = desc.entity_id || desc.id
      if (hasOutgoingEdgeFrom(nid, edges)) {
        entityExpandState.value.set(nid, true)
      }
    })

    entityExpandState.value = new Map(entityExpandState.value)

    if (graphCanvasRef.value) {
      updateNodeVisibility()
    }

    proxy.$message.success(proxy.$t('modules.kb.expandSuccess'))
  }

  /**
   * 切换实体的展开/收起状态
   * @param {Object} entity - 实体对象
   * @param {Event} event - 点击事件
   */
  function toggleEntityExpand (entity, event) {
    if (!entity) {
      return
    }

    event.stopPropagation() // 阻止事件冒泡，避免触发节点点击

    const entityId = entity.entity_id || entity.id
    const isExpanded = entityExpandState.value.get(entityId) !== false // 默认是展开的

    if (isExpanded) {
      collapseEntity(entity)
    } else {
      expandEntity(entity)
    }
  }

  /** 画布节点 +/- 图标回调：GraphCanvasVis 只给 nodeId，这里换回实体对象再切换。 */
  function handleToggleExpandFromCanvas (nodeId) {
    const entity = graphDataCache.value.entities.find(
      (e) => String(e.entity_id || e.id) === String(nodeId)
    )
    if (entity) {
      toggleEntityExpand(entity, { stopPropagation: () => {} })
    }
  }

  return reactive({
    persistentlyHiddenNodeIdsList,
    entityExpandStateForCanvas,
    toggleEntityExpand,
    handleToggleExpandFromCanvas
  })
}
