// @vitest-environment jsdom
/**
 * useGraphViewport —— 画布视野控制（缩放 / 居中 / 适配 / 图例 / 连线标签模式）。
 *
 * 组件里所有画布动作都先判「子组件方法在不在」再调（ref 可能还没挂上），
 * 所以两条分支都要钉住；缩放变化时缩略图按需刷新（thumbnailEnabled 才刷）。
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { computeBoundingBoxCenter } from '@/features/graph/lib/graph-geometry'
import { useGraphViewport } from '@/features/graph/composables/useGraphViewport'

function makeCanvas (methods = {}) {
  return ref({ ...methods })
}

describe('useGraphViewport', () => {
  it('zoomIn / zoomOut / resetZoom：画布方法存在时透传调用', () => {
    const zoomIn = vi.fn()
    const zoomOut = vi.fn()
    const resetZoom = vi.fn()
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ zoomIn, zoomOut, resetZoom }) })

    viewport.zoomIn()
    viewport.zoomOut()
    viewport.resetZoom()

    expect(zoomIn).toHaveBeenCalledTimes(1)
    expect(zoomOut).toHaveBeenCalledTimes(1)
    expect(resetZoom).toHaveBeenCalledTimes(1)
  })

  it('画布方法不存在（未挂载）时调用是安全的空操作', () => {
    const viewport = useGraphViewport({ graphCanvasRef: ref({}) })

    expect(() => {
      viewport.zoomIn()
      viewport.zoomOut()
      viewport.resetZoom()
      viewport.applyZoomScale(2)
      viewport.fitView()
      viewport.fitViewImmediate()
    }).not.toThrow()
  })

  it('setZoomByPercent：合法百分比关闭下拉并按 scale 设置（200 → 2）', () => {
    const setZoomScale = vi.fn()
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ setZoomScale }) })
    viewport.zoomOptionsVisible = true

    viewport.setZoomByPercent('200')

    expect(viewport.zoomOptionsVisible).toBe(false)
    expect(setZoomScale).toHaveBeenCalledWith(2)
  })

  it.each([NaN, 0, -50, 'abc', Infinity])('%s 这类非法百分比不触发缩放，也不关下拉', (bad) => {
    const setZoomScale = vi.fn()
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ setZoomScale }) })
    viewport.zoomOptionsVisible = true

    viewport.setZoomByPercent(bad)

    expect(setZoomScale).not.toHaveBeenCalled()
    expect(viewport.zoomOptionsVisible).toBe(true)
  })

  describe('centerGraph（保持缩放、只平移到图心）', () => {
    function makeNetwork (positions) {
      return {
        getPositions: () => positions,
        moveTo: vi.fn()
      }
    }

    it('无 getNetwork 方法时直接返回', () => {
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({}) })
      expect(() => viewport.centerGraph()).not.toThrow()
    })

    it('network 为 null 时直接返回', () => {
      const canvas = makeCanvas({ getNetwork: () => null })
      const viewport = useGraphViewport({ graphCanvasRef: canvas })
      expect(() => viewport.centerGraph()).not.toThrow()
    })

    it('包围盒求心失败（无有效坐标）时不调用 moveTo', () => {
      const network = makeNetwork({ n1: { x: NaN, y: NaN } })
      const thumbnail = { handleCanvasAfterDrawing: vi.fn() }
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ getNetwork: () => network }), thumbnail })

      viewport.centerGraph()

      expect(network.moveTo).not.toHaveBeenCalled()
    })

    it('有节点坐标时平移到包围盒中心，动画开启，且 nextTick 后刷新缩略图', async () => {
      const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 40 } }
      const network = makeNetwork(positions)
      const handleCanvasAfterDrawing = vi.fn()
      const viewport = useGraphViewport({
        graphCanvasRef: makeCanvas({ getNetwork: () => network }),
        thumbnail: { handleCanvasAfterDrawing }
      })

      viewport.centerGraph()

      expect(network.moveTo).toHaveBeenCalledWith({
        position: computeBoundingBoxCenter(positions),
        animation: true
      })
      await nextTick()
      expect(handleCanvasAfterDrawing).toHaveBeenCalledTimes(1)
    })
  })

  it('resetGraphLayout = 回 100% + 适配视口', () => {
    const resetZoom = vi.fn()
    const fit = vi.fn()
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ resetZoom, fit }) })

    viewport.resetGraphLayout()

    expect(resetZoom).toHaveBeenCalledTimes(1)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('两个下拉互斥：开预设比例收连线模式，反之亦然', () => {
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({}) })

    viewport.toggleZoomOptions()
    expect(viewport.zoomOptionsVisible).toBe(true)
    expect(viewport.lineModeOptionsVisible).toBe(false)

    viewport.toggleLineModeOptions()
    expect(viewport.lineModeOptionsVisible).toBe(true)
    expect(viewport.zoomOptionsVisible).toBe(false)

    viewport.closeZoomMenus()
    expect(viewport.zoomOptionsVisible).toBe(false)
    expect(viewport.lineModeOptionsVisible).toBe(false)
  })

  it('toggleLegend 切换图例开关', () => {
    const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({}) })
    expect(viewport.legendVisible).toBe(false)
    viewport.toggleLegend()
    expect(viewport.legendVisible).toBe(true)
    viewport.toggleLegend()
    expect(viewport.legendVisible).toBe(false)
  })

  describe('连线标签模式', () => {
    it('setEdgeLabelMode：inline / hover 落到画布，其余值一律当 inline，并收起下拉', () => {
      const setEdgeLabelMode = vi.fn()
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ setEdgeLabelMode }) })
      viewport.lineModeOptionsVisible = true

      viewport.setEdgeLabelMode('inline')
      expect(viewport.edgeLabelDisplayMode).toBe('inline')
      expect(viewport.lineModeOptionsVisible).toBe(false)

      viewport.lineModeOptionsVisible = true
      viewport.setEdgeLabelMode('hover')
      expect(viewport.edgeLabelDisplayMode).toBe('hover')

      viewport.setEdgeLabelMode('whatever')
      expect(viewport.edgeLabelDisplayMode).toBe('inline')

      expect(setEdgeLabelMode).toHaveBeenCalledTimes(3)
    })

    it('handleEdgeLabelModeChange 是 setEdgeLabelMode 的别名（radio change 事件用）', () => {
      const setEdgeLabelMode = vi.fn()
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ setEdgeLabelMode }) })

      viewport.handleEdgeLabelModeChange('hover')
      expect(viewport.edgeLabelDisplayMode).toBe('hover')
    })

    it('toggleEdgeLabels：勾选 → inline，取消 → hover', () => {
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({}) })

      viewport.toggleEdgeLabels(true)
      expect(viewport.edgeLabelDisplayMode).toBe('inline')
      viewport.toggleEdgeLabels(false)
      expect(viewport.edgeLabelDisplayMode).toBe('hover')
    })

    it('edgeLabelDisplayMode 变化经 watch 同步给画布（切模式即改画布，不等下次交互）', async () => {
      const setEdgeLabelMode = vi.fn()
      const viewport = useGraphViewport({ graphCanvasRef: makeCanvas({ setEdgeLabelMode }) })

      viewport.edgeLabelDisplayMode = 'inline'
      await nextTick()

      expect(setEdgeLabelMode).toHaveBeenCalledWith('inline')
    })
  })

  describe('onVisZoomChange（画布上报缩放）', () => {
    it('有限 scale 更新百分比文本', async () => {
      const refreshThumbnailSnapshot = vi.fn()
      const viewport = useGraphViewport({
        graphCanvasRef: makeCanvas({}),
        thumbnail: { thumbnailEnabled: false, refreshThumbnailSnapshot }
      })

      viewport.onVisZoomChange(1.234)
      expect(viewport.zoomLevel).toBe(123)

      viewport.onVisZoomChange(NaN)
      expect(viewport.zoomLevel).toBe(123)
    })

    it('缩略图开启时 nextTick 后刷新快照；关闭时不刷', async () => {
      const refreshThumbnailSnapshot = vi.fn()
      const enabled = useGraphViewport({
        graphCanvasRef: makeCanvas({}),
        thumbnail: { thumbnailEnabled: true, refreshThumbnailSnapshot }
      })
      const disabled = useGraphViewport({
        graphCanvasRef: makeCanvas({}),
        thumbnail: { thumbnailEnabled: false, refreshThumbnailSnapshot }
      })

      enabled.onVisZoomChange(1)
      disabled.onVisZoomChange(1)
      await nextTick()

      expect(refreshThumbnailSnapshot).toHaveBeenCalledTimes(1)
    })
  })
})
