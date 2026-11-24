<template>
  <WorkspaceShell
    class="advanced-flow"
    :class="{ 'is-flow-fullscreen': fullscreen }"
    back="/flow"
    :parent="$t('ragFlow.ragWorkflow')"
    :context="$t('modules.workflow.editOrchestration')"
    :title="workflowName"
    :icon="WorkflowIcon"
    :show-focus-action="false"
  >
    <template #subtitle>
      <!-- 先给出知识来源类型，再给模板类型；只绑图谱库时显示「图谱检索」 -->
      <span v-for="kind in sourceKinds" :key="kind" :class="['tag-soft', sourceKindOf(kind).tone]">
        <component :is="sourceKindOf(kind).icon" />{{ $t(sourceKindOf(kind).labelKey) }}
      </span>
      <span class="tag-soft blue">{{ workflowTypeLabel() }}</span>
      <span>{{ workflowId }}</span>
    </template>
    <template #actions>
      <!-- 全屏时页面头部整体隐藏，这两个主操作 Teleport 进画布的
           「编排与操作」浮层（同一个实例，不复制按钮）。 -->
      <!-- defer：目标节点由本组件自己的画布渲染，首帧早于它挂载；不加 defer 时
           Teleport 在挂载期解析不到目标（生产构建无警告，直接缓存 null），
           第一次进全屏会报 insertBefore of null。 -->
      <Teleport defer :disabled="!fullscreen" to="#flow-fullscreen-actions-target">
        <div class="flow-primary-actions">
          <!-- 试运行还没接后端：外观是禁用态（灰），但**点击仍给提示**（span 接 click，
               按钮 pointer-events:none 让事件落到 span 上），hover 还有 tooltip。
               不直接隐藏：工具栏三个动作是一组，隐藏会让其余按钮跳位，用户也无从得知
               这个能力存在。「看起来不可用 + 点了会解释为什么」是这里的最优解。 -->
          <el-tooltip :content="$t('modules.workflow.trialRunNotConnected')" placement="bottom">
            <span class="trial-run-wrap" @click="showTrialRunHint">
              <el-button class="button-compact trial-run-btn" disabled>
                <VideoPlay />{{ $t('modules.workflow.trialRun') }}
              </el-button>
            </span>
          </el-tooltip>
          <!-- 图还没落到当前工作流上（首次加载中、或刚切过来还没加载完）时不让点：
               此时保存存下去的会是空的/别的流的画布 -->
          <el-tooltip :content="$t('modules.workflow.saveDraftHint')" placement="bottom">
            <el-button
              class="button-compact"
              :loading="loading"
              :disabled="graphAppId !== $route.params.id"
              type="primary"
              @click="saveConfigHandler"
            >
              <Check />{{ $t('public.save') }}
            </el-button>
          </el-tooltip>
        </div>
      </Teleport>
    </template>

    <Teleport defer :disabled="!fullscreen" to="#flow-fullscreen-controls-target">
      <div class="workspace-toolbar">
        <div class="workspace-toolbar-group">
          <el-button class="button-compact" @click="toggleLibrary">
            <Plus />{{ $t('modules.workflow.addNode') }}
          </el-button>
          <el-button class="button-compact" @click="arrangeWorkflow">
            <Rank />{{ $t('modules.workflow.arrangeLayout') }}
          </el-button>
          <el-button class="button-compact" @click="checkConfig">
            <CircleCheck />{{ $t('modules.workflow.checkConfig') }}
          </el-button>
          <el-button class="button-compact" :disabled="loading" @click="undoChanges">
            <RefreshLeft />{{ $t('modules.workflow.undoChanges') }}
          </el-button>
        </div>
        <span class="workspace-toolbar-note text-caption" :title="$t('ragFlow.tips')">
          {{ $t('modules.workflow.graphStatWithOperators', { nodes: nodeCount, operators: operatorCount, edges: edgeCount }) }}
        </span>
      </div>
    </Teleport>

    <div
      class="flow-surface"
      :class="{ 'is-connecting': connectingSource }"
      @pointermove="updateClickConnection"
      @pointerleave="clearHoveredPort"
      @keydown="handleCanvasKeydown"
    >
      <div class="canvas-viewport" :class="{ 'is-fullscreen': fullscreen }">
        <div id="advancedFLow" class="canvas-world" />
        <div v-if="!fullscreen" class="canvas-hint text-caption">
          {{ connectingSource ? $t('modules.workflow.canvasHintConnecting') : $t('modules.workflow.canvasHint') }}
        </div>
        <div v-else class="canvas-fullscreen-context text-caption" :title="workflowName">
          <span class="flow-fullscreen-context">{{ workflowName }} · {{ $t('modules.workflow.graphStatWithOperators', { nodes: nodeCount, operators: operatorCount, edges: edgeCount }) }}</span>
        </div>
        <!-- 沉浸画布入口：与图谱详情一致，浮在画布右上角（全屏单入口） -->
        <div class="canvas-fullscreen-actions" @pointerdown.stop @mousedown.stop @touchstart.stop @wheel.stop>
          <el-button
            v-if="fullscreen"
            ref="toolsButton"
            class="button-compact"
            :aria-label="$t('modules.workflow.fullscreenTools')"
            :aria-expanded="toolsOpen"
            @click.stop="toolsOpen = !toolsOpen"
          >
            <Setting />{{ $t('modules.workflow.fullscreenTools') }}
          </el-button>
          <el-button
            ref="fullscreenButton"
            class="button-compact"
            :aria-label="fullscreen ? $t('modules.workflow.fullscreenExit') : $t('modules.workflow.fullscreenView')"
            :title="fullscreen ? $t('modules.workflow.fullscreenExit') : $t('modules.workflow.fullscreenView')"
            :aria-pressed="fullscreen"
            @click.stop="toggleFullscreen"
          >
            <component :is="fullscreen ? Close : FullScreen" />{{ fullscreen ? $t('modules.workflow.fullscreenExit') : $t('modules.workflow.fullscreenView') }}
          </el-button>
        </div>
        <!-- 「编排与操作」浮层：全屏后页头的试运行/保存与工具条 Teleport 到这里
             （同一实例，页头正常态还是原位置）。 -->
        <section
          v-show="fullscreen && toolsOpen"
          class="canvas-fullscreen-tools"
          :aria-label="$t('modules.workflow.fullscreenTools')"
          @pointerdown.stop @mousedown.stop @touchstart.stop @wheel.stop
        >
          <div class="flow-fullscreen-panel">
            <div class="flow-fullscreen-panel-header">
              <h2 class="text-secondary">{{ $t('modules.workflow.fullscreenToolsTitle') }}</h2>
              <div id="flow-fullscreen-actions-target" class="flow-primary-actions-target" />
            </div>
            <div id="flow-fullscreen-controls-target" />
          </div>
        </section>
        <div class="canvas-controls" @pointerdown.stop @mousedown.stop @touchstart.stop @wheel.stop>
          <button
            type="button"
            class="icon-button"
            :aria-label="$t('modules.workflow.zoomOut')"
            :title="$t('modules.workflow.zoomOut')"
            @click.stop="zoom('out')"
          >
            <Minus />
          </button>
          <button
            type="button"
            class="canvas-zoom canvas-zoom-reset text-caption"
            :aria-label="$t('modules.workflow.resetZoom')"
            :title="$t('modules.workflow.resetZoomTitle')"
            @click.stop="resetZoom"
          >{{ zoomPercent }}%</button>
          <button
            type="button"
            class="icon-button"
            :aria-label="$t('modules.workflow.zoomIn')"
            :title="$t('modules.workflow.zoomIn')"
            @click.stop="zoom('in')"
          >
            <Plus />
          </button>
          <span class="canvas-control-divider" />
          <button
            type="button"
            class="icon-button"
            :aria-label="$t('modules.workflow.fitCanvas')"
            :title="$t('modules.workflow.fitCanvas')"
            @click.stop="zoom('fit')"
          >
            <Aim />
          </button>
        </div>
        <!-- 连线状态条必须留在画布容器内：沉浸画布会盖住页面层，
             这两条提示放在画布右下角。 -->
        <div v-if="connectingSource" class="flow-floating-bar text-secondary" role="status">
          <span>{{ $t('modules.workflow.connectingFrom', { name: connectingSourceLabel }) }}</span>
          <el-button link @click="cancelConnection">{{ $t('public.cancel') }}</el-button>
        </div>
        <div v-else-if="selectedEdge" class="flow-floating-bar text-secondary" role="status">
          <span>{{ selectedEdge.sourceLabel }} → {{ selectedEdge.targetLabel }}</span>
          <el-button class="danger-action" link type="danger" @click="removeSelectedEdge">
            <Delete />{{ $t('modules.workflow.removeEdge') }}
          </el-button>
        </div>
        <!-- 必须留在 X6 容器（.canvas-world）之外：节点重建时 Vue 会对 Teleport
             锚点做 insertBefore，锚点落在 X6 容器内会报 "not a child of this node"。 -->
        <TeleportContainer />
      </div>
    </div>
    <el-drawer
      v-model="libraryVisible"
      direction="ltr"
      size="min(340px, 100vw)"
      append-to-body
      class="flow-library-drawer"
    >
      <template #header>
        <h2 class="workspace-panel-title text-section-title">
          {{ $t('modules.workflow.addNode') }}
        </h2>
      </template>
      <p class="workspace-panel-intro text-secondary">
        {{ $t('modules.workflow.addNodeIntro') }}
      </p>
      <button
        v-for="module in libraryModules"
        :key="module.shape"
        type="button"
        class="module-option"
        @click="addLibraryNode(module.shape)"
      >
        <span :class="['module-icon', module.tone]">
          <component :is="module.icon" />
        </span>
        <span>
          <strong class="text-body">{{ $t(module.labelKey) }}</strong>
          <span class="text-secondary">{{ module.operatorKeys.map(key => $t(key)).join(' / ') }}</span>
        </span>
        <Plus />
      </button>
    </el-drawer>

    <DrawerFrame
      ref="drawerFrameRef"
      :title="drawerTitle"
      :node-label="drawerBasics.label"
      :operator-count="drawerOperatorCount"
      :tone="drawerTone"
      :fixed="drawerFixed"
      :fixed-direction="drawerFixedDirection"
      :fixed-field="drawerFixedField"
      :upstreams="drawerBasics.upstreams"
      :upstream-options="drawerUpstreamOptions"
      @update:node-label="drawerBasics.label = $event"
      @update:upstreams="drawerBasics.upstreams = $event"
      @delete="deleteCurrentNode"
      @submitHandle="drawerSubmitHandle"
      @cancelHandle="drawerCancelHandle"
      @closed="drawerCancelHandle"
    >
      <component
        :is="dynamicComponent"
        v-if="dynamicComponent && isComponentLoaded"
        :ref="`${currentNodeData?.componentType}Ref`"
        :form-data="currentNodeData.variables"
        :node-id="currentNodeData.id"
        :component-type="currentNodeData?.componentType"
        @config-error="showDrawerError"
        @operator-count="drawerOperatorCount = $event"
      />
    </DrawerFrame>
  </WorkspaceShell>
</template>
<script setup>
import {
  Check, Plus, Minus, VideoPlay, CircleCheck, RefreshLeft, Aim, FullScreen, Close, Setting, Rank, Delete,
  MagicStick, Search, Histogram, ChatDotRound
} from '@/shared/lib/icons';
import WorkspaceShell from '@/app/layout/WorkspaceShell.vue';
import { WorkflowIcon } from '@/shared/ui/icons';
</script>
<script>
import { getTeleport } from '@antv/x6-vue-shape'
import DrawerFrame from '@/features/workflow/DrawerFrame.vue'
import CalculatePort from '@/features/workflow/calculatePort'
import { THEME_CHANGE_EVENT } from '@/shared/lib/theme'
import { useFlowCanvas } from '@/features/workflow/composables/useFlowCanvas'
import { useFlowGeometry } from '@/features/workflow/composables/useFlowGeometry'
import { useFlowConnections } from '@/features/workflow/composables/useFlowConnections'
import { useFlowGraphData } from '@/features/workflow/composables/useFlowGraphData'
import { useFlowDrawer } from '@/features/workflow/composables/useFlowDrawer'
import { useFlowPersistence } from '@/features/workflow/composables/useFlowPersistence'

const TeleportContainer = getTeleport()

/**
 * 编排画布页（workflow feature 的核心编辑器，路由 /flow/detail/:id）。
 *
 * script 按职责拆进 features/workflow/composables/：
 *   useFlowCanvas      —— X6 画布装配（实例/事件监听/主题/视口/节点注册）
 *   useFlowGeometry    —— 卡片几何/端口/连线装饰/统计/排版与缩放
 *   useFlowConnections —— 连线交互（拖拽与点击连线、选边、成环检测）
 *   useFlowGraphData   —— 画布 ⇄ 后端 DTO 装配、节点创建与导入
 *   useFlowDrawer      —— 节点配置抽屉与卡片回调、删除确认
 *   useFlowPersistence —— 发布与校验、后端 flow api 的加载/保存链路
 *
 * 各 composable 返回方法映射并展开进 methods：方法体仍通过组件实例
 * （this.graph / data / $t / $refs）协作，与拆分前逐字等价，对外行为
 * （路由参数、保存/发布链路、快捷键）不变。本文件只保留页面外壳
 * （全屏、浮层、返回）与生命周期。
 */
export default {
  name: 'CustomizedAdvancedFlow',
  components: {
    DrawerFrame,
    TeleportContainer
  },
  mixins: [CalculatePort],
  data () {
    return {
      graph: null,
      fullscreen: false,
      // 全屏时的「编排与操作」浮层：页头操作与工具条 Teleport 进去
      toolsOpen: false,
      // 「添加节点」放在抽屉里，画布默认占满整行；需要时点工具条按钮再展开。
      libraryVisible: false,
      currentNodeId: '',
      drawerInputs: [],
      libraryModules: [
        { shape: 'preretriever', labelKey: 'ragFlow.preretrieverTitle', tone: 'purple', icon: MagicStick, operatorKeys: ['ragFlow.LLMQueryRewriterOperator'] },
        { shape: 'retriever', labelKey: 'ragFlow.retrieverTitle', tone: 'orange', icon: Search, operatorKeys: ['ragFlow.KnowledgeGraphRetrieverOperator', 'ragFlow.FusionRetrieverOperator', 'ragFlow.VectorRetrieverOperator', 'ragFlow.KeywordRetrieverOperator'] },
        { shape: 'postretriever', labelKey: 'ragFlow.postretrieverTitle', tone: 'blue', icon: Histogram, operatorKeys: ['ragFlow.LLMRerankerOperator', 'ragFlow.ExternalModelRerankerOperator'] },
        { shape: 'responsesynthesizer', labelKey: 'ragFlow.responsesynthesizerTitle', tone: 'green', icon: ChatDotRound, operatorKeys: ['ragFlow.RagSimpleSummarizerOperator'] }
      ],
      nodeCount: 0,
      edgeCount: 0,
      operatorCount: 0,
      sourceKinds: [],
      selectedEdge: null,
      connectingSource: '',
      connectingSourceLabel: '',
      connectingPortId: '',
      connectionTargetId: '',
      previewEdgeId: '',
      hoveredPortEl: null,
      portSideCache: {},
      decorateFrame: null,
      decorateIdle: null,
      geometryFrame: null,
      drawerBasics: { label: '', upstreams: [] },
      drawerUpstreamOptions: [],
      drawerTone: 'blue',
      drawerFixed: false,
      drawerFixedDirection: '',
      drawerFixedField: '',
      drawerOperatorCount: 0,
      isEditMode: false, // 高级编排画布是否处于编辑模式
      isRunning: false,
      nodeLoaded: true,
      // 画布上这张图属于哪个工作流。切换工作流时先置空，等新数据真的落到图上再置成新 appId。
      // 保存时拿它和 saveAppId 比对，避免把 A 的图存进 B、或把刚清空还没加载完的空图存下去
      graphAppId: '',
      // 本次保存的目标工作流，在点击「保存」那一刻定下来，整条异步链都用它
      saveAppId: '',
      // 缩放条中间的百分比（随 X6 的 scale 事件更新）
      zoomPercent: 100,
      currentDragNodeId: '',
      jsonDTO: {},
      dynamicComponent: null,
      debounceTime: null,
      timerInterval: 300,
      drawerTitle: '',
      queryEngineType: '',
      loadSubmit: false,
      isComponentLoaded: false,
      workflowName: '',
      workflowId: '',
      // 发布态（GET /flow 的 publishType）：0 未发布 / 1 已发布 / 2 发布后修改。
      // 保存草稿不会改变线上快照；据此在保存成功后提示「要重新发布」。
      workflowPublishType: 0,
      currentNodeData: {
        label: '',
        componentType: '',
        variables: ''
      },
      version: 1,
      shapeAndPortIdMap: {
        PRE_RETRIEVER: 'preretriever',
        RETRIEVER: 'retriever',
        POST_RETRIEVER: 'postretriever',
        RESPONSE_SYNTHESIZER: 'responsesynthesizer'
      },
      queryengineMap: {
        SequentialQueryEngine: {
          id: 0,
          package: 'core.rag.query_engine.sequential_query_engine',
          operator: 'SequentialQueryEngine',
          desc: '',
          kwargs: {}
        },
        ConditionalQueryEngine: {
          id: 0,
          package: 'core.rag.query_engine.conditional_query_engine',
          operator: 'ConditionalQueryEngine',
          desc: '',
          kwargs: {}
        },
        BlendedQueryEngine: {
          id: 0,
          package: 'core.rag.query_engine.blended_query_engine',
          operator: 'BlendedQueryEngine',
          desc: '',
          kwargs: {}
        }
      },
      workflowTypeMap: {
        SequentialQueryEngine: this.$t('ragFlow.sequenceWorkflow'),
        ConditionalQueryEngine: this.$t('ragFlow.conditionWorkflow'),
        BlendedQueryEngine: this.$t('ragFlow.mixWorkflow')
      },
      debouncedInput: null,
      loading: false,
      // 等 X6 把视图渲染完（render:done）再做 100% 排版：提前量 DOM 会量不到
      // Vue 卡片，只能退回 1×1/250 的默认值，节点会叠在一起。
      pendingArrange: false,
      arrangeFallbackTimer: null,
      arrangeRetryTimer: null,
      lastCardSizeSignature: ''
    }
  },
  watch: {
    // 只换 id 时（#/flow/detail/A → #/flow/detail/B）属于同一路由只变参数，
    // Vue Router 会复用本组件实例、mounted 不会再跑 —— 不监听的话画布会一直
    // 停留在上一个工作流的图上（标题/URL 已经变了，图还是旧的）
    '$route.params.id' () {
      this.reloadAdvancedFlow();
    }
  },
  created () {
  },
  mounted () {
    this.initGraph();
    this.setGraphEventAndNodeInfo();
    this.getAdvancedFlowConfig();

    // 用 ResizeObserver 跟随容器：首帧量到的尺寸可能
    // 早于字体/布局落定，这里等画布盒子真正稳定后再让 X6 重算一次。
    const viewport = this.$el?.querySelector?.('.canvas-viewport')
    if (viewport && typeof ResizeObserver !== 'undefined') {
      this.canvasResizeObserver = new ResizeObserver(() => this.setGraphSize())
      this.canvasResizeObserver.observe(viewport)
    }
    window.addEventListener('resize', this.setGraphSize)
    window.addEventListener('keydown', this.handleFullscreenEsc)
    // 主题切换时原地重刷连线/链接桩的颜色（不重建 Graph，节点坐标与视口保持不变）
    this.themeChangeHandler = () => this.applyGraphTheme()
    window.addEventListener(THEME_CHANGE_EVENT, this.themeChangeHandler)
    this.connectionKeyHandler = event => this.handleConnectionKey(event)
    document.addEventListener('keydown', this.connectionKeyHandler, true)
  },
  beforeUnmount () {
    if (this.canvasResizeObserver) {
      this.canvasResizeObserver.disconnect()
      this.canvasResizeObserver = null
    }
    window.removeEventListener('resize', this.setGraphSize);
    window.removeEventListener('keydown', this.handleFullscreenEsc);
    if (this.themeChangeHandler) {
      window.removeEventListener(THEME_CHANGE_EVENT, this.themeChangeHandler)
      this.themeChangeHandler = null
    }
    // 排版是在等卡片 DOM 的轮询里完成的，离开页面时要停掉，避免对已销毁的图操作
    this.pendingArrange = false
    if (this.arrangeFallbackTimer) {
      clearTimeout(this.arrangeFallbackTimer)
    }
    if (this.arrangeRetryTimer) {
      clearTimeout(this.arrangeRetryTimer)
    }
    this.cancelConnection()
    if (this.connectionKeyHandler) {
      document.removeEventListener('keydown', this.connectionKeyHandler, true)
      this.connectionKeyHandler = null
    }
    if (this.decorateFrame) {
      cancelAnimationFrame(this.decorateFrame)
      this.decorateFrame = null
    }
    if (this.decorateIdle) {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this.decorateIdle)
      } else {
        clearTimeout(this.decorateIdle)
      }
      this.decorateIdle = null
    }
    if (this.geometryFrame) {
      cancelAnimationFrame(this.geometryFrame)
      this.geometryFrame = null
    }
  },
  methods: {
    // 按职责拆分的画布/几何/连线/数据装配/抽屉/后端装配方法（见文件头注释）
    ...useFlowCanvas(),
    ...useFlowGeometry(),
    ...useFlowConnections(),
    ...useFlowGraphData(),
    ...useFlowDrawer(),
    ...useFlowPersistence(),
    toggleFullscreen () {
      this.fullscreen = !this.fullscreen
      // 进出全屏都收起「编排与操作」浮层
      this.toolsOpen = false
      // 全屏切换会改变画布可用尺寸，等布局落定后再让 X6 重新量一次
      this.$nextTick(() => {
        this.setGraphSize && this.setGraphSize()
        this.$refs.fullscreenButton?.$el?.focus?.()
      })
    },
    toggleLibrary () {
      // 「添加节点」是左侧抽屉：覆盖在画布上，不改变画布尺寸
      this.toolsOpen = false
      this.libraryVisible = !this.libraryVisible
    },
    /** Esc：抽屉/弹窗/下拉先自己消费；再收「编排与操作」浮层；最后才退出全屏。 */
    handleFullscreenEsc (event) {
      if (event.key !== 'Escape' || !this.fullscreen || event.defaultPrevented) {
        return
      }
      const overlayOpen = [...document.querySelectorAll('.el-drawer,.el-dialog,.el-message-box,.el-select__popper')]
        .some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      if (overlayOpen) {
        return
      }
      if (this.toolsOpen) {
        this.toolsOpen = false
        this.$refs.toolsButton?.$el?.focus?.()
        return
      }
      this.fullscreen = false
      this.$nextTick(() => this.setGraphSize && this.setGraphSize())
    },
    /** 试运行按钮是禁用态，点击由外层 span 接住（见模板注释 ③） */
    showTrialRunHint () {
      this.$message.info(this.$t('modules.workflow.trialRunNotConnected'))
    },
    checkConfig () {
      this.$message.info(this.$t('modules.workflow.checkConfigHint', {
        nodes: this.nodeCount,
        edges: this.edgeCount
      }))
    },
    goBack () {
      // 历史实现会在「生产构建且不在 iframe 中」时跳出站点、回到外部门户；这套
      // 前提在独立部署下不成立——站点本身就在根路径、生产构建、且不在 iframe 中，
      // 跳转目标却不存在。请求会落到一个不存在的路径，nginx 的
      // `try_files $uri $uri/ /index.html` 把它回退成 index.html，而 hash
      // 又匹配不到任何路由，router-view 渲染为空 → 白屏卡死。
      // 详情页通常是从知识检索列表点进来的，所以优先真回退：能保留列表的分页/筛选状态，
      // 也不会在历史里堆出「列表 → 详情 → 列表」——那样点完页内返回再按浏览器返回键
      // 又会弹回详情页。直接深链打开详情页时应用内没有可回退的历史，兜底 push 到列表。
      if (this.$router.options.history.state?.back) {
        this.$router.back();
      } else {
        this.$router.push('/flow');
      }
    }
  }
}
</script>
<style lang="less" scoped>
/* 画布外层只负责占满剩余高度；
   边框/圆点背景/内距全部由 `styles/workspaces.css` 的 .canvas-viewport 提供。 */
.flow-surface {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
/* 沉浸画布：整块画布铺满窗口，
   入口按钮浮在画布右上角，页头/工具条被盖住，Esc 退出。 */
.canvas-viewport.is-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 100;
  width: 100%;
  height: 100dvh;
  min-height: 0;
  border: 0;
  border-radius: 0;
}
/* 整理布局后布局从 y=60 起排，zoom('fit') 的居中/上对齐会把「开始」卡片
   顶边带到 ~32px，压到左上角提示行（16–41px）的最后 8–10px。提示行整体
   上移 12px（4px 起），保住 3px 间隙；全局 .canvas-hint 保持不动。 */
.flow-surface .canvas-hint {
  top: 4px;
}
.canvas-fullscreen-actions {
  position: absolute;
  z-index: 2;
  top: 16px;
  right: 18px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  max-width: calc(100% - 36px);
}
.canvas-fullscreen-actions .el-button {
  background: var(--rs-bg-card);
}
/* 画布右上角有按钮时，左下角提示文字让出宽度（同 .canvas-hint 规则）。 */
.canvas-viewport:has(.canvas-fullscreen-actions) .canvas-hint {
  max-width: calc(100% - 170px);
}
/* 全屏后页头整体隐藏，试运行/保存/工具条搬进「编排与操作」浮层 */
.advanced-flow.is-flow-fullscreen :deep(.workspace-header) {
  display: none;
}
/* 与左上提示行同理：全屏上下文（名称 + 统计）也上移 12px（22 → 10），
   否则 zoom('fit') 居中后「开始」卡片顶边（~32px）会压住文字（22–41px）。
   窄屏保持 56px（顶部按钮换行后另排）。 */
.canvas-fullscreen-context {
  position: absolute;
  top: 10px;
  left: 18px;
  max-width: calc(100% - 300px);
  color: var(--rs-text-3);
  pointer-events: none;
}
.flow-fullscreen-context {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.canvas-fullscreen-tools {
  position: absolute;
  z-index: 3;
  top: 56px;
  right: 18px;
  width: min(700px, calc(100% - 36px));
  max-height: calc(100dvh - 140px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  background: var(--rs-bg-card);
  box-shadow: 0 8px 28px #10224918;
}
.flow-fullscreen-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.flow-fullscreen-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rs-border-soft);
}
.flow-fullscreen-panel-header h2 {
  margin: 0;
  font-weight: 600;
  color: var(--rs-text);
}
.flow-primary-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.flow-primary-actions-target {
  display: flex;
  align-items: center;
}
.flow-fullscreen-panel .workspace-toolbar {
  gap: 12px;
}
.flow-fullscreen-panel .workspace-toolbar-group,
.flow-fullscreen-panel .flow-primary-actions {
  gap: 8px;
}
.flow-fullscreen-panel .workspace-toolbar-note {
  width: 100%;
}
/* 浮层与左下角缩放条同层时，缩放条不被面板压住 */
.canvas-controls {
  z-index: 2;
}
@media (max-width: 700px) {
  .canvas-fullscreen-actions {
    top: 10px;
    right: 10px;
  }
  .canvas-fullscreen-context {
    top: 56px;
    left: 12px;
    max-width: calc(100% - 24px);
  }
  .canvas-fullscreen-tools {
    top: 84px;
    right: 10px;
    width: calc(100% - 20px);
  }
  .flow-fullscreen-panel .workspace-toolbar-group {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }
  .flow-fullscreen-panel-header {
    flex-wrap: wrap;
  }
  .flow-floating-bar {
    bottom: 72px;
    right: 12px;
    max-width: calc(100% - 24px);
  }
}
/* 「添加节点」抽屉（左滑 340px）与模块卡片 */
.module-option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 16px;
  border: 1px solid var(--rs-border);
  background: var(--rs-bg-card);
  border-radius: 8px;
  margin-bottom: 12px;
  text-align: left;
  color: var(--rs-text);
  cursor: pointer;
}
.module-option:hover {
  border-color: var(--rs-primary-border);
  background: var(--rs-bg-hover);
}
.module-option > span:nth-child(2) {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.module-option > span:nth-child(2) > span {
  color: var(--rs-text-3);
}
.module-option > svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--rs-text-3);
}
.module-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex-shrink: 0;
  color: var(--tone);
  background: var(--tint);
}
.module-icon svg {
  width: 20px;
  height: 20px;
}
/* ── 画布：卡片选中、端口、连线与箭头 ─────────────────────────────── */

/* 选中节点：主色描边 + 2px 弱光环（.flow-node.selected） */
.flow-surface .canvas-viewport :deep(.x6-node.selected .ai-card-frame) {
  border-color: var(--rs-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--rs-primary) 12%, transparent);
}

/* 端口：第一层是透明命中圆（r=9），第二层视觉圆 9px，白底 1.5px 描边 */
.flow-surface .canvas-viewport :deep(.x6-port-body > circle:nth-child(1)) {
  fill: transparent;
  stroke: transparent;
  pointer-events: all;
}
.flow-surface .canvas-viewport :deep(.x6-port-body > circle:nth-child(2)) {
  fill: var(--rs-bg-card, #ffffff);
  stroke: var(--rs-edge, #8faedc);
  stroke-width: 1.5px;
  cursor: crosshair;
  transition: fill 0.15s, stroke 0.15s;
}
.flow-surface .canvas-viewport :deep(.x6-port-body:hover > circle:nth-child(2)),
.flow-surface .canvas-viewport :deep(.x6-port-body.is-target > circle:nth-child(2)) {
  fill: var(--rs-primary);
  stroke: var(--rs-primary);
}
.flow-surface .canvas-viewport :deep(.x6-port-body:hover > circle:nth-child(1)),
.flow-surface .canvas-viewport :deep(.x6-port-body:focus-visible > circle:nth-child(1)),
.flow-surface .canvas-viewport :deep(.x6-port-body.is-target > circle:nth-child(1)) {
  stroke: color-mix(in srgb, var(--rs-primary) 16%, transparent);
  stroke-width: 8px;
}
.flow-surface .canvas-viewport :deep(.x6-port-body:focus) {
  outline: none;
}
.flow-surface .canvas-viewport :deep(.x6-port-body:focus-visible > circle:nth-child(2)) {
  fill: var(--rs-primary);
  stroke: var(--rs-primary);
}
/* 点击输出端点后：所有输入端点高亮，提示可落点 */
.flow-surface.is-connecting .canvas-viewport :deep(.x6-port-body[port-group='in'] > circle:nth-child(2)) {
  fill: var(--rs-bg-selected);
  stroke: var(--rs-primary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--rs-primary) 12%, transparent);
}
.flow-surface.is-connecting .canvas-viewport :deep(.x6-port-body[port-group='in']) {
  cursor: crosshair;
}

/* 连线：1.6px 蓝灰细线；悬停/选中主色 2px */
.flow-surface .canvas-viewport :deep(.flow-connection > path:nth-child(2)) {
  stroke: color-mix(in srgb, var(--rs-edge) 78%, var(--rs-primary) 22%);
  stroke-width: 1.6px;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke 0.15s, stroke-width 0.15s;
}
.flow-surface .canvas-viewport :deep(.flow-connection:hover > path:nth-child(2)),
.flow-surface .canvas-viewport :deep(.flow-connection.selected > path:nth-child(2)),
.flow-surface .canvas-viewport :deep(.flow-connection > path:nth-child(1):focus-visible + path) {
  stroke: var(--rs-primary);
  stroke-width: 2px;
}
/* 线中段箭头：画布底色描边，保证压在网格上也清晰 */
.flow-surface .canvas-viewport :deep(.flow-edge-direction) {
  fill: color-mix(in srgb, var(--rs-primary) 75%, var(--rs-edge) 25%);
  stroke: var(--rs-canvas-bg, #f8fafd);
  stroke-width: 2.5px;
  stroke-linejoin: round;
  paint-order: stroke fill;
  pointer-events: none;
}
.flow-surface .canvas-viewport :deep(.flow-connection:hover .flow-edge-direction),
.flow-surface .canvas-viewport :deep(.flow-connection.selected .flow-edge-direction) {
  fill: var(--rs-primary);
}
/* 点击连线模式的预览边 */
.flow-surface .canvas-viewport :deep(.flow-edge-preview > path:nth-child(2)) {
  stroke: var(--rs-primary);
  stroke-width: 2px;
  stroke-dasharray: 6 5;
  stroke-linecap: round;
}

/* 右上角连线状态条 */
.flow-floating-bar {
  position: absolute;
  bottom: 18px;
  right: 18px;
  max-width: calc(100% - 230px);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  background: var(--rs-bg-card);
  border: 1px solid var(--rs-border);
  padding: 10px 14px;
  border-radius: 8px;
  box-shadow: 0 4px 12px #19264c08;
  z-index: 5;
  cursor: default;
}
</style>

<style lang="less" scoped>
/* 试运行按钮：外观禁用、点击仍可触发外层的提示。
   el-button[disabled] 自身不派发 click，所以让它不接收指针事件，
   事件落到外层 span（span 有 @click），鼠标指针仍显示禁用箭头。 */
.trial-run-wrap { display: inline-flex; }
.trial-run-wrap .trial-run-btn { pointer-events: none; cursor: not-allowed; }
</style>
