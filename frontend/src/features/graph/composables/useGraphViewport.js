/**
 * useGraphViewport —— 画布视野控制：缩放、居中、适配、图例开关与连线标签显示模式。
 *
 * 拆分缘由：原先左下角缩放工具簇（zoomIn/out/reset、预设比例、居中、fit）和
 * 「关系名称」显示模式（inline/hover）的状态与函数横跨 GraphVisualization.vue 的
 * 模板与 script 两处约 150 行。收进一个 composable 后，模板里的缩放工具簇与图例
 * 拆到 components/graph-visualization/GraphCanvasTools.vue，主文件只保留组合与绑定。
 *
 * 行为保持不变：
 * - 居中只平移不改缩放（与 fitView 的全图适配区分）；
 * - 缩放变化时若缩略图开启则刷新快照；
 * - edgeLabelDisplayMode 变化同步给 GraphCanvasVis.setEdgeLabelMode。
 */
import { reactive, ref, watch, nextTick } from 'vue'
import { computeBoundingBoxCenter } from '../lib/graph-geometry'

export function useGraphViewport (ctx) {
  const { graphCanvasRef } = ctx

  const zoomLevel = ref(100)
  const zoomPresetOptions = [25, 50, 75, 100, 200]
  const zoomOptionsVisible = ref(false)
  const lineModeOptionsVisible = ref(false)
  const legendVisible = ref(false)

  // 「关系名称」默认不勾选（悬浮边时才看标签）
  const edgeLabelDisplayMode = ref('hover')

  // 缩放控制（vis 画布）
  function zoomIn () {
    if (graphCanvasRef.value?.zoomIn) {
      graphCanvasRef.value.zoomIn()
    }
  }

  function zoomOut () {
    if (graphCanvasRef.value?.zoomOut) {
      graphCanvasRef.value.zoomOut()
    }
  }

  function resetZoom () {
    if (graphCanvasRef.value?.resetZoom) {
      graphCanvasRef.value.resetZoom()
    }
  }

  /** 直接按比例设置缩放（预设比例按钮用） */
  function applyZoomScale (scale) {
    if (graphCanvasRef.value?.setZoomScale) {
      graphCanvasRef.value.setZoomScale(scale)
    }
  }

  function setZoomByPercent (percent) {
    const p = Number(percent)
    if (!Number.isFinite(p) || p <= 0) {
      return
    }
    zoomOptionsVisible.value = false
    applyZoomScale(p / 100)
  }

  /**
   * 居中：保持当前缩放，仅平移使图心（节点包围盒中心）对准视口中心，便于在放大后找回图心。
   * 与 fitView（全屏适配）不同，不会改变缩放比例。
   */
  function centerGraph () {
    if (!graphCanvasRef.value?.getNetwork) {
      return
    }
    const network = graphCanvasRef.value.getNetwork()
    if (!network) {
      return
    }
    const center = computeBoundingBoxCenter(network.getPositions())
    if (!center) {
      return
    }
    network.moveTo({
      position: center,
      animation: true
    })
    nextTick(() => {
      ctx.thumbnail?.handleCanvasAfterDrawing()
    })
  }

  /** 全屏适配：缩放并平移，使全部节点进入视野（vis-network 的 fit） */
  function fitView () {
    if (graphCanvasRef.value?.fit) {
      graphCanvasRef.value.fit()
    }
  }

  /** 查询结果落定后的无动画适配（见 GraphCanvasVis.fitImmediate 的说明）。 */
  function fitViewImmediate () {
    if (graphCanvasRef.value?.fitImmediate) {
      graphCanvasRef.value.fitImmediate()
    }
  }

  /** 摘要行的「重置布局」：回到 100% 并适配视口。 */
  function resetGraphLayout () {
    resetZoom()
    fitView()
  }

  /** 点画布空白处收起两个下拉（预设比例 / 连线模式） */
  function closeZoomMenus () {
    zoomOptionsVisible.value = false
    lineModeOptionsVisible.value = false
  }

  function toggleLegend () {
    legendVisible.value = !legendVisible.value
  }

  function toggleZoomOptions () {
    zoomOptionsVisible.value = !zoomOptionsVisible.value
    lineModeOptionsVisible.value = false
  }

  function toggleLineModeOptions () {
    lineModeOptionsVisible.value = !lineModeOptionsVisible.value
    zoomOptionsVisible.value = false
  }

  function setEdgeLabelMode (mode) {
    edgeLabelDisplayMode.value = mode === 'hover' ? 'hover' : 'inline'
    if (graphCanvasRef.value?.setEdgeLabelMode) {
      graphCanvasRef.value.setEdgeLabelMode(edgeLabelDisplayMode.value)
    }
    lineModeOptionsVisible.value = false
  }

  function handleEdgeLabelModeChange (mode) {
    setEdgeLabelMode(mode)
  }

  /** 摘要行的「关系名称」开关：勾选 = 连线旁常显标签，取消 = 悬停显示。 */
  function toggleEdgeLabels (value) {
    setEdgeLabelMode(value ? 'inline' : 'hover')
  }

  // 画布上报缩放比例（含拖拽缩放）：更新百分比文本并按需刷新缩略图快照
  function onVisZoomChange (scale) {
    if (Number.isFinite(scale)) {
      zoomLevel.value = Math.round(scale * 100)
    }
    if (ctx.thumbnail?.thumbnailEnabled) {
      nextTick(() => {
        ctx.thumbnail.refreshThumbnailSnapshot()
      })
    }
  }

  watch(edgeLabelDisplayMode, (mode) => {
    if (graphCanvasRef.value?.setEdgeLabelMode) {
      graphCanvasRef.value.setEdgeLabelMode(mode)
    }
  })

  return reactive({
    zoomLevel,
    zoomPresetOptions,
    zoomOptionsVisible,
    lineModeOptionsVisible,
    legendVisible,
    edgeLabelDisplayMode,
    zoomIn,
    zoomOut,
    resetZoom,
    applyZoomScale,
    setZoomByPercent,
    centerGraph,
    fitView,
    fitViewImmediate,
    resetGraphLayout,
    closeZoomMenus,
    toggleLegend,
    toggleZoomOptions,
    toggleLineModeOptions,
    setEdgeLabelMode,
    handleEdgeLabelModeChange,
    toggleEdgeLabels,
    onVisZoomChange
  })
}
