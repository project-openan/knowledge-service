<template>
  <div class="graph-visualization" :class="{ 'is-fullscreen': fullscreen.fullscreen }">
    <!-- 工具条 + 摘要行（全屏时整体收进「查询与操作」浮层） -->
    <div
      class="graph-controls"
      :class="{ 'is-overlay': fullscreen.fullscreen && fullscreen.toolsOpen }"
      :role="fullscreen.fullscreen ? 'region' : undefined"
      :aria-label="fullscreen.fullscreen ? $t('modules.kb.graphFullscreenToolsRegion') : undefined"
      @click.stop
    >
      <GraphControls
        ref="controlsRef"
        :entity-types="availableEntityTypes"
        :edge-types="availableEdgeTypes"
        :selected-entity-types="selectedEntityTypes"
        :selected-edge-types="selectedEdgeTypes"
        :limit-value="limitValue"
        :depth-value="depthValue"
        :search-keyword="props.searchKeyword"
        :total-nodes="totalNodes"
        :total-edges="totalEdges"
        :zoom-level="viewport.zoomLevel"
        :entity-type-properties="entityTypePropertiesMap"
        :edge-type-properties="edgeTypePropertiesMap"
        :reset-token="props.resetToken"
        @entity-type-change="handleEntityTypeChange"
        @edge-type-change="handleEdgeTypeChange"
        @limit-change="handleLimitChange"
        @depth-change="handleDepthChange"
        @export="handleExport"
        @search-input="handleSearchInput"
        @search-clear="handleSearchClear"
        @execute-query="handleExecuteQuery"
        @query-type-change="handleQueryTypeChange"
        @advanced-open="fullscreen.closeTools"
        :refresh-graph="handleToolbarRefresh"
        :floating="fullscreen.fullscreen"
      />

      <!-- 摘要行：实体/关系数量 + 显示上限 + 关系名称开关 + 重置布局 -->
      <div class="graph-display-summary text-secondary">
        <div class="graph-display-meta">
          <i18n-t keypath="modules.kb.showingGraph" tag="span">
            <template #nodes><b>{{ totalNodes }}</b></template>
            <template #edges><b>{{ totalEdges }}</b></template>
          </i18n-t>
          <!-- 结果旁常驻「显示上限 N」，点击回到高级查询。 -->
          <el-button link type="primary" class="graph-limit-link" @click="openAdvancedQuery">
            {{ $t('modules.kb.graphDisplayLimit', { limit: limitValue }) }}
          </el-button>
        </div>
        <div class="graph-display-actions">
          <el-checkbox
            :model-value="viewport.edgeLabelDisplayMode === 'inline'"
            @change="viewport.toggleEdgeLabels"
          >
            {{ $t('modules.kb.relationNames') }}
          </el-checkbox>
          <el-button link @click="viewport.resetGraphLayout">
            {{ $t('modules.kb.resetLayout') }}
          </el-button>
          <!-- 添加实体与添加关系并列在摘要行右侧。 -->
          <div class="graph-create-actions" role="group" :aria-label="$t('modules.kb.graphCreateActions')">
            <el-button class="button-compact" type="primary" @click="entity.openCreateDrawer">
              <Plus />{{ $t('modules.kb.createEntity') }}
            </el-button>
            <el-button class="button-compact" @click="relation.openRelationDrawer()">
              <Link />{{ $t('modules.kb.addRelationship') }}
            </el-button>
          </div>
        </div>
        <!-- 截断提示单独占一行：摘要行与右侧操作保持同一行（紧凑浮层的排法）。 -->
        <span v-if="resultHasMore" class="graph-limit-notice text-caption">
          {{ $t('modules.kb.graphLimitNotice', { limit: limitValue }) }}
        </span>
      </div>
    </div>

    <!-- 图表容器 -->
    <div class="graph-container" ref="graphContainer" @click="handleContainerClick">
      <div v-if="!fullscreen.fullscreen" class="graph-canvas-hint text-caption">{{ $t('modules.kb.graphCanvasHint') }}</div>
      <div v-if="fullscreen.fullscreen" class="graph-fullscreen-context text-caption">
        {{ $t('modules.kb.graphFullscreenContext', { name: graphName, nodes: totalNodes, edges: totalEdges, limit: limitValue }) }}
      </div>
      <div class="graph-fullscreen-actions" @click.stop>
        <el-button
          v-if="fullscreen.fullscreen"
          class="button-compact"
          :aria-expanded="fullscreen.toolsOpen"
          @click="fullscreen.toolsOpen = !fullscreen.toolsOpen"
        >
          <Filter />{{ $t('modules.kb.graphFullscreenTools') }}
        </el-button>
        <el-button
          ref="fullscreenButton"
          class="button-compact"
          :aria-label="fullscreen.fullscreen ? $t('modules.kb.graphFullscreenExit') : $t('modules.kb.graphFullscreenView')"
          :title="fullscreen.fullscreen ? $t('modules.kb.graphFullscreenExit') : $t('modules.kb.graphFullscreenView')"
          @click="fullscreen.toggleFullscreen"
        >
          <component :is="fullscreen.fullscreen ? Close : FullScreen" />{{ fullscreen.fullscreen ? $t('modules.kb.graphFullscreenExit') : $t('modules.kb.graphFullscreenView') }}
        </el-button>
      </div>
      <!-- 左下角：缩略图、缩放、图例、连线配置（含左上角图例浮层），样式随子组件走 -->
      <GraphCanvasTools
        :viewport="viewport"
        :thumbnail="thumbnail"
        :tones="tones"
        :fullscreen="fullscreen.fullscreen"
      />

      <!-- 图谱画布：vis-network -->
      <div class="graph-vis-wrapper">
        <GraphCanvasVis
          ref="graphCanvasRef"
          :graph-data="graphDataCache"
          :color-map="tones.colorMap"
          :edge-color-map="tones.edgeColorMap"
          :graph-id="String(route.params?.id || '')"
          :reset-token="props.resetToken"
          :persistently-hidden-node-ids="expand.persistentlyHiddenNodeIdsList"
          :entity-expand-state-map="expand.entityExpandStateForCanvas"
          :edge-label-display-mode="viewport.edgeLabelDisplayMode"
          @node-click="selection.handleNodeClickFromCanvas"
          @edge-click="edgeCrud.handleCanvasEdgeClick"
          @container-click="handleContainerClickFromCanvas"
          @zoom-change="viewport.onVisZoomChange"
          @node-double-click="selection.handleNodeDoubleClickFromCanvas"
          @edge-double-click="edgeCrud.handleEdgeDoubleClickFromCanvas"
          @toggle-expand="expand.handleToggleExpandFromCanvas"
          @after-drawing="thumbnail.handleCanvasAfterDrawing"
        />
      </div>

      <!-- 实体/边的操作气泡卡片（选中后延迟弹出） -->
      <GraphActionPopovers
        :selection="selection"
        :entity="entity"
        :relation="relation"
        :edge="edgeCrud"
      />
    </div>

    <!-- 画布下方常驻实体类型图例（全屏时隐藏） -->
    <div v-if="!fullscreen.fullscreen" class="graph-legend-row text-caption" :aria-label="t('modules.kb.entityTypes')">
      <span v-for="item in tones.entityLegendItems" :key="item.type">
        <i :style="{ background: item.color }" />{{ item.type }}
      </span>
    </div>

    <!-- 实体编辑抽屉：双击节点或气泡「编辑」打开 -->
    <GraphEntityDrawer
      v-model="entity.editDrawerVisible"
      :entity="selection.selectedEntity"
      :entity-type="entity.selectedEntityTypeInfo"
      :property-defs="entity.selectedEntityPropertyDefs"
      :relations="entity.selectedEntityRelations"
      :saving="entity.entityDrawerSaving"
      @save="entity.handleEntityDrawerSave"
      @select="entity.handleEntityDrawerSelect"
      @locate="entity.handleEntityDrawerLocate"
      @add-relation="relation.openRelationDrawer(selection.selectedEntity)"
    />

    <!-- 新增实体抽屉：工具栏主按钮打开，不依赖选中节点 -->
    <GraphEntityCreateDrawer
      v-model="entity.createDrawerVisible"
      :graph-name="graphName"
      :entity-types="availableEntityTypes"
      :type-tones="tones.typeToneMap"
      :entities="graphDataCache.entities"
      :property-defs="entity.createEntityPropertyDefs"
      :edge-types-for="getAvailableEdgeTypesForEntities"
      :saving="entity.createEntitySaving"
      @create="entity.handleCreateEntity"
    />

    <!-- 添加关系抽屉：摘要行、节点气泡与画布连线模式共用 -->
    <GraphRelationCreateDrawer
      v-model="relation.drawerVisible"
      :source-id="relation.sourceId"
      :target-id="relation.targetId"
      :nodes="graphDataCache.entities"
      :edges="graphDataCache.edges"
      :type-tones="tones.typeToneMap"
      :edge-types-for="getAvailableEdgeTypesForEntities"
      :saving="relation.saving"
      @save="relation.handleRelationSave"
    />

    <!-- 边的查看/编辑抽屉（状态与提交逻辑在 useGraphEdgeCrud） -->
    <GraphEdgeDrawers :edge="edgeCrud" />

  </div>
</template>

<script setup>
/**
 * 知识图谱可视化组件
 * 画布由 GraphCanvasVis（vis-network）渲染，graphDataCache 与父组件数据保持同步。
 *
 * 职责拆分（对外 props/emits/暴露方法不变）：
 * - 纯函数（schema 规整 / 展开子孙遍历 / 缩略图投影 / 包围盒求心）→ lib/graph-*.js
 * - 边 CRUD（选中、气泡、查看/编辑抽屉、删除）→ composables/useGraphEdgeCrud.js
 *   + components/graph-visualization/GraphEdgeDrawers.vue（两个抽屉的模板与样式）
 * - 实体编辑/新增/删除 → composables/useGraphEntityCrud.js
 * - 实体展开/收起 → composables/useEntityExpand.js（遍历在 lib/graph-descendants.js）
 * - 添加关系抽屉与画布连线模式 → composables/useGraphRelationDrawer.js
 * - 画布视野（缩放/居中/图例/连线标签模式）→ composables/useGraphViewport.js
 * - 缩略图快照 → composables/useGraphThumbnail.js（投影在 lib/graph-thumbnail.js）
 * - 沉浸画布（全屏）→ composables/useGraphFullscreen.js
 * - 节点选中与操作气泡 → composables/useGraphSelection.js
 *   + components/graph-visualization/GraphActionPopovers.vue
 * - 配色与图例派生 → composables/useGraphTones.js
 * - 左下角工具簇模板/样式 → components/graph-visualization/GraphCanvasTools.vue
 * 本文件只保留：对外接口（props/emits/expose）、组合各 composable、
 * 跨职责的少量胶水（容器点击收起浮层、控制面板事件转发、缓存同步 watch）。
 */

import { ref, onMounted, computed, watch, nextTick, getCurrentInstance } from 'vue'
import { Close, FullScreen, Filter, Link, Plus } from '@element-plus/icons-vue'

import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GraphControls from './GraphControls.vue'
import GraphCanvasVis from './GraphCanvasVis.vue'
import GraphEntityDrawer from './GraphEntityDrawer.vue'
import GraphEntityCreateDrawer from './GraphEntityCreateDrawer.vue'
import GraphRelationCreateDrawer from './GraphRelationCreateDrawer.vue'
import GraphEdgeDrawers from './graph-visualization/GraphEdgeDrawers.vue'
import GraphCanvasTools from './graph-visualization/GraphCanvasTools.vue'
import GraphActionPopovers from './graph-visualization/GraphActionPopovers.vue'
import { useGraphTones } from '../composables/useGraphTones'
import { useGraphSelection } from '../composables/useGraphSelection'
import { useGraphEdgeCrud } from '../composables/useGraphEdgeCrud'
import { useGraphEntityCrud } from '../composables/useGraphEntityCrud'
import { useGraphRelationDrawer } from '../composables/useGraphRelationDrawer'
import { useGraphViewport } from '../composables/useGraphViewport'
import { useGraphThumbnail } from '../composables/useGraphThumbnail'
import { useGraphFullscreen } from '../composables/useGraphFullscreen'
import { useEntityExpand } from '../composables/useEntityExpand'
import {
  collectEntityTypeProperties,
  collectEdgeTypeProperties,
  getEdgeTypesForEntities
} from '../lib/graph-schema'

// 国际化
const { t } = useI18n()

const props = defineProps({
  graphData: {
    type: Object,
    required: true,
    default: () => ({
      entities: [],
      edges: []
    })
  },
  entityTypes: {
    type: Array,
    default: () => []
  },
  edgeTypes: {
    type: Array,
    default: () => []
  },
  selectedEntityTypes: {
    type: Array,
    default: () => []
  },
  selectedEdgeTypes: {
    type: Array,
    default: () => []
  },
  limitValue: {
    type: Number,
    default: 100
  },
  depthValue: {
    type: Number,
    default: 10
  },
  schemaMapping: {
    type: Object,
    default: () => ({
      entity_meta: {},
      adjacency_map: {}
    })
  },
  searchKeyword: {
    type: String,
    default: ''
  },
  isManualQuery: {
    type: Boolean,
    default: false
  },
  lastQueryPayload: {
    type: Object,
    default: null
  },
  resetToken: {
    type: Number,
    default: 0
  },
  /** 图谱名称（新增实体抽屉副标题）。 */
  graphName: {
    type: String,
    default: ''
  },
  /** 详情页注入的「刷新知识图谱」实现；未注入时退回服务端刷新事件。 */
  refreshGraph: {
    type: Function,
    default: null
  },
  /** 后端 has_more —— 当前结果可能已被 Limit 截断。 */
  resultHasMore: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits([
  'refresh-graph-data',
  'entity-type-change',
  'edge-type-change',
  'limit-change',
  'depth-change',
  'export',
  'search-clear',
  'execute-query',
  'query-type-change',
  'fullscreen-change'
])

// 路由
const route = useRoute()

// 获取实例
const { proxy } = getCurrentInstance()

// 图表引用
const graphContainer = ref(null)
const graphCanvasRef = ref(null)
const controlsRef = ref(null)
const fullscreenButton = ref(null)

// 可用的实体类型和边类型（父组件传入的模板 schema）
const availableEntityTypes = computed(() => props.entityTypes || [])
const availableEdgeTypes = computed(() => props.edgeTypes || [])

/** 实体类型 → 属性定义数组（GraphControls 的属性筛选） */
const entityTypePropertiesMap = computed(() => collectEntityTypeProperties(props.schemaMapping?.entity_meta || {}))

/** 边类型 → 合并去重后的属性定义数组（GraphControls 的属性筛选） */
const edgeTypePropertiesMap = computed(() => collectEdgeTypeProperties(props.schemaMapping?.adjacency_map || {}))

/** 根据实体类型A和B获取可用的边类型（新增实体 / 添加关系抽屉共用） */
function getAvailableEdgeTypesForEntities (entityTypeA, entityTypeB) {
  return getEdgeTypesForEntities(props.schemaMapping, entityTypeA, entityTypeB)
}

function requestServerRefresh (payload = {}) {
  emit('refresh-graph-data', { refreshFromServer: true, ...payload })
}

function stopGraphLoading () {
  emit('refresh-graph-data', { stopLoading: true })
}

/**
 * 本地画布实体数超过当前查询 limit 时，先提高 limit 再请求服务端，
 * 避免「已满 limit 条」时再增实体，刷新仍按旧 limit 截断导致新实体丢失。
 */
function bumpLimitFromLocalEntityCount () {
  const count = graphDataCache.value.entities?.length ?? 0
  const limit = Number(props.limitValue)
  const safeLimit = Number.isFinite(limit) ? limit : 0
  if (count > safeLimit) {
    emit('limit-change', count)
  }
}

// 获取知识库ID
function getKnowledgeBaseId () {
  const kbId = route.params.id || props.graphData.kbId
  if (!kbId) {
    console.error('❌ 无法获取知识库ID')
    proxy.$message.error(proxy.$t('modules.kb.cannotGetKbId'))
    return null
  }
  return kbId
}

// 增量更新方案：本地缓存和操作队列
// 本地缓存的图谱数据（用于增量更新）
const graphDataCache = ref({
  entities: [],
  edges: []
})

// 操作队列（存储待提交的操作）
const operationQueue = ref([])

// 批量处理状态（用于防止在批量处理时触发重新渲染）
const isBatchProcessing = ref(false)

// 操作类型定义
const OperationType = {
  ADD_ENTITY: 'addEntity',
  EDIT_ENTITY: 'editEntity',
  DELETE_ENTITY: 'deleteEntity',
  ADD_EDGE: 'addEdge',
  EDIT_EDGE: 'editEdge',
  DELETE_EDGE: 'deleteEdge'
}

// 搜索相关状态
// 真正的实体检索由详情页在点「查询」时发给后端（``graph/query`` 的 ``keyword``），
// 这里不做本地匹配：按已加载的实体按名称过滤看不到 ID / 描述，也搜不到分页之外
// 的数据，还会在后端其实能搜到时给出相反的提示。
// 这里只保留「点画布空白处清空搜索」的状态维护。
const isSearchMode = ref(false)

function performEntitySearch (keyword) {
  if (!keyword || keyword.trim() === '') {
    clearSearch()
    return
  }

  // 关闭所有编辑框（节点和边的编辑框）
  selection.closeActionPopover()
  edgeCrud.closeEdgeActionPopover()

  isSearchMode.value = true
}

function clearSearch () {
  isSearchMode.value = false
}

/**
 * 各职责 composable 的组装上下文：共享的 props/emit/DOM 引用/缓存，
 * 以及本文件定义的跨职责胶水函数。composable 之间不互相 import，
 * 需要彼此时都在调用时经 ctx 取（避免 setup 顺序耦合）。
 */
const ctx = {
  props,
  emit,
  t,
  proxy,
  route,
  graphDataCache,
  operationQueue,
  isBatchProcessing,
  OperationType,
  graphContainer,
  graphCanvasRef,
  controlsRef,
  fullscreenButton,
  requestServerRefresh,
  stopGraphLoading,
  bumpLimitFromLocalEntityCount,
  getKnowledgeBaseId,
  openExclusiveDrawer
}

const tones = useGraphTones(ctx)
ctx.tones = tones
const expand = useEntityExpand(ctx)
ctx.expand = expand
const selection = useGraphSelection(ctx)
ctx.selection = selection
const edgeCrud = useGraphEdgeCrud(ctx)
ctx.edgeCrud = edgeCrud
const entity = useGraphEntityCrud(ctx)
ctx.entity = entity
const relation = useGraphRelationDrawer(ctx)
ctx.relation = relation
const viewport = useGraphViewport(ctx)
ctx.viewport = viewport
const thumbnail = useGraphThumbnail(ctx)
ctx.thumbnail = thumbnail
const fullscreen = useGraphFullscreen(ctx)
ctx.fullscreen = fullscreen

/**
 * 同一时间只留一个抽屉（实体编辑 / 边查看 / 边编辑），关系抽屉始终先收起。
 * 三个可见性分别由 entity / edgeCrud 两个 store 持有，这里统一调度。
 */
function openExclusiveDrawer (targetDrawerKey) {
  entity.editDrawerVisible = targetDrawerKey === 'entityEdit'
  edgeCrud.viewDrawerVisible = targetDrawerKey === 'edgeView'
  edgeCrud.editDrawerVisible = targetDrawerKey === 'edgeEdit'
  relation.drawerVisible = false
}

/** 工具栏「刷新知识图谱」：优先用详情页的实现（带加载态与查询条件保持）。 */
function handleToolbarRefresh () {
  if (typeof props.refreshGraph === 'function') {
    return props.refreshGraph()
  }
  requestServerRefresh()
  return Promise.resolve()
}

/**
 * 刷新后按当前画布重新收拢节点坐标。
 * 位置缓存保存的是「收拢前」的基准布局（避免小窗口布局被持久化），刷新时物理已关闭，
 * 不重新收拢就会按基准坐标铺满/超出画布；preserveView 保留用户当前的缩放与平移。
 */
async function restoreLayoutAfterRefresh () {
  await nextTick()
  graphCanvasRef.value?.compactLayoutToFit?.(true)
}

defineExpose({
  restoreLayoutAfterRefresh,
  toggleFullscreen: fullscreen.toggleFullscreen,
  exitFullscreen: fullscreen.exitFullscreen,
  closeTools: fullscreen.closeTools,
  fitView: viewport.fitView,
  fitViewImmediate: viewport.fitViewImmediate
})

// 控制面板事件处理函数（原样转发给父组件）
function handleEntityTypeChange (types) {
  emit('entity-type-change', types)
}

function handleEdgeTypeChange (types) {
  emit('edge-type-change', types)
}

function handleLimitChange (value) {
  emit('limit-change', value)
}

function handleDepthChange (value) {
  emit('depth-change', value)
}

function handleExport () {
  emit('export')
}

function handleSearchInput (keyword) {
  // 触发搜索（本地副作用：收气泡、进搜索模式）
  performEntitySearch(keyword)
  // 通知父组件更新搜索关键词，保持输入框的值
  emit('search-input', keyword)
}

function handleSearchClear () {
  clearSearch()
  emit('search-clear')
}

function handleExecuteQuery (payload) {
  emit('execute-query', payload)
}

function handleQueryTypeChange (queryType) {
  emit('query-type-change', queryType)
}

/** 摘要行「显示上限」：打开高级查询抽屉，同时收起操作浮层。 */
function openAdvancedQuery () {
  fullscreen.closeTools()
  controlsRef.value?.openAdvanced()
}

// 处理容器点击事件（DOM 层）：收起下拉与浮层；点空白处清搜索、退连线模式
function handleContainerClick (event) {
  viewport.closeZoomMenus()
  fullscreen.closeTools()
  // 如果点击的是空白区域（不是节点或边）
  if (event.target === graphContainer.value) {
    // 清除搜索模式
    if (isSearchMode.value) {
      clearSearch()
      // 通知父组件清除搜索关键词
      emit('search-clear')
    }

    // 退出连线模式
    if (relation.isAddingEdgeMode) {
      relation.exitAddingEdgeMode()
    }
  }
}

// vis 画布空白处点击：额外清掉待触发的单击气泡与已选节点
function handleContainerClickFromCanvas () {
  viewport.closeZoomMenus()
  fullscreen.closeTools()
  selection.clearNodeClickTimer()
  edgeCrud.clearEdgeClickTimer()
  if (isSearchMode.value) {
    clearSearch()
    emit('search-clear')
  }
  if (relation.isAddingEdgeMode) {
    relation.exitAddingEdgeMode()
  }
  selection.closeActionPopover()
  edgeCrud.closeEdgeActionPopover()
  graphCanvasRef.value?.selectNodes?.([])
}

// 监听数据变化
watch(() => props.graphData, (newData) => {

  // 增量更新方案：如果正在批量处理，不触发重新渲染
  if (isBatchProcessing.value) {
    // 更新本地缓存，但不触发渲染
    if (newData) {
      graphDataCache.value = {
        entities: [...(newData.entities || [])],
        edges: [...(newData.edges || [])]
      }
    }
    return
  }

  // 更新本地缓存
  if (newData) {
    graphDataCache.value = {
      entities: [...(newData.entities || [])],
      edges: [...(newData.edges || [])]
    }
  }

  // 数据已同步到 graphDataCache，由 GraphCanvasVis 根据缓存自动渲染
}, { deep: true })

// 监听搜索关键词变化
watch(() => props.searchKeyword, (newKeyword) => {
  performEntitySearch(newKeyword)
})

// 生命周期
onMounted(() => {
  // 初始化本地缓存（增量更新方案）
  if (props.graphData) {
    graphDataCache.value = {
      entities: [...(props.graphData.entities || [])],
      edges: [...(props.graphData.edges || [])]
    }
  }
})
</script>

<!-- 主样式拆到 graph-visualization/graph-visualization.less（scoped 语义不变，
     子组件样式随各自模板走，见该文件头部说明） -->
<style lang="less" scoped src="./graph-visualization/graph-visualization.less"></style>
