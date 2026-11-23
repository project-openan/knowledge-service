/**
 * 画布几何换算的纯函数与共享常量。
 *
 * 拆分缘由：原先「居中」的包围盒求心逻辑内联在 GraphVisualization.vue 的 centerGraph
 * （约 1924-1968 行），CLICK_DELAY_MS 这类跨职责共享的常量则埋在组件状态区。
 * 抽到 lib 后：几何计算可以独立单测，两个 composable（选中 / 边 CRUD）共享同一份
 * 单击延迟常量而不用互相 import 组件内部状态。
 */

/**
 * vis 画布单击延迟：单击要等一段时间确认不是双击的前半下，
 * 才弹出操作气泡（否则气泡会挡住第二次点击导致双击失效）。
 */
export const CLICK_DELAY_MS = 280

/**
 * 由 vis-network getPositions() 的坐标表求图心（节点包围盒中心）。
 * 忽略非有限坐标；没有任何有效节点时返回 null（调用方据此跳过 moveTo）。
 *
 * @param {Object} posMap - { [nodeId]: { x, y } }
 * @returns {{ x: number, y: number } | null}
 */
export function computeBoundingBoxCenter (posMap) {
  const keys = Object.keys(posMap || {})
  if (keys.length === 0) {
    return null
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  keys.forEach((k) => {
    const p = posMap[k]
    if (!p) {
      return
    }
    const x = typeof p.x === 'number' ? p.x : Number(p.x)
    const y = typeof p.y === 'number' ? p.y : Number(p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return
    }
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  })
  if (!Number.isFinite(minX)) {
    return null
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2
  }
}
