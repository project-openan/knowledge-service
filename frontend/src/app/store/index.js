import { createStore } from 'vuex'
import kbase from '@/features/knowledge-base/store';
import { installLegacyWorkflowStateCompat } from '@/features/workflow/store';

// workflow 专属状态（isAdvancedFlowEditMode / ragWorkflowType / flow.userGuideVariables）
// 已迁往 @/features/workflow/store 的 reactive 单例。根 state 只保留全局状态；
// ragWorkflowType 通过访问器别名保持旧写入路径（$store.state.ragWorkflowType）可用。
const state = {
  kb: {
    currentName: ''
  },
  authority: {
    noAnyAuthority: true,
    isSuperAdmin: false,
    isPlatformAdmin: false,
    isAppCreator: false,
    isKbaseCreator: false,
    isAppAdmin: false,
    isAppDeveloper: false,
    isKbaseAdmin: false,
    isKbaseMember: false
  },
  simple: {
    userGuideVariables: {}
  },
  showDetailLeft: true, // 是否展示应用子菜单侧边栏
  showAsideMenu: true, // 是否展示应用平台左侧侧边菜单栏 -- 目前服务于高级编排 编辑模式 隐藏侧边菜单
  appName: '',
  appLatestSaveDate: '',
  ragWorkflowIsStructKnowledge: false // 高级编排工作流是否实际使用结构化知识库（SQL检索算子）
}
installLegacyWorkflowStateCompat(state)

const storeConfig = {
  state,
  getters: {
  },
  mutations: {
    updateCurrentName (state, value) {
      state.kb.currentName = value
    },
    updateShowAsideMenu (state, value) {
      state.showAsideMenu = value
    },
    updateDetailLeft (state, value) {
      state.showDetailLeft = value
    },
    updateAppLatestSaveDate (state, value) {
      state.appLatestSaveDate = value;
    }
  },
  actions: {
  },
  modules: {
    kbase
  }
}

export default storeConfig

export const store = createStore(storeConfig)
