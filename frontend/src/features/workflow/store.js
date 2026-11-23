import { reactive } from 'vue'

// 编排画布的本地状态。原先挂在全局 store（app/store/index.js）的根 state 上，
// 属于 workflow 专属状态，收归 feature 本地：模块内 reactive 单例，本 feature
// 组件直接 import 读写，不再经过全局 store。
export const workflowState = reactive({
  // 高级编排是否处于编辑状态
  isAdvancedFlowEditMode: false,
  // 当前工作流的编排引擎类型（QUERY_ENGINE.operator，如 SequentialQueryEngine）
  ragWorkflowType: '',
  // 新手引导变量
  flow: {
    userGuideVariables: {}
  }
})

// 兼容桥：WorkflowEditorPage（已迁至 features/workflow/pages）现在直接写
// workflowState 单例，不再经过这条旧写入路径；保留它只是兜底仍走
// `$store.state.ragWorkflowType` 的历史代码，读写都转发到同一份数据。
export function installLegacyWorkflowStateCompat (rootState) {
  Object.defineProperty(rootState, 'ragWorkflowType', {
    get () {
      return workflowState.ragWorkflowType
    },
    set (value) {
      workflowState.ragWorkflowType = value
    },
    enumerable: true,
    configurable: true
  })
}
