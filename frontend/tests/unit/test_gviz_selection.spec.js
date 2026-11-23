// @vitest-environment jsdom
/**
 * useGraphSelection —— 画布节点选中与实体操作气泡的状态机。
 *
 * 覆盖四条路径：
 * 1) toContainerPosition：页面坐标 → 容器内坐标（含无容器 / 无坐标的兜底）；
 * 2) 单击节点：延迟 CLICK_DELAY_MS 弹气泡（防双击误弹），弹时收边气泡并选中原节点；
 * 3) 连线模式下的单击：整件事交给 useGraphRelationDrawer 的 handleNodeClickInEdgeMode；
 * 4) 双击 / 气泡「编辑」：关气泡 + 开实体编辑抽屉（互斥抽屉）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { CLICK_DELAY_MS } from '@/features/graph/lib/graph-geometry'
import { useGraphSelection } from '@/features/graph/composables/useGraphSelection'

function makeCtx (overrides = {}) {
  const container = {
    getBoundingClientRect: () => ({ left: 40, top: 20, width: 800, height: 600 })
  }
  const graphCanvasRef = ref({ selectNodes: vi.fn() })
  const ctx = {
    graphContainer: ref(container),
    graphCanvasRef,
    relation: null,
    edgeCrud: null,
    openExclusiveDrawer: vi.fn(),
    ...overrides
  }
  return ctx
}

describe('useGraphSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('toContainerPosition', () => {
    it('用页面坐标减容器左上角，得到容器内坐标', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      expect(selection.toContainerPosition({ x: 140, y: 120 })).toEqual({ x: 100, y: 100 })
    })

    it('容器量不出矩形（getBoundingClientRect 为空）时坐标原样透传', () => {
      // display:none 等场景下 rect 为 null：走 !rect 兜底分支，不改坐标
      const ctx = makeCtx({ graphContainer: ref({ getBoundingClientRect: () => null }) })
      const selection = useGraphSelection(ctx)

      expect(selection.toContainerPosition({ x: 12, y: 34 })).toEqual({ x: 12, y: 34 })
    })

    it('坐标为 null / undefined 时返回 {0,0}，不读属性不抛错', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      expect(selection.toContainerPosition(null)).toEqual({ x: 0, y: 0 })
      expect(selection.toContainerPosition(undefined)).toEqual({ x: 0, y: 0 })
    })
  })

  describe('handleNodeClickFromCanvas（单击节点）', () => {
    it('连线模式下单击：不改本组件状态，只把节点交给关系抽屉连线流程', () => {
      const handleNodeClickInEdgeMode = vi.fn()
      const ctx = makeCtx({
        relation: { isAddingEdgeMode: true, handleNodeClickInEdgeMode }
      })
      const selection = useGraphSelection(ctx)
      const entity = { entity_id: 'e1' }

      selection.handleNodeClickFromCanvas(entity, { x: 1, y: 2 })

      expect(handleNodeClickInEdgeMode).toHaveBeenCalledTimes(1)
      expect(handleNodeClickInEdgeMode).toHaveBeenCalledWith({ id: 'e1', data: entity })
      expect(selection.selectedEntity).toBeNull()
      vi.advanceTimersByTime(CLICK_DELAY_MS + 10)
      expect(selection.actionPopoverVisible).toBe(false)
    })

    it('连线模式下实体缺 entity_id 时回退 id 传给连线流程', () => {
      const handleNodeClickInEdgeMode = vi.fn()
      const ctx = makeCtx({
        relation: { isAddingEdgeMode: true, handleNodeClickInEdgeMode }
      })
      const selection = useGraphSelection(ctx)

      selection.handleNodeClickFromCanvas({ id: 'legacy' })

      expect(handleNodeClickInEdgeMode).toHaveBeenCalledWith({ id: 'legacy', data: { id: 'legacy' } })
    })

    it('普通单击：先记下选中实体与气泡位置，等 CLICK_DELAY_MS 后弹气泡并选中原节点', () => {
      const closeEdgeActionPopover = vi.fn()
      const ctx = makeCtx({ edgeCrud: { closeEdgeActionPopover } })
      const selection = useGraphSelection(ctx)

      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 150, y: 60 })

      // 延迟未到：位置已更新，但气泡还没弹
      expect(selection.selectedEntity).toEqual({ entity_id: 'n1' })
      expect(selection.actionPopoverPosition).toEqual({ x: 110, y: 40 })
      expect(selection.actionPopoverVisible).toBe(false)

      vi.advanceTimersByTime(CLICK_DELAY_MS)

      expect(selection.actionPopoverVisible).toBe(true)
      expect(closeEdgeActionPopover).toHaveBeenCalledTimes(1)
      expect(ctx.graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['n1'])
    })

    it('节点缺 entity_id 时用 id 选中画布节点', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      selection.handleNodeClickFromCanvas({ id: 'n2' }, null)
      vi.advanceTimersByTime(CLICK_DELAY_MS)

      expect(ctx.graphCanvasRef.value.selectNodes).toHaveBeenCalledWith(['n2'])
    })

    it('CLICK_DELAY_MS 内再次单击（双击前半下）：只重排队计时器，不提前弹泡', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS - 10)
      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })
      // 距第二次点击刚过 CLICK_DELAY_MS：第一条计时器早被清掉，气泡只在这一刻弹
      vi.advanceTimersByTime(CLICK_DELAY_MS)
      expect(selection.actionPopoverVisible).toBe(true)
    })

    it('clearNodeClickTimer：已排队的气泡被取消，时间到了也不弹', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })
      selection.clearNodeClickTimer()
      vi.advanceTimersByTime(CLICK_DELAY_MS + 50)

      expect(selection.actionPopoverVisible).toBe(false)
    })
  })

  describe('handleNodeDoubleClickFromCanvas（双击节点）', () => {
    it('双击：选中实体、取消待弹气泡、收边气泡、开实体编辑抽屉', () => {
      const closeEdgeActionPopover = vi.fn()
      const ctx = makeCtx({ edgeCrud: { closeEdgeActionPopover } })
      const selection = useGraphSelection(ctx)
      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })

      selection.handleNodeDoubleClickFromCanvas({ entity_id: 'n1' })
      vi.advanceTimersByTime(CLICK_DELAY_MS + 50)

      expect(selection.selectedEntity).toEqual({ entity_id: 'n1' })
      expect(selection.actionPopoverVisible).toBe(false)
      expect(closeEdgeActionPopover).toHaveBeenCalledTimes(1)
      expect(ctx.openExclusiveDrawer).toHaveBeenCalledWith('entityEdit')
    })

    it('没有实体（点了空白）时直接返回，不开抽屉', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      selection.handleNodeDoubleClickFromCanvas(null)

      expect(ctx.openExclusiveDrawer).not.toHaveBeenCalled()
    })
  })

  describe('handleEdit（气泡「编辑」按钮）', () => {
    it('先关气泡，再打开实体编辑抽屉', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)
      selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })
      vi.advanceTimersByTime(CLICK_DELAY_MS)

      selection.handleEdit()

      expect(selection.actionPopoverVisible).toBe(false)
      expect(ctx.openExclusiveDrawer).toHaveBeenCalledWith('entityEdit')
    })

    it('没有选中实体时只关气泡，不开抽屉', () => {
      const ctx = makeCtx()
      const selection = useGraphSelection(ctx)

      selection.handleEdit()

      expect(selection.actionPopoverVisible).toBe(false)
      expect(ctx.openExclusiveDrawer).not.toHaveBeenCalled()
    })
  })

  it('closeActionPopover 只关气泡，不影响选中实体', () => {
    const ctx = makeCtx()
    const selection = useGraphSelection(ctx)
    selection.handleNodeClickFromCanvas({ entity_id: 'n1' }, { x: 0, y: 0 })
    vi.advanceTimersByTime(CLICK_DELAY_MS)

    selection.closeActionPopover()

    expect(selection.actionPopoverVisible).toBe(false)
    expect(selection.selectedEntity).toEqual({ entity_id: 'n1' })
  })
})
