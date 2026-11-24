/**
 * 图谱「实体展开/收起」的图计算纯函数。
 *
 * 拆分缘由：展开/收起的核心是「沿出向边收集子孙」这一段图遍历，原先内联在
 * GraphVisualization.vue（约 2377-2417 行），和组件的 UI 状态（Map/Set 替换触发更新）
 * 搅在一起。遍历本身与 Vue 无关，抽成纯函数后可以直接单测（环、缺失目标节点等边界），
 * 组件里的 composable（useEntityExpand）只负责把结果落到画布可见性上。
 */

/**
 * 递归获取指定实体的所有出向子实体（子孙节点）
 * @param {string} entityId - 起始实体 ID
 * @param {Array} edges - 边数组
 * @param {Array} entities - 实体数组
 * @returns {Array} 所有出向子实体数组
 */
export function getOutgoingDescendants (entityId, edges, entities) {
  const descendants = []
  const visited = new Set()

  function dfs (currentId) {
    const cur = String(currentId)
    if (visited.has(cur)) {
      return
    }
    visited.add(cur)

    const outgoingEdges = edges.filter(e => {
      const sourceId = e.source_id || e.source
      return String(sourceId) === cur
    })

    outgoingEdges.forEach(edge => {
      const targetId = edge.target_id || edge.target
      const tStr = String(targetId)
      if (!visited.has(tStr)) {
        const targetEntity = entities.find(e => {
          const eid = e.entity_id || e.id
          return String(eid) === tStr
        })
        if (targetEntity) {
          descendants.push(targetEntity)
          dfs(targetId)
        }
      }
    })
  }

  dfs(entityId)
  return descendants
}

/** 是否存在以该 id 为 source 的出向边（用于展开后中间节点显示减号） */
export function hasOutgoingEdgeFrom (nodeId, edges) {
  const sid = String(nodeId)
  return edges.some((e) => String(e.source_id || e.source) === sid)
}
