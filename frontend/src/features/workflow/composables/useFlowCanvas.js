import { Graph, Shape } from '@antv/x6'
import { register } from '@antv/x6-vue-shape'
import { h } from 'vue'
import { getGraphColors } from '@/features/workflow/useNodeConfig'
import { DEFAULT_CUSTOM_NODE_WIDTH, DEFAULT_CUSTOM_NODE_HEIGHT } from '@/features/workflow/lib/workflow'
import { edgeLineAttrs } from '@/features/workflow/composables/useFlowConnectors'
import QUERY from '@/features/workflow/modules/queryNode.vue'
import RESPONSE from '@/features/workflow/modules/responseNode.vue'
import PRE_RETRIEVER from '@/features/workflow/modules/preretriever/Node.vue'
import RETRIEVER from '@/features/workflow/modules/retriever/Node.vue'
import POST_RETRIEVER from '@/features/workflow/modules/postretriever/Node.vue'
import RESPONSE_SYNTHESIZER from '@/features/workflow/modules/responsesynthesizer/Node.vue'

/**
 * 画布交互 · X6 画布装配（composable）。
 *
 * 职责：Graph 实例的创建与配置（缩放/平移/连线校验）、画布事件监听
 * （render:done、edge:connected/removed、几何与端口事件）、主题原地刷新、
 * 视口尺寸跟随、自定义 Vue 节点注册、加载后的排版等待（runPendingArrange）。
 *
 * 返回的是方法映射，由 WorkflowEditorPage 展开进 `methods`：方法体内仍用
 * `this` 访问组件实例（graph、data、$t 等），与拆分前逐字等价。
 */
export function useFlowCanvas () {
  return {
    initGraph () {
      const { width, height } = this.getCanvasSize()
      this.graph = new Graph({
        container: document.getElementById('advancedFLow'),
        width,
        height,
        panning: true, // 画布支持拖拽平移
        mousewheel: { // 画布支持滚轮缩放（缩放范围 0.2–1.6）
          enabled: true,
          minScale: 0.2,
          maxScale: 1.6
        },
        interacting: () => {
          return true // 默认为false 即默认不让画布具备交互能力 即只读模式
        },
        connecting: { // 连线
          connector: {
            name: 'flow-adaptive'
          },
          // 端口坐标就是连线端点（x/y），不能再按节点边界裁一次
          anchor: 'center',
          connectionPoint: 'anchor',
          allowBlank: false,
          allowLoop: false,
          allowMulti: false,
          snap: {
            radius: 20
          },
          createEdge: () => {
            // 拖动中的预览边：虚线主色；连上后 edge:connected 会把样式还原
            const edge = new Shape.Edge({
              attrs: {
                line: {
                  ...edgeLineAttrs(),
                  strokeDasharray: '6 5'
                }
              },
              data: { preview: true }
            })
            return edge
          },
          validateMagnet: ({ magnet }) => {
            const group = magnet?.getAttribute('port-group') || magnet?.parentElement?.getAttribute('port-group')
            return group === 'out'
          },
          validateConnection: ({ sourceCell, targetCell, sourceMagnet, targetMagnet }) => {
            if (!sourceCell || !targetCell || sourceCell.id === targetCell.id) {
              return false
            }
            // 连线只允许从输出桩连到输入桩
            const sourceGroup = sourceMagnet?.getAttribute('port-group')
            const targetGroup = targetMagnet?.getAttribute('port-group') || targetMagnet?.parentElement?.getAttribute('port-group')
            if (sourceGroup !== 'out' || targetGroup !== 'in') {
              return false
            }
            if (this.graph.getEdges().some(edge =>
              edge.getSourceCellId() === sourceCell.id && edge.getTargetCellId() === targetCell.id
            )) {
              return false
            }
            return !this.wouldCreateCycle(sourceCell.id, targetCell.id)
          }
        }
      })
      this.zoomPercent = Math.round(this.graph.zoom() * 100)
      this.graph.on('scale', ({ sx }) => {
        this.zoomPercent = Math.round(sx * 100)
      })
    },
    /**
     * @description: 按当前主题的 --rs-graph-* 原地刷新已有连线与链接桩的颜色。
     *
     * 只写 paint 属性（line/stroke、circle/fill|stroke、dot/fill），
     * 不动 strokeWidth、r、端口位置、连接器与节点尺寸 —— 切换主题前后几何不变。
     * 版本/选区/视口都由 X6 自己保留，无需重建 Graph。
     */
    applyGraphTheme () {
      if (!this.graph) {
        return
      }
      const { portFill, portStroke } = getGraphColors()
      this.graph.getEdges().forEach(edgeCell => {
        // 描边与箭头 marker 一起重设：marker 的 fill/stroke 不随 line.stroke 自动更新
        edgeCell.attr('line', edgeLineAttrs())
      })
      this.graph.getNodes().forEach(node => {
        ;(node.getPorts() || []).forEach(port => {
          node.portProp(port.id, 'attrs/circle/stroke', portStroke)
          node.portProp(port.id, 'attrs/circle/fill', portFill)
          node.portProp(port.id, 'attrs/dot/fill', portStroke)
        })
      })
    },
    // 画布尺寸取「可见绘图区」（.canvas-viewport），不能用 document：
    // document 会把左侧栏也算进来，画布比可见区域更宽更高，右/下缘的节点会被裁掉。
    getCanvasSize () {
      const area = this.$el?.querySelector?.('.canvas-viewport')
      if (!area) {
        return {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight
        }
      }
      const style = window.getComputedStyle(area)
      return {
        width: area.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0),
        height: area.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0)
      }
    },
    /**
     * @description: 节点的**渲染尺寸**（画布坐标，不含当前缩放）。
     *
     * 不能直接用 node.getSize()：画布数据里的 size 是 1×1（模板就是这样），
     * Vue 卡片靠 CSS 溢出显示成 240px 宽、高度随内容变化。按 1×1 排版会让所有节点
     * 叠在一起。这里量卡片 DOM，再除以当前缩放换算回画布坐标。
     */
    getNodeDisplaySize (node) {
      const view = this.graph?.findViewByCell?.(node)
      const card = view?.container?.querySelector?.('.ai-card-frame')
      const rect = card?.getBoundingClientRect?.()
      const zoom = this.graph?.zoom?.() || 1
      if (rect && rect.width > 0 && rect.height > 0) {
        return { width: rect.width / zoom, height: rect.height / zoom }
      }
      return { width: DEFAULT_CUSTOM_NODE_WIDTH, height: DEFAULT_CUSTOM_NODE_HEIGHT }
    },
    /**
     * 进入工作流时：先让节点尺寸/端口符合卡片几何，再决定是否重排。
     *
     * 首次打开工作流时卡片几何可能与库里坐标不一致，按基准布局
     * 重排一次并记到 localStorage；之后保留用户自己拖动/保存的布局，只做适应画布。
     *
     * ⚠️ 不要再按「100% 下是否放得下」触发重排（原 `nodesFitViewport()` 分支）：
     * 那会在每次加载时把**库里存的布局**悄悄换成自动排版，而「撤销更改」重新
     * 拉的正是库里的布局 —— 用户什么都没改，点撤销却看到卡片全部挪位。
     * 放不下的情况交给 `zoom('fit')` 缩放展示，坐标本身不动。
     */
    applyInitialLayout () {
      if (!this.graph?.getNodes?.().length) {
        return
      }
      this.syncAllNodeGeometry()
      const key = `ragstudio:flow-layout-v016:${this.$route.params.id}`
      let migrated = false
      try {
        migrated = window.localStorage.getItem(key) === '1'
      } catch (error) {
        migrated = false
      }
      if (!migrated) {
        this.layoutWorkflowNodes()
        try {
          window.localStorage.setItem(key, '1')
        } catch (error) {
          // 无痕模式等场景写不了 localStorage：本次重排仍然生效
        }
      }
      this.$nextTick(() => this.zoom('fit'))
    },
    setGraphSize () {
      if (this.debounceTime) {
        clearTimeout(this.debounceTime);
      }
      this.debounceTime = setTimeout(() => {
        const { width, height } = this.getCanvasSize()
        this.graph.resize(width, height)
      }, this.timerInterval);
    },
    setGraphEventAndNodeInfo () {
      // 注册画布监听事件
      this.graphListenDone();
      this.graphListenConnected();
      this.graphListenRemoved();
      this.graphListenGeometry();
      this.graphListenPorts();

      // 注册自定义vue节点
      this.registerCustomNodeBundle();
    },
    // 在调用 fromJSON 或者 resetCells 后监听画布完成渲染事件
    graphListenDone () {
      this.graph.on('render:done', () => {
        this.nodeLoaded = false
        this.syncGraphStats()
        // 批量导入/新建后按当前主题刷一次连线与端口颜色（只改 paint）
        this.applyGraphTheme()
        // 视图（含 Vue 卡片 DOM）已就绪，这时量尺寸/排版才准确
        this.runPendingArrange()
      })
    },
    // render:done 后还不能立刻排版：x6-vue-shape 的卡片是 **Teleport** 到
    // foreignObject 里的，render:done 时卡片 DOM 还没挂上（querySelector 为空）。
    // 这里轮询等待「所有卡片都出现，且高度连续两次采样一致」，再做排版。
    runPendingArrange (attempt = 0) {
      if (!this.pendingArrange || this.arrangeRetryTimer) {
        return
      }
      if (attempt === 0 && this.arrangeFallbackTimer) {
        clearTimeout(this.arrangeFallbackTimer)
        this.arrangeFallbackTimer = null
      }
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          if (!this.pendingArrange || this.arrangeRetryTimer) {
            return
          }
          const nodes = this.graph?.getNodes?.() || []
          const cards = nodes.map(node => this.graph.findViewByCell(node)?.container?.querySelector?.('.ai-card-frame'))
          const allMounted = cards.length > 0 && cards.every(Boolean)
          // 高度可能随异步数据（知识库/模型下拉）二次增长，连续两次一致才认为稳定
          const signature = allMounted
            ? cards.map(card => Math.round(card.getBoundingClientRect().height)).join(',')
            : ''
          const stable = allMounted && signature === this.lastCardSizeSignature
          this.lastCardSizeSignature = signature
          if (!stable && attempt < 40) {
            this.arrangeRetryTimer = setTimeout(() => {
              this.arrangeRetryTimer = null
              this.runPendingArrange(attempt + 1)
            }, 50)
            return
          }
          this.pendingArrange = false
          this.lastCardSizeSignature = ''
          this.applyInitialLayout()
        })
      })
    },
    graphListenMouseenter () {
      this.graph.on('edge:mouseenter', ({ edge }) => {
        edge.addTools(
          {
            name: 'button-remove',
            args: { distance: -40 }
          }
        )
      })
    },
    graphListenMouseleave () {
      this.graph.on('edge:mouseleave', ({ cell }) => {
        if (cell.hasTool('button-remove')) {
          cell.removeTool('button-remove')
        }
      })
    },
    graphListenConnected () {
      this.graph.on('edge:connected', ({ edge }) => {
        // 拖动预览边连上后还原为正式连线（虚线 → 实线、去掉 preview 标记）
        if (edge.getData()?.preview) {
          edge.setData({ preview: false })
          edge.attr('line', edgeLineAttrs())
        }
        this.scheduleGeometrySync()
        this.scheduleEdgeDecorations()
        this.$nextTick(() => this.syncGraphStats())
        const source = edge.getSourceCell()
        const target = edge.getTargetCell()
        const sourcePortId = edge.getSourcePortId()
        const targetPortId = edge.getTargetPortId()

        // 当连线结束后 给线条终端加上同心圆样式
        target.portProp(targetPortId, {
          group: 'in',
          attrs: {
            dot: {
              magnet: true,
              fill: getGraphColors().portStroke,
              r: 4
            }
          }
        })

        // 如果存在定制化的连线的限制 在此设置

        target.setData({
          type: 'add',
          sourceNode: source.id,
          label: source.store.data.label,
          key: sourcePortId
        })
        // 更新输出连接桩位置
        this.updateOuputPortForSingleOutput(target)
      })
    },
    graphListenRemoved () {
      this.graph.on('edge:removed', ({ cell }) => {
        this.$nextTick(() => this.syncGraphStats())
        const target = this.graph.getCellById(cell.store.data.target.cell)
        const sourcePortId = cell.getSourcePortId()

        target && target.setData({
          type: 'remove',
          deleteInput: cell.store.data.source.cell,
          key: sourcePortId
        })

        if (target) {
          const incomingE = this.graph.getIncomingEdges(target.id)
          const numOfIncomingEdges = incomingE?.length
          // 如果一个连接桩 删除至没有进来的连线了 那么就把连接桩恢复成圆形样式
          if (!numOfIncomingEdges) {
            target.portProp(cell.getTargetPortId(), {
              group: 'in',
              attrs: {
                dot: {
                  magnet: true,
                  fill: getGraphColors().portFill,
                  r: 0
                }
              }
            })
          }
        }

        // 更新连接桩位置
        this.updateOuputPortForSingleOutput(target)
      })
    },
    /**
     * @description: 注册自定义VUE节点
     *
     * @param {string} shape 节点类型
     * 定义了 shape 以后 该名称可以用于配合graph的addNode和createNode方法中的shape属性联合使用
     * @param {VueShape} vueNode 即自定义的vue文件
     * */
    /**
     * 卡片几何：节点尺寸、端口方位、连线箭头都随「算子条数 / 上游输入数」变化。
     * 任何会影响几何的 X6 事件都只打一个 rAF 标记，同一帧里只重算一次。
     */
    graphListenGeometry () {
      const schedule = () => {
        this.scheduleGeometrySync()
        this.scheduleEdgeDecorations()
      }
      // 拖动过程中 X6 只发 node:moving（node:moved 要等松手），
      // 线中段箭头是自绘的，必须逐帧跟算，否则会停在原位、松手后才追上。
      this.graph.on('node:moving', () => this.scheduleEdgeDecorations())
      this.graph.on('node:moved', schedule)
      this.graph.on('node:resized', schedule)
      this.graph.on('node:added', schedule)
      this.graph.on('node:change:data', () => {
        schedule()
        this.syncGraphStats()
      })
      this.graph.on('edge:added', ({ edge }) => {
        if (!edge.getData()?.preview) {
          this.scheduleGeometrySync()
        }
        this.scheduleEdgeDecorations()
        this.syncGraphStats()
      })
      this.graph.on('edge:removed', () => {
        this.scheduleGeometrySync()
        this.scheduleEdgeDecorations()
        this.syncGraphStats()
      })
      this.graph.on('edge:connected', () => {
        this.scheduleGeometrySync()
        this.scheduleEdgeDecorations()
        this.syncGraphStats()
      })
      this.graph.on('scale', () => this.scheduleEdgeDecorations())
    },
    graphListenPorts () {
      this.graph.on('node:port:mousedown', ({ e }) => {
        this.portPointerDown = { x: e.clientX, y: e.clientY, dragged: false }
      })
      this.graph.on('node:port:mouseup', ({ e }) => {
        if (this.portPointerDown) {
          this.portPointerDown.dragged = Math.hypot(
            e.clientX - this.portPointerDown.x,
            e.clientY - this.portPointerDown.y
          ) > 4
        }
      })
      this.graph.on('node:port:click', ({ node, port }) => {
        // 拖动建立连线后浏览器仍可能补一个 click；有位移就不再进入点击模式
        const dragged = this.portPointerDown?.dragged
        this.portPointerDown = null
        if (dragged) {
          return
        }
        const config = node.getPort(port)
        if (!config) {
          return
        }
        if (config.group === 'out') {
          this.beginClickConnection(node, port)
        } else if (config.group === 'in' && this.connectingSource) {
          this.finishClickConnection(node)
        }
      })
      this.graph.on('edge:click', ({ edge }) => this.selectEdge(edge))
      this.graph.on('node:mousedown', ({ node }) => {
        if (!node) {
          return
        }
        this.selectedEdge = null
        this.selectNodeView(node.id)
      })
      this.graph.on('blank:click', () => {
        this.selectedEdge = null
        this.cancelConnection()
        this.clearNodeSelection()
        this.scheduleEdgeDecorations()
      })
    },
    registerCustomNode (shape, vueNode) {
      register({
        shape,
        component: {
          render: () => {
            return h(vueNode, {
              // 点击卡片右上角删除按钮 删除该节点
              onDeleteCardHandle: id => this.deleteNode(id),
              // 点击卡片右上角设置按钮 弹出设置抽屉
              onEditCardHandle: nodeInfo => this.editCardHandle(nodeInfo),
              onInitCardHandle: nodeInfo => this.initCardHandle(nodeInfo),
              // 点击卡片上的删除按钮
              onInputDeleteHandle: (inputVariable, id) => this.inputDeleteHandle(inputVariable, id)
            })
          }
        }
      })
    },
    /**
     * @description: 批量注册画布内需要使用到的自定义Vue节点
     * 内置了customNodes变量 该变量为一个对象 包含的是所有自定义Vue节点的集合
     */
    registerCustomNodeBundle () {
      const customNodes = {
        QUERY,
        RESPONSE,
        PRE_RETRIEVER,
        RETRIEVER,
        POST_RETRIEVER,
        RESPONSE_SYNTHESIZER
      }
      Object.keys(customNodes).forEach(node => {
        this.registerCustomNode(node, customNodes[node])
      })
    }
  }
}
