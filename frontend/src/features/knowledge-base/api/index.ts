/**
 * knowledge-base feature 的公共出口。
 *
 * 跨 feature 一律 `import { x } from '@/features/knowledge-base/api'`，
 * 不再深入内部路径（graph 列表页、workflow 检索抽屉都走这里）。
 * 本出口用 .ts：转出的 lib（quick-create）类型要原样带到 graph 侧的
 * .ts 调用方，走 .js 出口会把类型磨成 any。
 */
export * from './directory'
export * from './kbaseApi'
export * from './knowledgeBase'

/**
 * 「创建知识库 / 建图」共享弹窗：文档库列表页（pages）与图谱列表页共用。
 * 保留原位（移动会牵动 pages 的深路径引用），从这里转出。
 */
export { default as CreateKnowledgeDialog } from '../components/CreateKnowledgeDialog.vue'

/**
 * 跨 feature 复用的 lib：图谱列表页与文档知识库列表页共用同一份
 * 状态闸门 / 指标卡整形 / 状态目录 / 上传上限兜底值。
 */
export {
  KB_STATUS,
  toNum,
  isDocKbModifyEnabled,
  isDocKbPublishEnabled,
  isGraphModifyEnabled,
  isGraphPublishEnabled,
  isGraphDeleteEnabled
} from '../lib/list-status'
export { normalizeStatsResponse, overviewFor } from '../lib/overview-stats'
export {
  ALL_STATUS_FILTER,
  findStatusDefinition,
  findStatusFilterOption,
  DOC_KB_STATUS_DEFINITIONS,
  GRAPH_STATUS_DEFINITIONS,
  DOC_KB_STATUS_FILTERS,
  GRAPH_STATUS_FILTERS
} from '../lib/status-catalog'
export { fallbackUploadLimits, toUploadLimits } from '../lib/quick-create'
export type { FileLimitGroup, UploadLimits } from '../lib/quick-create'
