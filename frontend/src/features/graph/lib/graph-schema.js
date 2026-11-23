/**
 * 图谱 schema / 数据规整的纯函数集合。
 *
 * 拆分缘由：这些逻辑原先内联在 GraphVisualization.vue 的 2060 行 script 里
 * （schemaMapping 的属性映射、边属性定义查找、BOOLEAN 值规整、可用边类型推导等），
 * 与组件状态耦合在一起导致无法单测。抽到 lib 后它们只吃入参、吐结果，
 * 后续补单测不需要挂载组件（见 vitest include `tests/unit/**`，jsdom 才挂组件）。
 */

/**
 * 图谱相关接口成功判定：
 * - 仅在明确返回失败时视为失败（success === false）
 * - API 2.0 的成功响应不带 success 字段，按成功处理
 */
export function isGraphApiSuccess (response) {
  if (!response) {
    return false
  }
  if (response.success === false) {
    return false
  }
  return true
}

/** 新建关系成功后，用返回值保证即使查询被 limit 截断也能看到新边。 */
export function buildEnsureEdgePayload (relation) {
  if (!relation?.edgeId || !relation?.edgeType || !relation?.sourceId || !relation?.targetId) {
    return []
  }
  return [{
    edge_id: relation.edgeId,
    edge_type: relation.edgeType,
    source_id: relation.sourceId,
    target_id: relation.targetId,
    properties: relation.properties || {}
  }]
}

/** 实体 id 归一：后端字段可能是 entity_id 或 id。 */
export function entityKey (entity) {
  return entity?.entity_id ?? entity?.id
}

/**
 * 从数据里收集去重后的类型名（实体类型 / 边类型共用一套去重逻辑）。
 * 与画布 group 口径一致：优先 entity_type / edge_type，缺省回退 class。
 */
export function collectDataTypes (list, primaryField) {
  const types = new Set()
  list?.forEach((item) => {
    const type = item?.[primaryField] || item?.class
    if (type) {
      types.add(type)
    }
  })
  return Array.from(types)
}

/** entity_meta → { 类型: 属性定义数组 }，供 GraphControls 渲染实体属性筛选。 */
export function collectEntityTypeProperties (entityMeta) {
  const result = {}
  Object.keys(entityMeta || {}).forEach((type) => {
    result[type] = entityMeta[type]?.properties || []
  })
  return result
}

/**
 * adjacency_map → { 边类型: 合并去重后的属性定义数组 }。
 * 同一条边类型会在多对实体间重复出现，按属性名去重（property_name/name/code/prop 任一非空即视为有名字）。
 */
export function collectEdgeTypeProperties (adjacencyMap) {
  const result = {}
  Object.values(adjacencyMap || {}).forEach(targetMap => {
    if (!targetMap) {
      return
    }
    Object.values(targetMap).forEach(edges => {
      if (!Array.isArray(edges)) {
        return
      }
      edges.forEach(edge => {
        if (!edge || !edge.edge_type) {
          return
        }
        const existing = result[edge.edge_type] || []
        const newProps = Array.isArray(edge.properties) ? edge.properties : []
        const merged = [...existing]
        newProps.forEach(prop => {
          const propName = prop?.property_name || prop?.name || prop?.code || prop?.prop
          if (!propName) {
            merged.push(prop)
            return
          }
          if (!merged.find(item => (item?.property_name || item?.name || item?.code || item?.prop) === propName)) {
            merged.push(prop)
          }
        })
        result[edge.edge_type] = merged
      })
    })
  })
  return result
}

/** 在 adjacency_map 里查某边类型某属性的定义（找不到返回 null）。 */
export function findEdgePropertyDef (adjacencyMap, edgeType, propName) {
  if (!edgeType || !propName) {
    return null
  }
  for (const sourceMap of Object.values(adjacencyMap || {})) {
    for (const edges of Object.values(sourceMap || {})) {
      if (Array.isArray(edges)) {
        const found = edges.find(e => e.edge_type === edgeType)
        if (found) {
          const propsArr = found.properties || []
          return propsArr.find(p => p.name === propName) || null
        }
      }
    }
  }
  return null
}

/**
 * 转换 BOOLEAN 属性值（用于下发到后端）：
 * 表单里勾选的是字符串 'true'/'false'，清空为 ''，按 schema 定义翻译回布尔 / null。
 */
export function convertBooleanProperties (properties, propDefGetter, typeOrEntityType) {
  if (!properties) {
    return {}
  }
  const result = { ...properties }
  Object.keys(result).forEach(key => {
    const propDef = propDefGetter(typeOrEntityType, key)
    if (propDef?.type === 'BOOLEAN') {
      if (result[key] === 'true') {
        result[key] = true
      } else if (result[key] === 'false') {
        result[key] = false
      } else if (result[key] === '') {
        result[key] = null
      }
    }
  })
  return result
}

/** 根据实体类型 A/B 取 adjacency_map 里可用的边类型定义列表。 */
export function getEdgeTypesForEntities (schemaMapping, entityTypeA, entityTypeB) {
  if (!schemaMapping || !schemaMapping.adjacency_map) {
    console.warn('🔗 没有找到映射数据')
    return []
  }

  const adjacencyMap = schemaMapping.adjacency_map
  const edgeTypes = []

  if (adjacencyMap[entityTypeA] && adjacencyMap[entityTypeA][entityTypeB]) {
    adjacencyMap[entityTypeA][entityTypeB].forEach(edge => {
      edgeTypes.push({
        edge_type: edge.edge_type,
        edge_desc: edge.edge_desc,
        direction: edge.direction,
        properties: edge.properties || []
      })
    })
  }

  return edgeTypes
}
