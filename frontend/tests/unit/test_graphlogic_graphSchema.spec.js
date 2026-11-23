// 图谱 schema 规整纯函数的全分支单测（lib/graph-schema.js）。
// 这些函数原先内联在 GraphVisualization.vue 里，抽到 lib 后零 DOM 依赖，node 环境直测。
import {
  isGraphApiSuccess,
  buildEnsureEdgePayload,
  entityKey,
  collectDataTypes,
  collectEntityTypeProperties,
  collectEdgeTypeProperties,
  findEdgePropertyDef,
  convertBooleanProperties,
  getEdgeTypesForEntities
} from '@/features/graph/lib/graph-schema'

describe('isGraphApiSuccess', () => {
  it('空响应视为失败', () => {
    expect(isGraphApiSuccess(null)).toBe(false)
    expect(isGraphApiSuccess(undefined)).toBe(false)
  })

  it('显式 success===false 视为失败；其余（含不带 success 字段）视为成功', () => {
    expect(isGraphApiSuccess({ success: false })).toBe(false)
    expect(isGraphApiSuccess({ success: true })).toBe(true)
    expect(isGraphApiSuccess({ data: 1 })).toBe(true)
  })
})

describe('buildEnsureEdgePayload', () => {
  it('四元信息缺一即返回空数组', () => {
    expect(buildEnsureEdgePayload(null)).toEqual([])
    expect(buildEnsureEdgePayload({})).toEqual([])
    expect(buildEnsureEdgePayload({ edgeId: 'e1', edgeType: 'T', sourceId: 'a' })).toEqual([])
    expect(buildEnsureEdgePayload({ edgeId: 'e1', edgeType: 'T', sourceId: 'a', targetId: '' })).toEqual([])
  })

  it('齐全时产出 ensure 边载荷，properties 缺省为空对象', () => {
    expect(buildEnsureEdgePayload({ edgeId: 'e1', edgeType: 'T', sourceId: 'a', targetId: 'b' }))
      .toEqual([{ edge_id: 'e1', edge_type: 'T', source_id: 'a', target_id: 'b', properties: {} }])
    expect(buildEnsureEdgePayload({
      edgeId: 'e1', edgeType: 'T', sourceId: 'a', targetId: 'b', properties: { k: 1 }
    })[0].properties).toEqual({ k: 1 })
  })
})

describe('entityKey', () => {
  it('优先 entity_id，回退 id，双缺返回 undefined', () => {
    expect(entityKey({ entity_id: 'e-1', id: 'x' })).toBe('e-1')
    expect(entityKey({ id: 'x' })).toBe('x')
    expect(entityKey({})).toBeUndefined()
    expect(entityKey(null)).toBeUndefined()
  })
})

describe('collectDataTypes', () => {
  it('按主字段收集并去重，缺主字段回退 class', () => {
    const list = [
      { entity_type: 'Term', class: 'Cls' },
      { entity_type: 'Term' },
      { class: 'Cls' },
      { class: 'Edge' },
      {}
    ]
    expect(collectDataTypes(list, 'entity_type')).toEqual(['Term', 'Cls', 'Edge'])
  })

  it('空/缺失列表返回空数组', () => {
    expect(collectDataTypes(null, 'edge_type')).toEqual([])
    expect(collectDataTypes([], 'edge_type')).toEqual([])
  })
})

describe('collectEntityTypeProperties', () => {
  it('entity_meta → { 类型: 属性数组 }；缺 properties 回退空数组', () => {
    expect(collectEntityTypeProperties(null)).toEqual({})
    expect(collectEntityTypeProperties({
      Term: { properties: [{ name: 'n' }] },
      Bad: {}
    })).toEqual({ Term: [{ name: 'n' }], Bad: [] })
  })
})

describe('collectEdgeTypeProperties', () => {
  it('缺失/形态不合法的入参安全返回', () => {
    expect(collectEdgeTypeProperties(null)).toEqual({})
    expect(collectEdgeTypeProperties({ A: null })).toEqual({})
    expect(collectEdgeTypeProperties({ A: { B: 'not-array' } })).toEqual({})
    expect(collectEdgeTypeProperties({ A: { B: [null, { properties: [] }] } })).toEqual({})
  })

  it('同名属性按 property_name/name/code/prop 去重，无名属性直接追加', () => {
    const adjacencyMap = {
      Person: {
        Company: [
          {
            edge_type: 'WorksFor',
            properties: [
              { property_name: 'since', label: 'a' },
              { name: 'role' },
              { code: 'since' },
              { prop: 'extra' },
              {},
              { property_name: 'since' }
            ]
          }
        ]
      },
      Other: {
        Company: [
          { edge_type: 'WorksFor', properties: [{ name: 'role' }, { other: 1 }] },
          { edge_type: 'OtherEdge', properties: [{ name: 'x' }] }
        ]
      }
    }
    const result = collectEdgeTypeProperties(adjacencyMap)
    expect(Object.keys(result).sort()).toEqual(['OtherEdge', 'WorksFor'])
    const names = result.WorksFor.map(p => p.property_name || p.name || p.code || p.prop)
    // 'since' 只出现一次（第二次同名被丢弃）；无名属性（{}）被原样保留
    expect(names.filter(n => n === 'since').length).toBe(1)
    expect(result.WorksFor).toHaveLength(5)
  })
})

describe('findEdgePropertyDef', () => {
  const adjacencyMap = {
    A: {
      B: [
        { edge_type: 'X', properties: [{ name: 'p1', type: 'STRING' }] },
        { edge_type: 'Y', properties: [{ name: 'p2', type: 'BOOLEAN' }] }
      ]
    }
  }

  it('参数缺失返回 null', () => {
    expect(findEdgePropertyDef(adjacencyMap, '', 'p1')).toBeNull()
    expect(findEdgePropertyDef(adjacencyMap, 'X', '')).toBeNull()
    expect(findEdgePropertyDef(null, 'X', 'p1')).toBeNull()
  })

  it('命中边类型后按属性名取定义；找不到属性/边类型返回 null', () => {
    expect(findEdgePropertyDef(adjacencyMap, 'X', 'p1')).toEqual({ name: 'p1', type: 'STRING' })
    expect(findEdgePropertyDef(adjacencyMap, 'X', 'nope')).toBeNull()
    expect(findEdgePropertyDef(adjacencyMap, 'Z', 'p1')).toBeNull()
  })

  it('非数组 edges 被跳过', () => {
    expect(findEdgePropertyDef({ A: { B: 'bad' }, C: { D: [{ edge_type: 'X', properties: [{ name: 'p1' }] }] } }, 'X', 'p1'))
      .toEqual({ name: 'p1' })
  })
})

describe('convertBooleanProperties', () => {
  it('空 properties 原样返回空对象', () => {
    expect(convertBooleanProperties(null, () => ({}), 'T')).toEqual({})
    expect(convertBooleanProperties(undefined, () => ({}), 'T')).toEqual({})
  })

  it('BOOLEAN 定义下字符串 true/false/空 译回布尔/null；非 BOOLEAN 不动', () => {
    const propDefs = {
      flag: { type: 'BOOLEAN' },
      maybe: { type: 'BOOLEAN' },
      cleared: { type: 'BOOLEAN' },
      text: { type: 'STRING' }
    }
    const result = convertBooleanProperties(
      { flag: 'true', maybe: 'false', cleared: '', text: 'true', untouched: 'x' },
      (_, key) => propDefs[key],
      'Person'
    )
    expect(result).toEqual({ flag: true, maybe: false, cleared: null, text: 'true', untouched: 'x' })
  })

  it('取不到定义的属性不转换', () => {
    expect(convertBooleanProperties({ k: 'true' }, () => null, 'T')).toEqual({ k: 'true' })
  })
})

describe('getEdgeTypesForEntities', () => {
  it('无 mapping / 无 adjacency_map → 告警并返回空数组', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(getEdgeTypesForEntities(null, 'A', 'B')).toEqual([])
    expect(getEdgeTypesForEntities({}, 'A', 'B')).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it('取 A→B 的边类型并补 properties 缺省', () => {
    const schemaMapping = {
      adjacency_map: {
        Person: {
          Company: [
            { edge_type: 'WorksFor', edge_desc: '任职', direction: 'out', properties: [{ name: 'since' }] },
            { edge_type: 'Owns' }
          ]
        }
      }
    }
    expect(getEdgeTypesForEntities(schemaMapping, 'Person', 'Company')).toEqual([
      { edge_type: 'WorksFor', edge_desc: '任职', direction: 'out', properties: [{ name: 'since' }] },
      { edge_type: 'Owns', edge_desc: undefined, direction: undefined, properties: [] }
    ])
    expect(getEdgeTypesForEntities(schemaMapping, 'Person', 'Nobody')).toEqual([])
  })
})
