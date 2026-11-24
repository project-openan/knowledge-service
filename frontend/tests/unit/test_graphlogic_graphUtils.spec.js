// @vitest-environment jsdom
// 图谱组件层工具函数（features/graph/components/graphUtils.js）：
// id / 时间戳 / 颜色映射 / 导出落盘（Blob + 隐藏 <a>）/ 固定位置释放。
import { vi, beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  availableEntityTypes,
  availableEdgeTypes,
  entityTypePropertiesMap,
  edgeTypePropertiesMap,
  generateUniqueId,
  generateRid,
  formatTimestamp,
  calculateColorMap,
  calculateEdgeColorMap,
  exportGraphData,
  releaseNodeFixedPosition
} from '@/features/graph/components/graphUtils'

describe('假数据常量', () => {
  it('实体 / 边类型与属性定义表成对存在', () => {
    expect(availableEntityTypes).toEqual(['Term', 'Product', 'Business', 'Function', 'Concept'])
    expect(availableEdgeTypes).toEqual(['Explain', 'Related', 'Contains', 'DependsOn', 'AssociatedWith'])
    availableEntityTypes.forEach(type => expect(entityTypePropertiesMap[type].name).toBeTruthy())
    availableEdgeTypes.forEach(type => expect(edgeTypePropertiesMap[type].name).toBeTruthy())
  })
})

describe('generateUniqueId / generateRid', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
  })

  afterEach(() => vi.restoreAllMocks())

  it('前缀 + 当前时间戳；RID 默认 # 前缀', () => {
    expect(generateUniqueId('node-')).toBe('node-1700000000000')
    expect(generateUniqueId()).toBe('1700000000000')
    expect(generateRid()).toBe('#1700000000000')
    expect(generateRid('@')).toBe('@1700000000000')
  })
})

describe('formatTimestamp', () => {
  it('空值与非法时间戳返回 --', () => {
    expect(formatTimestamp(null)).toBe('--')
    expect(formatTimestamp(undefined)).toBe('--')
    expect(formatTimestamp(0)).toBe('--')
    expect(formatTimestamp('')).toBe('--')
    expect(formatTimestamp('not-a-date')).toBe('--')
  })

  it('按本地时区格式化 YYYY-MM-DD HH:mm:ss', () => {
    // 用本地时间构造，避免 CI 时区差异
    const local = new Date(2023, 4, 9, 7, 8, 9).getTime()
    expect(formatTimestamp(local)).toBe('2023-05-09 07:08:09')
    expect(formatTimestamp(new Date(2024, 11, 31, 23, 59, 59).getTime())).toBe('2024-12-31 23:59:59')
  })
})

describe('颜色映射', () => {
  it('实体 / 边类型按序取色，超出色板数循环取模', () => {
    const entityMap = calculateColorMap(['A', 'B'])
    expect(entityMap.A).toBe('#ff6b6b')
    expect(entityMap.B).toBe('#4ecdc4')
    const eight = calculateColorMap(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    expect(eight.i).toBe('#ff6b6b') // index 8 % 8 → 第 0 色
    expect(calculateColorMap([])).toEqual({})

    const edgeMap = calculateEdgeColorMap(['Explain', 'Related'])
    expect(edgeMap.Explain).toBe('#3498db')
    expect(edgeMap.Related).toBe('#e74c3c')
    expect(calculateEdgeColorMap(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']).r9).toBe('#3498db')
  })
})

describe('exportGraphData', () => {
  let createObjectURL, revokeObjectURL, clickSpy

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:export-id')
    revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    clickSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('导出带缓存位置的实体并写入 metadata，触发 json 下载', async () => {
    const graphData = {
      schema_name: '供应链图谱',
      entities: [
        { entity_id: 'e1', name: 'A' },
        { entity_id: 'e2', name: 'B' }
      ],
      edges: [{ id: 'r1' }]
    }
    const nodePositionCache = new Map([['e1', { x: 10.4, y: -20.6 }]])

    expect(exportGraphData(graphData, nodePositionCache)).toBe(true)

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/json;charset=utf-8')

    const link = clickSpy.mock.instances[0]
    expect(link.download).toMatch(/^供应链图谱_\d{4}-\d{2}-\d{2}T[\d-]+\.json$/)

    const exported = JSON.parse(await blob.text())
    expect(exported.schema_name).toBe('供应链图谱')
    expect(exported.entities[0]).toMatchObject({ entity_id: 'e1', x: 10, y: -21 }) // 坐标取整
    expect(exported.entities[1].x).toBeUndefined() // 无缓存位置保持原样
    expect(exported.metadata).toMatchObject({
      total_entities: 2,
      total_edges: 1,
      entities_with_position: 1,
      export_version: '1.0'
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export-id')
    expect(link.parentNode).toBeNull()
  })

  it('缺省名称 / 无边数据时也给出兜底', async () => {
    expect(exportGraphData({ entities: [] }, new Map())).toBe(true)
    const exported = JSON.parse(await createObjectURL.mock.calls[0][0].text())
    expect(exported.schema_name).toBe('知识图谱')
    expect(exported.edges).toEqual([])
    expect(exported.metadata.total_edges).toBe(0)
  })

  it('序列化失败时记录并原样抛出', () => {
    const boom = new Error('cache broken')
    const badCache = { get: () => { throw boom } }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => exportGraphData({ entities: [{ entity_id: 'e1' }] }, badCache)).toThrow(boom)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('releaseNodeFixedPosition', () => {
  it('缺 entityId 直接返回，不碰缓存', () => {
    const cache = new Map()
    releaseNodeFixedPosition(null, cache, { entities: [] })
    expect(cache.size).toBe(0)
  })

  it('从缓存移除并删除实体上的坐标字段', () => {
    const entity = { entity_id: 'e1', x: 1, y: 2, name: 'A' }
    const graphData = { entities: [entity] }
    const cache = new Map([['e1', { x: 1, y: 2 }], ['e2', { x: 3, y: 4 }]])
    releaseNodeFixedPosition('e1', cache, graphData)
    expect(cache.has('e1')).toBe(false)
    expect(cache.has('e2')).toBe(true)
    expect(entity).toEqual({ entity_id: 'e1', name: 'A' })
  })

  it('实体不在数据里时只清缓存', () => {
    const cache = new Map([['ghost', { x: 1, y: 2 }]])
    releaseNodeFixedPosition('ghost', cache, { entities: [{ entity_id: 'e1' }] })
    expect(cache.size).toBe(0)
  })
})
