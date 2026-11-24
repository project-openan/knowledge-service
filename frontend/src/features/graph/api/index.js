/**
 * graph feature 的公共出口。
 *
 * 跨 feature 一律 `import { x } from '@/features/graph/api'`，
 * 不再深入内部路径（如 knowledge-base 的建图弹窗走这里取图谱接口）。
 */
export * from './knowledgeGraph'

/**
 * 跨 feature 复用的建图配置纯函数（knowledge-base 的建图弹窗收集
 * 算子 / 模板 / 切分参数时用），随出口一并转出。
 */
export {
  buildGraphExtractPayload,
  defaultBuildParams,
  isIntegerArg,
  orderedOperatorArgs,
  validateBuildParams,
  CHUNK_SIZE_MIN,
  CHUNK_SIZE_MAX,
  OVERLAP_MIN,
  OVERLAP_MAX
} from '../lib/graph-build-config'
