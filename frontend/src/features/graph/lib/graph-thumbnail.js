/**
 * 缩略图（minimap）的坐标换算纯函数。
 *
 * 拆分缘由：原先 refreshThumbnailSnapshot 里有一大段「世界坐标 → 260x150 缩略图坐标」
 * 的仿射投影 + 视口矩形裁剪数学（GraphVisualization.vue 约 1690-1747 行），夹在
 * vis-network 取数、定时器管理之间，既难读也难测。这里把纯数学部分抽出来：
 * 入参是已从 network 取好的节点/边坐标与视口信息，出参是 SVG 坐标，零 DOM 依赖，
 * 后续单测可以直接喂固定坐标断言投影结果。
 */

/** 缩略图尺寸（与模板里 svg viewBox 一致），视口矩形裁剪在画布内 */
export const THUMBNAIL_SVG_W = 260
export const THUMBNAIL_SVG_H = 150

/** 缩略图四周留白（世界包围盒到 svg 边缘的最小间距） */
const THUMBNAIL_PAD = 8

/**
 * 把世界坐标的节点/边投影到缩略图坐标系。
 *
 * @param {Object} payload
 * @param {Array}  payload.rawNodes  - [{ id, x, y, color }]，已过滤 hidden / 非有限坐标
 * @param {Array}  payload.rawEdges  - [{ id, x1, y1, x2, y2 }]（世界坐标端点）
 * @param {Object|null} payload.view - network.getViewPosition() 的结果（视口中心，世界坐标）
 * @param {number} payload.zoomScale - network.getScale()
 * @param {number} payload.containerWidth  - 主画布容器宽（像素）
 * @param {number} payload.containerHeight - 主画布容器高（像素）
 * @returns {Object|null} { nodes, edges, viewportRect }；rawNodes 为空时返回 null（调用方据此清空快照）
 */
export function projectThumbnailLayout ({ rawNodes, rawEdges, view, zoomScale, containerWidth, containerHeight }) {
  if (!rawNodes.length) {
    return null
  }

  const width = THUMBNAIL_SVG_W
  const height = THUMBNAIL_SVG_H
  const minX = Math.min(...rawNodes.map((node) => node.x))
  const maxX = Math.max(...rawNodes.map((node) => node.x))
  const minY = Math.min(...rawNodes.map((node) => node.y))
  const maxY = Math.max(...rawNodes.map((node) => node.y))
  const graphWidth = Math.max(1, maxX - minX)
  const graphHeight = Math.max(1, maxY - minY)
  const scale = Math.min((width - THUMBNAIL_PAD * 2) / graphWidth, (height - THUMBNAIL_PAD * 2) / graphHeight)
  const offsetX = (width - graphWidth * scale) / 2 - minX * scale
  const offsetY = (height - graphHeight * scale) / 2 - minY * scale
  const mapX = (x) => x * scale + offsetX
  const mapY = (y) => y * scale + offsetY

  const nodes = rawNodes.map((node) => ({
    id: node.id,
    x: mapX(node.x),
    y: mapY(node.y),
    color: node.color
  }))

  const edges = rawEdges
    .map((edge) => ({
      id: edge.id,
      x1: mapX(edge.x1),
      y1: mapY(edge.y1),
      x2: mapX(edge.x2),
      y2: mapY(edge.y2)
    }))
    .filter((edge) => edge && [edge.x1, edge.y1, edge.x2, edge.y2].every(Number.isFinite))

  // 当前主画布视口在缩略图上的白底高亮矩形（跟随缩放比例换算宽高）
  let viewportRect = null
  if (view && Number.isFinite(zoomScale) && zoomScale > 0 && containerWidth > 0 && containerHeight > 0) {
    const halfW = (containerWidth / zoomScale) / 2
    const halfH = (containerHeight / zoomScale) / 2
    viewportRect = {
      x: mapX(view.x - halfW),
      y: mapY(view.y - halfH),
      width: Math.max(1, containerWidth * scale / zoomScale),
      height: Math.max(1, containerHeight * scale / zoomScale)
    }
  }

  return { nodes, edges, viewportRect }
}

/**
 * 将视口矩形限制在缩略图范围内，供白底高亮使用；
 * 视口完全在图外 / 被裁到不足 1px 时返回 null（不渲染高亮）。
 */
export function clampThumbnailViewportRect (rect) {
  const v = rect
  if (!v) {
    return null
  }
  let x = Number(v.x)
  let y = Number(v.y)
  let w = Number(v.width)
  let h = Number(v.height)
  if (![x, y, w, h].every(Number.isFinite)) {
    return null
  }
  x = Math.max(0, x)
  y = Math.max(0, y)
  w = Math.max(0, w)
  h = Math.max(0, h)
  if (x >= THUMBNAIL_SVG_W || y >= THUMBNAIL_SVG_H) {
    return null
  }
  w = Math.min(w, THUMBNAIL_SVG_W - x)
  h = Math.min(h, THUMBNAIL_SVG_H - y)
  if (w < 1 || h < 1) {
    return null
  }
  return { x, y, width: w, height: h }
}
