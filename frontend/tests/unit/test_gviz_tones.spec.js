// @vitest-environment jsdom
/**
 * useGraphTones —— 实体/边配色与图例派生。
 *
 * jsdom 里 getComputedStyle 读不到 ：root 上注册的 CSS 变量，getPropertyValue 返回空串，
 * 正好走 readToneColor 的 fallback 分支 —— 断言色板等于 lib/entity-tones 的浅色兜底值。
 * 类型 → tone 的分配规则本身已由 entityTones.spec.js 钉住，这里钉的是
 * 「类型 → tone → 色值」这条派生链和图例的计数。
 */
import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'

import { ENTITY_TONE_FALLBACKS, ENTITY_TONE_SEQUENCE } from '@/features/graph/lib/entity-tones'
import { useGraphTones } from '@/features/graph/composables/useGraphTones'

function build ({ entities = [], edges = [], entityTypes = [], edgeTypes = [], cache = null } = {}) {
  const props = reactive({
    graphData: { entities, edges },
    entityTypes,
    edgeTypes
  })
  const graphDataCache = ref(cache || { entities, edges })
  const tones = useGraphTones({ props, graphDataCache })
  return { props, tones }
}

describe('useGraphTones', () => {
  it('typeToneMap：优先用模板实体类型顺序（schema），数据类型按分配规则匹配', () => {
    const { tones } = build({
      entities: [
        { entity_id: 'e1', entity_type: 'Scene' },
        { entity_id: 'e2', entity_type: 'Resource' }
      ],
      entityTypes: ['Resource', 'Scene']
    })

    expect(tones.typeToneMap).toEqual({ Resource: 'purple', Scene: 'blue' })
  })

  it('模板没给类型时按数据里出现的类型去重分配', () => {
    const { tones } = build({
      entities: [
        { entity_id: 'e1', entity_type: 'B' },
        { entity_id: 'e2', entity_type: 'A' },
        { entity_id: 'e3', entity_type: 'A' },
        { entity_id: 'e4', entity_type: 'A', class: 'ignored' }
      ]
    })

    expect(tones.typeToneMap).toEqual({ A: 'purple', B: 'blue' })
  })

  it('类型缺 entity_type 时回退 class 字段（与画布 group 口径一致）', () => {
    const { tones } = build({ entities: [{ entity_id: 'e1', class: 'Person' }] })
    expect(tones.typeToneMap.Person).toBe('purple')
  })

  it('tonePalette 在 jsdom 里落到浅色主题兜底值，图例色值与 colorMap 同源', () => {
    const { tones } = build({
      entities: [{ entity_id: 'e1', entity_type: 'A' }],
      entityTypes: ['A', 'B', 'C', 'D', 'E']
    })

    // colorMap 的每个色值都来自 ENTITY_TONE_FALLBACKS（readToneColor 读不到 CSS 变量时的兜底）
    const colors = Object.values(tones.colorMap)
    expect(colors.every(color => Object.values(ENTITY_TONE_FALLBACKS).includes(color))).toBe(true)
    expect(ENTITY_TONE_SEQUENCE).toHaveLength(5)
  })

  it('colorMap：类型 → tone → 当前主题色值', () => {
    const { tones } = build({
      entities: [{ entity_id: 'e1', entity_type: 'Scene' }],
      entityTypes: ['Scene']
    })

    expect(tones.colorMap).toEqual({ Scene: ENTITY_TONE_FALLBACKS.purple })
  })

  it('edgeColorMap：模板边类型大小写不敏感匹配数据，统一灰 #9aa0a6', () => {
    const { tones } = build({
      edges: [
        { edge_id: 'r1', edge_type: 'Relates' },
        { edge_id: 'r2', edge_type: 'Owns' }
      ],
      edgeTypes: ['relates']
    })

    // 模板里只有 relates（匹配到数据里的 Relates），Owns 来自数据补齐
    expect(tones.edgeColorMap).toEqual({ Relates: '#9aa0a6', Owns: '#9aa0a6' })
  })

  it('edgeColorMap：没有模板边类型时全部取数据类型', () => {
    const { tones } = build({ edges: [{ edge_id: 'r1', edge_type: 'Relates' }] })
    expect(tones.edgeColorMap).toEqual({ Relates: '#9aa0a6' })
  })

  it('entityLegendItems：按 colorMap 的类型出图例，数量来自画布缓存数据', () => {
    const { tones } = build({
      entities: [
        { entity_id: 'e1', entity_type: 'Scene' },
        { entity_id: 'e2', entity_type: 'Scene' },
        { entity_id: 'e3', entity_type: 'Resource' },
        { entity_id: 'e4' } // 无类型 → 计入 Unknown，但 colorMap 没有它，不出图例
      ],
      cache: {
        entities: [
          { entity_id: 'e1', entity_type: 'Scene' },
          { entity_id: 'e2', entity_type: 'Scene' },
          { entity_id: 'e3', entity_type: 'Resource' },
          { entity_id: 'e4' }
        ],
        edges: []
      }
    })

    expect(tones.entityLegendItems).toEqual([
      { type: 'Resource', color: ENTITY_TONE_FALLBACKS.purple, count: 1 },
      { type: 'Scene', color: ENTITY_TONE_FALLBACKS.blue, count: 2 }
    ])
  })

  it('entityLegendItems：画布缓存里没有的图例类型计 0（类型在模板里、数据被清空）', () => {
    const { tones } = build({
      entities: [{ entity_id: 'e1', entity_type: 'Scene' }],
      cache: { entities: [], edges: [] }
    })

    expect(tones.entityLegendItems).toEqual([
      { type: 'Scene', color: ENTITY_TONE_FALLBACKS.purple, count: 0 }
    ])
  })
})
