// 图谱「子孙展开」图计算（lib/graph-descendants.js）与画布几何（lib/graph-geometry.js）
// 的纯函数全分支单测：环、缺失目标节点、字段别名、非有限坐标等边界。
import {
  getOutgoingDescendants,
  hasOutgoingEdgeFrom
} from '@/features/graph/lib/graph-descendants'
import {
  CLICK_DELAY_MS,
  computeBoundingBoxCenter
} from '@/features/graph/lib/graph-geometry'

describe('getOutgoingDescendants', () => {
  const entities = [
    { entity_id: 'a', name: 'A' },
    { entity_id: 'b', name: 'B' },
    { entity_id: 'c', name: 'C' },
    { id: 'd', name: 'D' } // id 字段别名
  ]

  it('沿出向边收集直接与间接子孙', () => {
    const edges = [
      { source_id: 'a', target_id: 'b' },
      { source_id: 'b', target_id: 'c' }
    ]
    expect(getOutgoingDescendants('a', edges, entities).map(e => e.entity_id)).toEqual(['b', 'c'])
  })

  it('环状图不致死循环、不重复收集', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' }, // 回到起点
      { source: 'b', target: 'c' },
      { source: 'c', target: 'c' } // 自环
    ]
    expect(getOutgoingDescendants('a', edges, entities).map(e => e.entity_id)).toEqual(['b', 'c'])
  })

  it('目标实体缺失时跳过该分支', () => {
    const edges = [{ source_id: 'a', target_id: 'ghost' }]
    expect(getOutgoingDescendants('a', edges, entities)).toEqual([])
  })

  it('入边不算出向子孙；起点不存在返回空', () => {
    const edges = [
      { source_id: 'c', target_id: 'a' },
      { source_id: 'a', target_id: 'd' }
    ]
    // 只应收集 d（c→a 是入边）
    expect(getOutgoingDescendants('a', edges, entities)).toEqual([{ id: 'd', name: 'D' }])
    expect(getOutgoingDescendants('nobody', edges, entities)).toEqual([])
  })

  it('菱形去重：多条路径指向同一实体只收一次', () => {
    const diamondEntities = [
      { entity_id: 'root' }, { entity_id: 'l' }, { entity_id: 'r' }, { entity_id: 'leaf' }
    ]
    const edges = [
      { source_id: 'root', target_id: 'l' },
      { source_id: 'root', target_id: 'r' },
      { source_id: 'l', target_id: 'leaf' },
      { source_id: 'r', target_id: 'leaf' }
    ]
    expect(getOutgoingDescendants('root', edges, diamondEntities)).toHaveLength(3)
  })
})

describe('hasOutgoingEdgeFrom', () => {
  const edges = [{ source_id: 'a', target_id: 'b' }, { source: 'c', target: 'd' }]

  it('有出向边为 true（含 source 别名），否则 false', () => {
    expect(hasOutgoingEdgeFrom('a', edges)).toBe(true)
    expect(hasOutgoingEdgeFrom('c', edges)).toBe(true)
    expect(hasOutgoingEdgeFrom('b', edges)).toBe(false)
    expect(hasOutgoingEdgeFrom('x', [])).toBe(false)
  })
})

describe('CLICK_DELAY_MS', () => {
  it('单击延迟常量为 280ms（双击判定的窗口）', () => {
    expect(CLICK_DELAY_MS).toBe(280)
  })
})

describe('computeBoundingBoxCenter', () => {
  it('空/缺失坐标表返回 null', () => {
    expect(computeBoundingBoxCenter({})).toBeNull()
    expect(computeBoundingBoxCenter(null)).toBeNull()
    expect(computeBoundingBoxCenter(undefined)).toBeNull()
  })

  it('求包围盒中心', () => {
    expect(computeBoundingBoxCenter({
      n1: { x: 0, y: 0 },
      n2: { x: 10, y: 20 }
    })).toEqual({ x: 5, y: 10 })
  })

  it('单点即自身；字符串数字被 Number 化', () => {
    expect(computeBoundingBoxCenter({ only: { x: 3, y: 4 } })).toEqual({ x: 3, y: 4 })
    expect(computeBoundingBoxCenter({
      a: { x: '1', y: '2' },
      b: { x: 3, y: 4 }
    })).toEqual({ x: 2, y: 3 })
  })

  it('非法条目被忽略：null 坐标、非有限值；全非法返回 null', () => {
    expect(computeBoundingBoxCenter({
      bad1: null,
      bad2: { x: NaN, y: 1 },
      bad3: { x: 1, y: Infinity },
      good: { x: 2, y: 2 }
    })).toEqual({ x: 2, y: 2 })
    expect(computeBoundingBoxCenter({ bad1: null, bad2: { x: 'nope', y: 1 } })).toBeNull()
  })
})
