import { Graph } from '@antv/x6'
import { Selection } from '@antv/x6-plugin-selection'
import { Keyboard } from '@antv/x6-plugin-keyboard'
import { Transform } from '@antv/x6-plugin-transform'
import { History } from '@antv/x6-plugin-history'
import { Clipboard } from '@antv/x6-plugin-clipboard'
import { register } from '@antv/x6-vue-shape'
import { h } from 'vue'

/**
 * X6 编辑器内核 —— 两套 X6 编辑器共用的「画布装配」能力唯一定义点。
 *
 * 背景：图谱模板设计器（GraphEditor/GraphCanvas.vue，被 GraphTemplateDesigner
 * 使用）与 RAG 工作流编排器（features/workflow/composables/useFlowCanvas 等，
 * 被 WorkflowEditorPage 使用）各自直连 X6，同类能力写了两遍，改一处漏一处。
 * 这里把可共享的**机制**收拢；两边的差异（网格/缩放范围/连线规则/节点绘制
 * 样式）通过参数传入，内核不做任何业务决策：
 *
 * 1. Graph 实例装配     createEditorGraph（公共默认 + 调用方覆盖深合并）
 * 2. 插件装配           createTemplateEditorPlugins / attachEditorPlugins
 * 3. 形状注册           registerVueShape（Vue 卡片节点）、
 *                       registerNodeShape / registerEdgeShape（幂等守卫注册）
 * 4. 节点/端口装饰       setPortsVisibility、applyPortPaint、
 *                       setNodeSelectedOutline、setEdgeStroke、
 *                       cellViewContainer + setElementClass（视图类选中态）
 * 5. 连线绘制参数        editorEdgeLineAttrs（模板设计器/GraphEditor 的连线样式）
 * 6. 连线校验           wouldCreateCycleInEdges（成环检测）、hasEdgeBetween（去重）、
 *                       edgePairsOf（取边对）
 * 7. 撤销/重做          graphCanUndo / graphCanRedo / graphUndo / graphRedo
 * 8. 事件桥             bindGraphEvents（graph.on 统一挂载，返回解绑函数）
 *
 * ⚠️ 行为等价是硬要求：任何一处的默认值都是两边现状的交集，只允许调用方
 * 覆盖，不允许内核引入新的默认行为。
 */

// ---------------------------------------------------------------------------
// Graph 实例装配
// ---------------------------------------------------------------------------

const isMergeableOption = value => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 深合并 Graph options：调用方覆盖内核默认值。
 * 纯对象递归合并；数组、函数、null 等直接整值覆盖（不合并），例如
 * `interacting`/`createEdge` 回调与 `modifiers: null`。
 */
export function mergeGraphOptions (base, override) {
  const merged = { ...base }
  Object.keys(override || {}).forEach(key => {
    const value = override[key]
    if (value === undefined) {
      return
    }
    if (isMergeableOption(value) && isMergeableOption(merged[key])) {
      merged[key] = mergeGraphOptions(merged[key], value)
    } else {
      merged[key] = value
    }
  })
  return merged
}

/**
 * 两套编辑器一致的公共默认：画布可拖拽平移、滚轮缩放、禁止连到空白点、
 * 连线吸附半径 20。其余配置（网格、缩放上下限、连线规则等）由调用方覆盖。
 */
const DEFAULT_GRAPH_OPTIONS = {
  panning: true,
  mousewheel: { enabled: true },
  connecting: {
    allowBlank: false,
    snap: { radius: 20 }
  }
}

/** 装配一个 X6 编辑器 Graph 实例（createEditorGraph 之前各自 new Graph）。 */
export function createEditorGraph (options = {}) {
  return new Graph(mergeGraphOptions(DEFAULT_GRAPH_OPTIONS, options))
}

// ---------------------------------------------------------------------------
// 插件装配（模板设计器当前的一组插件；工作流编排器不装插件）
// ---------------------------------------------------------------------------

/** 模板设计器的插件清单，配置与拆分前逐字一致（顺序即 use 顺序）。 */
export function createTemplateEditorPlugins () {
  return [
    new Selection({
      enabled: true,            // 启用选择插件
      multiple: true,           // 允许多选

      movable: true,            // 选中元素可移动
      showNodeSelectionBox: false,   // 禁用默认选择框，使用自定义样式
      showEdgeSelectionBox: true,      // 新增：显示边的选中态
      selectCellOnMoved: true,      // 移动时保持选中
      strict: false,            // 允许部分选中

      // 禁用自动选择新添加的节点
      selectNodeOnMoved: false,

      // 禁用框选功能，避免拖动画布时出现框选框
      rubberband: false,

      // 选择框样式
      className: 'my-selection',

      // 内容配置
      content: false,

      // 过滤器：哪些元素可以被选择
      filter: (cell) => {
        // 可以选择所有节点和边
        return cell.isNode() || cell.isEdge()
      }
    }),
    new Keyboard({
      enabled: true
    }),
    new Transform({
      resizing: false,
      rotating: false
    }),
    new History({
      enabled: true
    }),
    new Clipboard({
      enabled: true
    })
  ]
}

/** 按 mount 顺序把插件挂到 Graph 上（等价于拆分前的 .use() 链）。 */
export function attachEditorPlugins (graph, plugins) {
  ;(plugins || []).forEach(plugin => {
    graph.use(plugin)
  })
  return graph
}

// ---------------------------------------------------------------------------
// 形状注册
// ---------------------------------------------------------------------------

/**
 * 注册「Vue 卡片」节点形状：工作流编排器的算子卡片走这条路径。
 * `props` 是桥接到卡片组件的回调（onDeleteCardHandle 等）。
 */
export function registerVueShape ({ shape, component, props }) {
  register({
    shape,
    component: {
      render: () => h(component, props || {})
    }
  })
}

/** 幂等的节点形状注册：重复注册静默忽略，其他错误照常暴露。 */
export function registerNodeShape (name, config) {
  try {
    Graph.registerNode(name, config, true)
  } catch (error) {
    // 重复注册是幂等操作，静默忽略；其他错误才需要暴露
    if (!(error instanceof Error && error.message.includes('already registered'))) {
      console.error(`节点 ${name} 注册失败:`, error)
    }
  }
}

/** 幂等的边形状注册（同 registerNodeShape）。 */
export function registerEdgeShape (name, config) {
  try {
    Graph.registerEdge(name, config, true)
  } catch (error) {
    // 重复注册是幂等操作，静默忽略；其他错误才需要暴露
    if (!(error instanceof Error && error.message.includes('already registered'))) {
      console.error(`边 ${name} 注册失败:`, error)
    }
  }
}

// ---------------------------------------------------------------------------
// 节点 / 端口 / 边的装饰机制（样式参数由调用方给，内核只收拢写法）
// ---------------------------------------------------------------------------

/**
 * 批量切换节点端口的显隐（模板设计器：选中显示、取消隐藏）。
 * 端口坐标与几何不动，只写 `attrs/circle/style/visibility`。
 */
export function setPortsVisibility (node, visible) {
  const ports = node.getPorts?.()
  ports?.forEach?.(port => {
    node.portProp(port.id, 'attrs/circle/style/visibility', visible ? 'visible' : 'hidden')
  })
}

/**
 * 原地重刷节点全部端口的 paint 属性（主题切换）。
 * `circleStroke`/`circleFill` 写 `attrs/circle/{stroke,fill}`；
 * `dotFill` 可选（工作流的连接桩同心圆 `attrs/dot/fill`）。
 * 不动 strokeWidth、r、端口位置 —— 切换主题前后几何不变。
 */
export function applyPortPaint (node, paint) {
  ;(node.getPorts() || []).forEach(port => {
    node.portProp(port.id, 'attrs/circle/stroke', paint.circleStroke)
    node.portProp(port.id, 'attrs/circle/fill', paint.circleFill)
    if (paint.dotFill !== undefined) {
      node.portProp(port.id, 'attrs/dot/fill', paint.dotFill)
    }
  })
}

/**
 * 节点选中态的圆形描边（模板设计器机制）：selected 为真按 palette 描边，
 * 否则隐藏描边。工作流用的是视图类名选中态（见 cellViewContainer），不走这里。
 */
export function setNodeSelectedOutline (node, selected, palette) {
  if (selected) {
    node.attr('body/strokeWidth', 1)
    node.attr('body/stroke', palette.nodeSelectedStroke)
  } else {
    node.attr('body/strokeWidth', 0)
    node.attr('body/stroke', 'transparent')
  }
}

/** 统一改写边的描边（选中高亮/主题重绘共用；宽度默认 2px）。 */
export function setEdgeStroke (edge, stroke, strokeWidth = 2) {
  edge?.attr?.('line/stroke', stroke)
  edge?.attr?.('line/strokeWidth', strokeWidth)
}

/**
 * 取 cell 的视图容器。`cell` 可以是 id 或 cell 实例；找不到视图返回 null。
 * 工作流的选中态（.selected / .flow-connection 等）都挂在视图容器类名上。
 */
export function cellViewContainer (graph, cell) {
  const target = typeof cell === 'string' ? graph?.getCellById?.(cell) : cell
  if (!target) {
    return null
  }
  return graph?.findViewByCell?.(target)?.container || null
}

/** 按 force 语义挂/摘视图容器类名（等价 classList.toggle(name, force)）。 */
export function setElementClass (element, className, active) {
  if (!element) {
    return
  }
  element.classList[active ? 'add' : 'remove'](className)
}

// ---------------------------------------------------------------------------
// 连线绘制参数（模板设计器侧的连线样式；工作流细线样式仍在 useFlowConnectors）
// ---------------------------------------------------------------------------

/**
 * GraphEditor/模板设计器的 `attrs.line`：2px 主色线 + classic 箭头。
 * 差异参数：`fill`（'none' 传入才写）、`roundCaps`（自环圆头）、
 * `targetMarker`（预览/正式线都要箭头，关闭则不写）。
 */
export function editorEdgeLineAttrs ({ stroke, fill, roundCaps = false, targetMarker = true } = {}) {
  const attrs = {
    stroke,
    strokeWidth: 2
  }
  if (fill !== undefined) {
    attrs.fill = fill
  }
  if (roundCaps) {
    attrs.strokeLinejoin = 'round'
    attrs.strokeLinecap = 'round'
  }
  if (targetMarker) {
    attrs.targetMarker = {
      name: 'classic',
      size: 6,
      fill: stroke,
      stroke
    }
  }
  return attrs
}

// ---------------------------------------------------------------------------
// 连线校验
// ---------------------------------------------------------------------------

/**
 * source→target 是否会形成环：从 target 顺着出边能走回 source 即为环。
 * `edges` 是 `{ source, target }` 对（用 edgePairsOf 从图里取）。
 */
export function wouldCreateCycleInEdges (edges, sourceId, targetId) {
  const outgoing = new Map()
  edges.forEach(edge => {
    if (!outgoing.has(edge.source)) {
      outgoing.set(edge.source, [])
    }
    outgoing.get(edge.source).push(edge.target)
  })
  const seen = new Set()
  const pending = [targetId]
  while (pending.length) {
    const id = pending.pop()
    if (id === sourceId) {
      return true
    }
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    pending.push(...(outgoing.get(id) || []))
  }
  return false
}

/** 取图的边对（可排除拖拽中的预览边），供成环检测/去重使用。 */
export function edgePairsOf (graph, { excludePreview = false } = {}) {
  return (graph?.getEdges?.() || [])
    .filter(edge => (excludePreview ? !edge.getData()?.preview : true))
    .map(edge => ({
      source: edge.getSourceCellId(),
      target: edge.getTargetCellId()
    }))
}

/** 两点之间是否已存在同向连线（连线去重规则）。 */
export function hasEdgeBetween (edges, sourceId, targetId) {
  return (edges || []).some(edge =>
    edge.getSourceCellId() === sourceId && edge.getTargetCellId() === targetId
  )
}

// ---------------------------------------------------------------------------
// 撤销 / 重做（History 插件；工作流编排器未启用，仅模板设计器使用）
// ---------------------------------------------------------------------------

export function graphCanUndo (graph) {
  return !!graph && graph.canUndo()
}

export function graphCanRedo (graph) {
  return !!graph && graph.canRedo()
}

export function graphUndo (graph) {
  if (graphCanUndo(graph)) {
    graph.undo()
  }
}

export function graphRedo (graph) {
  if (graphCanRedo(graph)) {
    graph.redo()
  }
}

// ---------------------------------------------------------------------------
// 事件桥
// ---------------------------------------------------------------------------

/**
 * 统一事件桥：把 `{ 'blank:click': fn, 'edge:click': fn, ... }` 逐个挂到
 * `graph.on`，返回解绑函数。两套编辑器的画布事件都从这里挂载，
 * 保证监听行为只有一种写法、一处收敛。
 */
export function bindGraphEvents (graph, handlers) {
  if (!graph) {
    return () => {}
  }
  const entries = Object.entries(handlers)
  entries.forEach(([name, handler]) => {
    graph.on(name, handler)
  })
  return () => {
    entries.forEach(([name, handler]) => {
      graph.off(name, handler)
    })
  }
}
