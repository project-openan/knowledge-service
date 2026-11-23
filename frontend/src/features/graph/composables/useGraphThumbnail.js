/**
 * useGraphThumbnail —— 左下角缩略图（minimap）快照。
 *
 * 拆分缘由：缩略图快照原先在 GraphVisualization.vue 里占约 130 行：开关状态、
 * 800ms 轮询计时器、从 vis-network 内部结构（body.nodes/body.edges）取坐标、
 * 再做投影换算。投影数学已抽到 lib/graph-thumbnail（纯函数，可单测），
 * 这个 composable 只负责「从 network 取数 + 计时器生命周期」。
 *
 * 行为保持不变：开启时立即刷两次 + 300ms 后补刷一次 + 800ms 轮询（等待 vis 完成
 * 首次布局），关闭时清空快照并停表；画布每次重绘（after-drawing）与节点/边数量
 * 变化时按需刷新。
 */
import { computed, reactive, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import {
  projectThumbnailLayout,
  clampThumbnailViewportRect
} from '../lib/graph-thumbnail'

export function useGraphThumbnail (ctx) {
  const { graphCanvasRef, graphContainer, graphDataCache } = ctx

  const thumbnailEnabled = ref(false)
  const thumbnailSvgNodes = ref([])
  const thumbnailSvgEdges = ref([])
  const thumbnailViewportRect = ref(null)
  let thumbnailRefreshTimer = null

  /** 缩略图上的白底视口高亮（裁剪到 svg 范围内） */
  const clampedThumbnailViewportRect = computed(() => clampThumbnailViewportRect(thumbnailViewportRect.value))

  function clearThumbnailSnapshot () {
    thumbnailSvgNodes.value = []
    thumbnailSvgEdges.value = []
    thumbnailViewportRect.value = null
  }

  function refreshThumbnailSnapshot () {
    if (!thumbnailEnabled.value) {
      return
    }
    if (!graphCanvasRef.value?.getNetwork) {
      return
    }
    const network = graphCanvasRef.value.getNetwork()
    const bodyNodes = network?.body?.nodes || {}
    const bodyEdges = network?.body?.edges || {}
    if (!network || !bodyNodes) {
      return
    }

    const rawNodes = Object.keys(bodyNodes).map((id) => {
      const node = bodyNodes[id]
      const hidden = node?.options?.hidden === true
      const x = Number(node?.x)
      const y = Number(node?.y)
      const entity = (graphDataCache.value.entities || []).find((e) => String(e.entity_id || e.id) === String(id))
      const type = entity?.entity_type || entity?.class
      return {
        id,
        x,
        y,
        hidden,
        color: ctx.tones.colorMap[type] || '#cccccc'
      }
    }).filter((node) => !node.hidden && Number.isFinite(node.x) && Number.isFinite(node.y))

    if (!rawNodes.length) {
      clearThumbnailSnapshot()
      return
    }

    const rawEdges = Object.keys(bodyEdges).map((id) => {
      const edge = bodyEdges[id]
      if (edge?.options?.hidden === true) {
        return null
      }
      const from = edge?.from
      const to = edge?.to
      return {
        id,
        x1: Number(from?.x),
        y1: Number(from?.y),
        x2: Number(to?.x),
        y2: Number(to?.y)
      }
    }).filter(Boolean)

    const view = typeof network.getViewPosition === 'function' ? network.getViewPosition() : null
    const zoomScale = typeof network.getScale === 'function' ? network.getScale() : 1
    const containerWidth = graphContainer.value?.clientWidth || 0
    const containerHeight = graphContainer.value?.clientHeight || 0

    const projection = projectThumbnailLayout({
      rawNodes,
      rawEdges,
      view,
      zoomScale,
      containerWidth,
      containerHeight
    })
    if (!projection) {
      clearThumbnailSnapshot()
      return
    }
    thumbnailSvgNodes.value = projection.nodes
    thumbnailSvgEdges.value = projection.edges
    thumbnailViewportRect.value = projection.viewportRect
  }

  function stopThumbnailTimer () {
    if (thumbnailRefreshTimer) {
      clearInterval(thumbnailRefreshTimer)
      thumbnailRefreshTimer = null
    }
  }

  function toggleThumbnail () {
    thumbnailEnabled.value = !thumbnailEnabled.value
    if (!thumbnailEnabled.value) {
      clearThumbnailSnapshot()
      stopThumbnailTimer()
      return
    }
    nextTick(() => {
      refreshThumbnailSnapshot()
      setTimeout(() => {
        refreshThumbnailSnapshot()
      }, 0)
      setTimeout(() => {
        refreshThumbnailSnapshot()
      }, 300)
      stopThumbnailTimer()
      thumbnailRefreshTimer = setInterval(() => {
        refreshThumbnailSnapshot()
      }, 800)
    })
  }

  /** 画布重绘完成回调：缩略图开启时刷新快照 */
  function handleCanvasAfterDrawing () {
    if (!thumbnailEnabled.value) {
      return
    }
    nextTick(() => {
      refreshThumbnailSnapshot()
    })
  }

  // 节点/边数量变化（增量增删、刷新）时同步缩略图
  watch(
    () => [graphDataCache.value.entities?.length, graphDataCache.value.edges?.length],
    () => {
      if (thumbnailEnabled.value) {
        nextTick(() => {
          refreshThumbnailSnapshot()
        })
      }
    }
  )

  onBeforeUnmount(() => {
    stopThumbnailTimer()
    clearThumbnailSnapshot()
  })

  return reactive({
    thumbnailEnabled,
    thumbnailSvgNodes,
    thumbnailSvgEdges,
    clampedThumbnailViewportRect,
    clearThumbnailSnapshot,
    refreshThumbnailSnapshot,
    toggleThumbnail,
    handleCanvasAfterDrawing
  })
}
