/**
 * useGraphSelection —— 画布节点选中与实体操作气泡。
 *
 * 拆分缘由：原先 GraphVisualization.vue 里「单击节点 → 延迟弹气泡（区分双击）→
 * 编辑/删除/加关系」这条选中链路和边选中、抽屉逻辑混在一个 2000 行的 script 里。
 * 这里只收拢「实体侧」的选中与气泡状态；边侧选中在 useGraphEdgeCrud，
 * 两边通过 ctx 在运行时互相关气泡（保持原互斥行为）。
 *
 * 单击延迟（CLICK_DELAY_MS）来自 lib/graph-geometry：单击要等一段时间确认不是双击的
 * 前半下才弹气泡，否则气泡挡住第二次点击会导致双击失效。
 */
import { reactive, ref } from 'vue'
import { CLICK_DELAY_MS } from '../lib/graph-geometry'

export function useGraphSelection (ctx) {
  const { graphContainer, graphCanvasRef } = ctx

  const selectedEntity = ref(null)
  const actionPopoverVisible = ref(false)
  const actionPopoverPosition = ref({ x: 0, y: 0 })
  const nodeClickDelayTimer = ref(null)

  /** 页面坐标 → 画布容器内坐标（气泡是 absolute 定位在容器里的） */
  function toContainerPosition (pos) {
    const rect = graphContainer.value?.getBoundingClientRect()
    // 与原实现一致：pos == null 同时覆盖 null / undefined（保持宽松判空语义）
    if (!rect || pos === null || pos === undefined) {
      return { x: pos?.x ?? 0, y: pos?.y ?? 0 }
    }
    return { x: pos.x - rect.left, y: pos.y - rect.top }
  }

  // 关闭操作气泡卡片
  function closeActionPopover () {
    actionPopoverVisible.value = false
  }

  /** 清掉未触发的单击延迟计时器（双击 / 点空白时要取消已排队的气泡） */
  function clearNodeClickTimer () {
    if (nodeClickDelayTimer.value) {
      clearTimeout(nodeClickDelayTimer.value)
      nodeClickDelayTimer.value = null
    }
  }

  function handleNodeClickFromCanvas (entity, pos) {
    // 连线模式下单击节点是「选终点」，交给关系抽屉的 composable 处理
    if (ctx.relation?.isAddingEdgeMode) {
      ctx.relation.handleNodeClickInEdgeMode({ id: entity.entity_id || entity.id, data: entity })
      return
    }
    clearNodeClickTimer()
    selectedEntity.value = entity
    actionPopoverPosition.value = toContainerPosition(pos)
    nodeClickDelayTimer.value = setTimeout(() => {
      nodeClickDelayTimer.value = null
      actionPopoverVisible.value = true
      // 实体/边气泡互斥：弹实体气泡时收掉边气泡
      ctx.edgeCrud?.closeEdgeActionPopover()
      graphCanvasRef.value?.selectNodes?.([entity.entity_id || entity.id])
    }, CLICK_DELAY_MS)
  }

  function handleNodeDoubleClickFromCanvas (entity) {
    if (!entity) {
      return
    }
    clearNodeClickTimer()
    selectedEntity.value = entity
    actionPopoverVisible.value = false
    ctx.edgeCrud?.closeEdgeActionPopover()
    ctx.openExclusiveDrawer('entityEdit')
  }

  // 修改节点（气泡「编辑」按钮）
  function handleEdit () {
    closeActionPopover()

    if (!selectedEntity.value) {
      return
    }

    // 打开编辑抽屉
    ctx.openExclusiveDrawer('entityEdit')
  }

  return reactive({
    selectedEntity,
    actionPopoverVisible,
    actionPopoverPosition,
    toContainerPosition,
    closeActionPopover,
    clearNodeClickTimer,
    handleNodeClickFromCanvas,
    handleNodeDoubleClickFromCanvas,
    handleEdit
  })
}
