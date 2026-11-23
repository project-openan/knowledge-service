// @vitest-environment jsdom
/**
 * WorkflowEditorPage.vue（/flow/detail/:id 编排编辑器页）—— 只测「页面装配」：
 * - 生命周期装配：mounted 依次调 initGraph / setGraphEventAndNodeInfo / getAdvancedFlowConfig，
 *   window resize、主题切换、Esc（捕获阶段）三路监听挂上，beforeUnmount 全部拆掉；
 * - 路由参数 → 数据：同一路由换 id（复用实例，mounted 不再跑）要重载画布；
 * - 页壳交互：全屏进出（浮层收起 / 画布重测 / 按钮焦点）、「编排与操作」浮层开关、
 *   添加节点抽屉开关、缩放条、连线状态条 / 选中边状态条、试运行提示；
 * - 主操作链路：保存按钮在「图未落到当前工作流」时禁用、就绪后委托 saveConfigHandler；
 * - 画布事件：工具条四个动作、抽屉（DrawerFrame）事件、节点库卡片全部委托到对应方法。
 *
 * 六个 composable（画布/几何/连线/数据/抽屉/持久化）各有自己的 spec，这里全部 mock 成
 * vi.fn —— 页面本文件只剩装配与页壳，mock 让「谁在什么时机被调用」可以直接断言。
 * calculatePort mixin 保留真实实现（纯常量映射，无副作用）。
 */
import { vi } from 'vitest'
import { h } from 'vue'

// ── composable mock：方法名一一对应真实导出，页面展开进 methods ────────────────
const m = vi.hoisted(() => {
  const registry = {}
  const group = names => {
    const g = {}
    names.forEach(name => {
      g[name] = vi.fn()
      registry[name] = g[name]
    })
    return g
  }
  return {
    registry,
    canvas: group([
      'initGraph', 'applyGraphTheme', 'getCanvasSize', 'getNodeDisplaySize', 'applyInitialLayout',
      'setGraphSize', 'setGraphEventAndNodeInfo', 'graphListenDone', 'runPendingArrange',
      'graphListenMouseenter', 'graphListenMouseleave', 'graphListenConnected', 'graphListenRemoved',
      'graphListenGeometry', 'graphListenPorts', 'registerCustomNode', 'registerCustomNodeBundle'
    ]),
    geometry: group([
      'moduleTitleKeyOf', 'moduleTitleOf', 'moduleToneOf', 'nodeVariables', 'nodeGeometryFor',
      'scheduleGeometrySync', 'syncAllNodeGeometry', 'applyPortPosition', 'scheduleEdgeDecorations',
      'scheduleEdgeSettle', 'decorateEdges', 'nodeDisplayName', 'topologicalOrderNodes',
      'layoutWorkflowNodes', 'arrangeWorkflow', 'resetZoom', 'zoom',
      'updateOuputPortForSingleOutput', 'updatePortAfterChangingOperators', 'syncGraphStats',
      'sourceKindOf', 'workflowTypeLabel'
    ]),
    connections: group([
      'wouldCreateCycle', 'wouldCreateCycleInEdges', 'handleCanvasKeydown', 'selectEdge',
      'removeSelectedEdge', 'selectNodeView', 'clearNodeSelection', 'handleConnectionKey',
      'beginClickConnection', 'updateClickConnection', 'clearHoveredPort', 'finishClickConnection',
      'cancelConnection'
    ]),
    graphData: group([
      'initDefaultNode', 'insertNodeBeforeEnd', 'createLibraryNode', 'addLibraryNode', 'addNode',
      'normalizeNodePorts', 'importGraph', 'generateRandomUUID'
    ]),
    drawer: group([
      'showDrawerError', 'editCardHandle', 'confirmNodeDeletion', 'removeNodeWithBridge',
      'deleteCurrentNode', 'refreshDrawerInputs', 'removeDrawerInput', 'deleteNode',
      'inputDeleteHandle', 'initCardHandle', 'applyDrawerUpstreams', 'drawerSubmitHandle',
      'drawerCancelHandle'
    ]),
    persistence: group([
      'reloadAdvancedFlow', 'getAdvancedFlowConfig', 'engineOfTemplate', 'isSqlOperatorVariables',
      'checkIsStructKnowledgeFlow', 'refreshStructKnowledgeFlag', 'saveConfigHandler',
      'notifySaveSuccess', 'exportGraph', 'exportWorkflow', 'undoChanges'
    ])
  }
})

vi.mock('@/features/workflow/composables/useFlowCanvas', () => ({ useFlowCanvas: () => m.canvas }))
vi.mock('@/features/workflow/composables/useFlowGeometry', () => ({ useFlowGeometry: () => m.geometry }))
vi.mock('@/features/workflow/composables/useFlowConnections', () => ({ useFlowConnections: () => m.connections }))
vi.mock('@/features/workflow/composables/useFlowGraphData', () => ({ useFlowGraphData: () => m.graphData }))
vi.mock('@/features/workflow/composables/useFlowDrawer', () => ({ useFlowDrawer: () => m.drawer }))
vi.mock('@/features/workflow/composables/useFlowPersistence', () => ({ useFlowPersistence: () => m.persistence }))

// 页面外壳换成透传插槽的桩：副标题 / 页头动作 / 默认插槽都要真渲染，
// 保存按钮与工具条按钮的点击行为才能被断言
vi.mock('@/app/layout/WorkspaceShell.vue', () => ({
  default: {
    name: 'WorkspaceShellStub',
    props: ['back', 'parent', 'context', 'title', 'icon', 'showFocusAction'],
    setup (_, { slots }) {
      return () => h('div', { class: 'workspace-shell-stub' }, [
        h('div', { class: 'stub-subtitle' }, slots.subtitle ? slots.subtitle() : []),
        h('div', { class: 'stub-actions' }, slots.actions ? slots.actions() : []),
        h('div', { class: 'stub-body' }, slots.default ? slots.default() : [])
      ])
    }
  }
}))

// 节点配置抽屉：只保留事件透传能力（用例从桩组件上 $emit 触发页面回调）
vi.mock('@/features/workflow/DrawerFrame.vue', () => ({
  default: {
    name: 'DrawerFrameStub',
    props: ['title', 'nodeLabel', 'operatorCount', 'tone', 'fixed', 'fixedDirection', 'fixedField', 'upstreams', 'upstreamOptions'],
    emits: ['update:node-label', 'update:upstreams', 'delete', 'submitHandle', 'cancelHandle', 'closed'],
    setup (_, { slots }) {
      return () => h('div', { class: 'drawer-frame-stub' }, slots.default ? slots.default() : [])
    }
  }
}))

// X6 的 Vue 形状 teleport 容器：页面注册它只为画布内的卡片渲染，桩掉即可
vi.mock('@antv/x6-vue-shape', () => ({
  getTeleport: () => ({ name: 'TeleportContainerStub', render: () => h('div', { class: 'teleport-container-stub' }) })
}))

import { flush, mountWithPlugins } from './helpers/mount'
import WorkflowEditorPage from '@/features/workflow/pages/WorkflowEditorPage.vue'
import { THEME_CHANGE_EVENT } from '@/shared/lib/theme'

const ROUTES = [
  { path: '/flow', name: 'flow', component: { render: () => null } },
  { path: '/flow/detail/:id', name: 'flow-detail', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

const messageMock = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })

/** el-tooltip 桩（helpers 的 EP 精简集没带它，这里渲染默认插槽即可） */
const TooltipStub = {
  name: 'ElTooltipStub',
  setup (_, { slots }) {
    return () => h('span', { class: 'tooltip-stub' }, slots.default ? slots.default() : [])
  }
}

// 页面里有两处 Teleport（defer 到画布内的浮层锚点）。锚点靠 document.querySelector
// 解析，所以挂载必须 attachTo；又因为锚点是**固定 id**，多个实例同时在文档里会互相
// 抢锚点 —— 用例结束后立刻卸载上一个实例。
const mountedWrappers = []

async function mountPage ({ route = '/flow/detail/wf-1', routes = ROUTES } = {}) {
  const wrapper = await mountWithPlugins(WorkflowEditorPage, {
    route,
    routes,
    attachTo: document.body,
    global: {
      components: { ElTooltip: TooltipStub },
      config: { globalProperties: { $message: messageMock } }
    }
  })
  mountedWrappers.push(wrapper)
  await flush()
  return wrapper
}

afterEach(() => {
  while (mountedWrappers.length) {
    const wrapper = mountedWrappers.pop()
    try {
      wrapper.unmount()
    } catch (error) {
      // 已被上一个 afterEach 清掉 body 的实例忽略
    }
  }
  document.body.innerHTML = ''
})

/**
 * 本页面同时有 `<script setup>`（图标/外壳导入）与 options 块（页面本体），
 * VTU 的 `wrapper.vm` 是「优先写 setupState」的代理：给 data 属性赋值必须走
 * `$.data`（真响应式源），否则读到的是 proxy 上的假值、渲染不更新。
 */
function setData (wrapper, patch) {
  Object.assign(wrapper.vm.$.data, patch)
}

beforeEach(() => {
  vi.clearAllMocks()
  // 模板在副标题里同步调用这两个方法：给它们能被模板消费的返回值
  m.geometry.sourceKindOf.mockImplementation(kind => ({ tone: 'blue', icon: {}, labelKey: `x.${kind}` }))
  m.geometry.workflowTypeLabel.mockReturnValue('混合工作流')
})

describe('生命周期装配（mounted / beforeUnmount）', () => {
  it('挂载即装配画布并加载工作流配置；保存按钮在图未落到当前工作流时禁用', async () => {
    const wrapper = await mountPage()

    expect(m.canvas.initGraph).toHaveBeenCalledTimes(1)
    expect(m.canvas.setGraphEventAndNodeInfo).toHaveBeenCalledTimes(1)
    expect(m.persistence.getAdvancedFlowConfig).toHaveBeenCalledTimes(1)
    // graphAppId 初始为空 ≠ 路由 id：保存按钮禁用，点击不触发保存链路
    const saveButton = wrapper.findAll('.flow-primary-actions .el-button').at(1)
    expect(saveButton.attributes('disabled')).toBeDefined()
    await saveButton.trigger('click')
    expect(m.persistence.saveConfigHandler).not.toHaveBeenCalled()
  })

  it('图落到当前工作流后保存按钮可用，点击委托 saveConfigHandler', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { graphAppId: 'wf-1' })
    await flush()

    const saveButton = wrapper.findAll('.flow-primary-actions .el-button').at(1)
    expect(saveButton.attributes('disabled')).toBeUndefined()
    await saveButton.trigger('click')
    expect(m.persistence.saveConfigHandler).toHaveBeenCalledTimes(1)
  })

  it('window resize / 主题切换 / Esc 三路监听：触发即转发给画布方法', async () => {
    const wrapper = await mountPage()

    window.dispatchEvent(new Event('resize'))
    expect(m.canvas.setGraphSize).toHaveBeenCalled()

    const themeCalls = m.canvas.applyGraphTheme.mock.calls.length
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT))
    expect(m.canvas.applyGraphTheme.mock.calls.length).toBe(themeCalls + 1)

    // Esc（捕获阶段挂在 document）：不改变全屏（未全屏时方法早退由 composable 负责）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(m.connections.handleConnectionKey).toHaveBeenCalled()
  })

  it('卸载后拆掉监听：resize / 主题事件不再触发画布方法', async () => {
    const wrapper = await mountPage()
    const sizeCalls = m.canvas.setGraphSize.mock.calls.length
    const themeCalls = m.canvas.applyGraphTheme.mock.calls.length
    // cancelConnection 在卸载时兜底清连线状态
    wrapper.unmount()
    expect(m.connections.cancelConnection).toHaveBeenCalled()
    expect(wrapper.vm.pendingArrange).toBe(false)

    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT))
    expect(m.canvas.setGraphSize.mock.calls.length).toBe(sizeCalls)
    expect(m.canvas.applyGraphTheme.mock.calls.length).toBe(themeCalls)
  })

  it('卸载时清掉排版/装饰的 rAF 与 idle 回调句柄', async () => {
    const cancelIdle = vi.fn()
    const cancelRaf = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelRaf)
    window.cancelIdleCallback = cancelIdle

    const wrapper = await mountPage()
    setData(wrapper, { decorateFrame: 1, decorateIdle: 2, geometryFrame: 3 })
    wrapper.unmount()
    expect(wrapper.vm.decorateFrame).toBeNull()
    expect(wrapper.vm.decorateIdle).toBeNull()
    expect(wrapper.vm.geometryFrame).toBeNull()
    expect(cancelIdle).toHaveBeenCalledWith(2)
    expect(cancelRaf).toHaveBeenCalledWith(3)
    vi.unstubAllGlobals()
    delete window.cancelIdleCallback
  })
})

describe('路由参数 → 数据装配', () => {
  it('同一路由只换 id（复用实例）时重载画布数据', async () => {
    const wrapper = await mountPage()
    expect(m.persistence.reloadAdvancedFlow).not.toHaveBeenCalled()

    await wrapper.router.push('/flow/detail/wf-2')
    await flush()
    expect(m.persistence.reloadAdvancedFlow).toHaveBeenCalledTimes(1)
  })

  it('goBack：应用内有历史就 router.back()，深链直开则 push 回列表', async () => {
    // memory history 的 state.back 在单测里恒为空：把 state 换成「有上一跳」的替身
    const wrapper = await mountPage()
    const history = wrapper.router.options.history
    const originalState = Object.getOwnPropertyDescriptor(history, 'state')
    Object.defineProperty(history, 'state', { configurable: true, get: () => ({ back: '/flow' }) })
    const backSpy = vi.spyOn(wrapper.router, 'back')
    wrapper.vm.goBack()
    expect(backSpy).toHaveBeenCalledTimes(1)
    Object.defineProperty(history, 'state', originalState)

    // state.back 为空（深链直开详情页）→ push 回列表
    const pushSpy = vi.spyOn(wrapper.router, 'push')
    Object.defineProperty(history, 'state', { configurable: true, get: () => ({ back: null }) })
    wrapper.vm.goBack()
    expect(pushSpy).toHaveBeenCalledWith('/flow')
    Object.defineProperty(history, 'state', originalState)
  })
})

describe('页壳交互：全屏 / 浮层 / 抽屉 / 缩放', () => {
  it('toggleFullscreen：切换状态并收起浮层，布局落定后重测画布尺寸', async () => {
    const wrapper = await mountPage()
    const sizeCalls = m.canvas.setGraphSize.mock.calls.length

    await wrapper.find('.canvas-fullscreen-actions .el-button').trigger('click')
    expect(wrapper.vm.fullscreen).toBe(true)  // 第一次点击时容器里只有全屏一个按钮
    expect(wrapper.vm.toolsOpen).toBe(false)
    expect(wrapper.find('.canvas-viewport.is-fullscreen').exists()).toBe(true)
    // 全屏时按钮文字/图标切换（Close vs FullScreen）
    await flush()
    expect(m.canvas.setGraphSize.mock.calls.length).toBeGreaterThan(sizeCalls)

    // 全屏后容器里多出「编排与操作」按钮（v-if fullscreen），用 aria-pressed 精确锁定全屏按钮
    await wrapper.find('.canvas-fullscreen-actions .el-button[aria-pressed]').trigger('click')
    expect(wrapper.vm.fullscreen).toBe(false)
  })

  it('Esc：先收「编排与操作」浮层，再退全屏；抽屉/弹窗打开时不抢', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { fullscreen: true })
    await flush()

    // 非Escape键不处理
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(wrapper.vm.fullscreen).toBe(true)

    // 浮层开着：第一下收浮层
    setData(wrapper, { toolsOpen: true })
    await flush()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.vm.toolsOpen).toBe(false)
    expect(wrapper.vm.fullscreen).toBe(true)

    // 浮层收了：第二下退全屏
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.vm.fullscreen).toBe(false)

    // 抽屉/弹窗可见时 Esc 不归页面管
    const rects = Element.prototype.getClientRects
    Element.prototype.getClientRects = function () { return [{}] }
    document.body.appendChild(Object.assign(document.createElement('div'), { className: 'el-dialog' }))
    setData(wrapper, { fullscreen: true })
    await flush()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.vm.fullscreen).toBe(true)
    Element.prototype.getClientRects = rects

    // 已被消费的事件（defaultPrevented）也不处理
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    consumed.preventDefault()
    window.dispatchEvent(consumed)
    expect(wrapper.vm.fullscreen).toBe(true)
  })

  it('工具条：添加节点开关抽屉并收浮层；排版/校验/撤销逐个委托', async () => {
    const wrapper = await mountPage()
    const toolButtons = wrapper.findAll('.workspace-toolbar .el-button')

    await toolButtons[0].trigger('click') // 添加节点
    expect(wrapper.vm.libraryVisible).toBe(true)
    expect(wrapper.vm.toolsOpen).toBe(false)
    await toolButtons[0].trigger('click')
    expect(wrapper.vm.libraryVisible).toBe(false)

    await toolButtons[1].trigger('click') // 整理布局
    expect(m.geometry.arrangeWorkflow).toHaveBeenCalledTimes(1)

    setData(wrapper, { nodeCount: 3 })
    setData(wrapper, { edgeCount: 2 })
    await flush()
    await toolButtons[2].trigger('click') // 校验配置：提示节点/边数
    expect(messageMock.info).toHaveBeenCalled()
    expect(String(messageMock.info.mock.calls[0][0])).toContain('3')

    await toolButtons[3].trigger('click') // 撤销修改
    expect(m.persistence.undoChanges).toHaveBeenCalledTimes(1)

    // loading 时撤销按钮禁用
    setData(wrapper, { loading: true })
    await flush()
    expect(toolButtons[3].attributes('disabled')).toBeDefined()
  })

  it('画布统计与工具条备注按响应式数据渲染', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { nodeCount: 3 })
    setData(wrapper, { edgeCount: 2 })
    setData(wrapper, { operatorCount: 5 })
    await flush()
    const note = wrapper.find('.workspace-toolbar-note')
    expect(note.text()).toContain('3')
    expect(note.text()).toContain('2')
    expect(note.text()).toContain('5')
    expect(note.text()).toContain(wrapper.vm.workflowId === '' ? '' : wrapper.vm.workflowId)
  })

  it('缩放条：缩小/放大/适配/重置分别委托 zoom 与 resetZoom，百分比随 zoomPercent', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { zoomPercent: 80 })
    await flush()
    expect(wrapper.find('.canvas-zoom-reset').text()).toBe('80%')

    const controls = wrapper.find('.canvas-controls')
    const buttons = controls.findAll('button')
    await buttons[0].trigger('click')
    expect(m.geometry.zoom).toHaveBeenLastCalledWith('out')
    await buttons[1].trigger('click')
    expect(m.geometry.resetZoom).toHaveBeenCalledTimes(1)
    await buttons[2].trigger('click')
    expect(m.geometry.zoom).toHaveBeenLastCalledWith('in')
    await buttons[3].trigger('click') // 第 4 个是分隔条后的「适配画布」
    expect(m.geometry.zoom).toHaveBeenLastCalledWith('fit')
  })

  it('连线状态条：拖线中显示来源与取消；取消委托 cancelConnection', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { connectingSource: 'node-1' })
    setData(wrapper, { connectingSourceLabel: '开始' })
    await flush()

    const bar = wrapper.find('.flow-floating-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('开始')
    expect(wrapper.find('.flow-surface.is-connecting').exists()).toBe(true)

    await bar.find('.el-button').trigger('click')
    expect(m.connections.cancelConnection).toHaveBeenCalledTimes(1)
  })

  it('选中边状态条：显示两端名称，删除委托 removeSelectedEdge', async () => {
    const wrapper = await mountPage()
    setData(wrapper, { selectedEdge: { sourceLabel: '检索', targetLabel: '应答' } })
    await flush()

    const bar = wrapper.find('.flow-floating-bar')
    expect(bar.text()).toContain('检索')
    expect(bar.text()).toContain('应答')
    await bar.find('.el-button').trigger('click')
    expect(m.connections.removeSelectedEdge).toHaveBeenCalledTimes(1)
  })

  it('画布指针事件（连线拖动/悬停清理/快捷键）挂在 .flow-surface 上', async () => {
    const wrapper = await mountPage()
    const surface = wrapper.find('.flow-surface')
    await surface.trigger('pointermove')
    expect(m.connections.updateClickConnection).toHaveBeenCalled()
    await surface.trigger('pointerleave')
    expect(m.connections.clearHoveredPort).toHaveBeenCalled()
    await surface.trigger('keydown')
    expect(m.connections.handleCanvasKeydown).toHaveBeenCalled()
  })
})

describe('页头动作与节点库抽屉', () => {
  it('试运行未接入：点击提示而不触发任何画布动作', async () => {
    const wrapper = await mountPage()
    await wrapper.find('.trial-run-wrap').trigger('click')
    expect(messageMock.info).toHaveBeenCalledWith(wrapper.vm.$t('modules.workflow.trialRunNotConnected'))
  })

  it('节点库抽屉：四个模块卡片逐个委托 addLibraryNode(shape)', async () => {
    const wrapper = await mountPage()
    const options = wrapper.findAll('.module-option')
    expect(options).toHaveLength(4)

    await options[0].trigger('click')
    expect(m.graphData.addLibraryNode).toHaveBeenLastCalledWith('preretriever')
    await options[1].trigger('click')
    expect(m.graphData.addLibraryNode).toHaveBeenLastCalledWith('retriever')
    await options[2].trigger('click')
    expect(m.graphData.addLibraryNode).toHaveBeenLastCalledWith('postretriever')
    await options[3].trigger('click')
    expect(m.graphData.addLibraryNode).toHaveBeenLastCalledWith('responsesynthesizer')
  })

  it('模块卡片的算子说明文案用真词条渲染（不落 i18n 键名）', async () => {
    const wrapper = await mountPage()
    const first = wrapper.find('.module-option')
    expect(first.text()).toContain(wrapper.vm.$t('ragFlow.preretrieverTitle'))
    expect(first.text()).toContain(wrapper.vm.$t('ragFlow.LLMQueryRewriterOperator'))
    expect(wrapper.text()).not.toContain('ragFlow.retrieverTitle')
  })
})

describe('抽屉（DrawerFrame）事件装配', () => {
  it('提交 / 取消 / 删除 / 关闭分别委托对应方法；标签与上游改动同步进 drawerBasics', async () => {
    const wrapper = await mountPage()
    const frame = wrapper.findComponent({ name: 'DrawerFrameStub' })
    expect(frame.exists()).toBe(true)

    frame.vm.$emit('submitHandle')
    await flush()
    expect(m.drawer.drawerSubmitHandle).toHaveBeenCalledTimes(1)
    frame.vm.$emit('cancelHandle')
    frame.vm.$emit('closed')
    await flush()
    expect(m.drawer.drawerCancelHandle.mock.calls.length).toBeGreaterThanOrEqual(2)
    frame.vm.$emit('delete')
    await flush()
    expect(m.drawer.deleteCurrentNode).toHaveBeenCalledTimes(1)

    // 抽屉头部表单的 v-model 回写直接进 drawerBasics
    frame.vm.$emit('update:node-label', '新标签')
    frame.vm.$emit('update:upstreams', ['u1'])
    await flush()
    expect(wrapper.vm.drawerBasics).toEqual({ label: '新标签', upstreams: ['u1'] })
  })

  it('动态表单：dynamicComponent 就位且 isComponentLoaded 时渲染并接住 config-error', async () => {
    const wrapper = await mountPage()
    const formStub = {
      name: 'DynamicFormStub',
      emits: ['config-error', 'operator-count'],
      props: ['formData', 'nodeId', 'componentType'],
      setup (_, { emit }) {
        return () => h('div', { class: 'dynamic-form-stub', onClick: () => emit('config-error', 'bad') })
      }
    }
    setData(wrapper, { dynamicComponent: formStub })
    setData(wrapper, { isComponentLoaded: true })
    setData(wrapper, { currentNodeData: { label: '检索', componentType: 'Retriever', id: 'n1', variables: {} } })
    await flush()

    expect(wrapper.find('.dynamic-form-stub').exists()).toBe(true)
    await wrapper.find('.dynamic-form-stub').trigger('click')
    expect(m.drawer.showDrawerError).toHaveBeenCalledWith('bad')
    expect(wrapper.vm.drawerOperatorCount).toBe(0)
  })
})

describe('页面数据初始化', () => {
  it('workflowTypeMap / shapeAndPortIdMap 用组件 data 覆盖 mixin，词条真实翻译', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.workflowTypeMap.BlendedQueryEngine).toBe(wrapper.vm.$t('ragFlow.mixWorkflow'))
    expect(wrapper.vm.workflowTypeMap.BlendedQueryEngine).not.toBe('ragFlow.mixWorkflow')
    expect(wrapper.vm.shapeAndPortIdMap.PRE_RETRIEVER).toBe('preretriever')
    // mixin 的形状常量表仍在（不与页面 data 冲突）
    expect(Object.keys(wrapper.vm.shapeAndConstMap)).toEqual([
      'PRE_RETRIEVER', 'RETRIEVER', 'POST_RETRIEVER', 'RESPONSE_SYNTHESIZER'
    ])
    expect(wrapper.vm.libraryModules).toHaveLength(4)
  })
})
