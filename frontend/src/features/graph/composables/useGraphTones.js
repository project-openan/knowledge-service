/**
 * useGraphTones —— 实体/边配色与图例派生。
 *
 * 拆分缘由：GraphVisualization.vue 里「类型 → tone → 当前主题色值」这一串 computed
 * （entityTypes / edgeTypes 去重、typeToneMap、tonePalette、colorMap、edgeColorMap、
 * entityLegendItems）只依赖 props 与画布缓存数据，和组件的交互逻辑无关；单独成
 * composable 后，画布（GraphCanvasVis）、图例、子组件都从同一处取色，主文件不再
 * 承载配色派生细节。
 *
 * 返回 reactive store（ref 在其中自动解包），供模板与子组件直接读写。
 */
import { computed, reactive } from 'vue'
import { theme } from '@/shared/lib/theme'
import {
  assignEntityTones,
  ENTITY_TONE_FALLBACKS,
  ENTITY_TONE_SEQUENCE,
  ENTITY_TONE_TOKENS
} from '../lib/entity-tones'
import { collectDataTypes } from '../lib/graph-schema'

export function useGraphTones (ctx) {
  const { props, graphDataCache } = ctx

  // 实体类型配色：--rs-tone-* 五个语义色按模板实体类型顺序轮转。
  // 类型 → tone 名由 lib/entity-tones 统一分配（画布 / 图例 / 基本信息页共用）。
  // canvas 不解析 CSS 变量，所以色值在主题切换时重新读取令牌的实际值。
  function readToneColor (token, fallback) {
    if (typeof document === 'undefined' || !document.documentElement) {
      return fallback
    }
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
    return value || fallback
  }

  // 计算属性：与画布 group 一致，使用 entity_type || class / edge_type || class
  const entityTypes = computed(() => collectDataTypes(props.graphData.entities, 'entity_type'))
  const edgeTypes = computed(() => collectDataTypes(props.graphData.edges, 'edge_type'))

  const typeToneMap = computed(() => assignEntityTones(
    props.entityTypes && props.entityTypes.length ? props.entityTypes : [],
    entityTypes.value
  ))

  const tonePalette = computed(() => {
    // 主题切换 → theme 变化 → 重新读取令牌（浅色 #8045ff / 深色 #bb9aff）
    void theme.value
    const palette = {}
    ENTITY_TONE_SEQUENCE.forEach((tone) => {
      palette[tone] = readToneColor(ENTITY_TONE_TOKENS[tone], ENTITY_TONE_FALLBACKS[tone])
    })
    return palette
  })

  // 图例与画布颜色一致：type → tone → 当前主题的实际色值
  const colorMap = computed(() => {
    const map = {}
    Object.keys(typeToneMap.value).forEach((type) => {
      map[type] = tonePalette.value[typeToneMap.value[type]]
    })
    return map
  })

  const edgeColorMap = computed(() => {
    const map = {}
    const schemaOrder = props.edgeTypes && props.edgeTypes.length ? props.edgeTypes : []
    const fromData = edgeTypes.value
    schemaOrder.forEach((schemaType) => {
      const matched = fromData.find((t) => t === schemaType || String(t).toLowerCase() === String(schemaType).toLowerCase())
      if (matched) {
        map[matched] = '#9aa0a6'
      }
    })
    fromData.forEach((t) => {
      if (!(t in map)) {
        map[t] = '#9aa0a6'
      }
    })
    return map
  })

  const entityLegendItems = computed(() => {
    const countMap = new Map()
    const entitiesList = graphDataCache.value?.entities || []
    entitiesList.forEach((entity) => {
      const type = entity.entity_type || entity.class || 'Unknown'
      countMap.set(type, (countMap.get(type) || 0) + 1)
    })
    return Object.keys(colorMap.value).map((type) => ({
      type,
      color: colorMap.value[type],
      count: countMap.get(type) || 0
    }))
  })

  return reactive({
    typeToneMap,
    colorMap,
    edgeColorMap,
    entityLegendItems
  })
}
