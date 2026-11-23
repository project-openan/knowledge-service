import { v4 as uuidv4 } from 'uuid'
import { useNodeConfig, withGraphColors } from '@/features/workflow/useNodeConfig'
import { DEFAULT_CUSTOM_NODE_WIDTH } from '@/features/workflow/lib/workflow'
import { moduleKeyOf } from '@/features/workflow/lib/flowGeometry'
import { createDefaultVariables } from '@/features/workflow/modules/flowNodeDefaults'
import { edgeLineAttrs } from '@/features/workflow/composables/useFlowConnectors'

const { queryNodeConfig, responseNodeConfig,
  PreRetrieverNodeConfig, RetrieverNodeConfig, PostRetrieverNodeConfig,
  ResponseSynthesizerNodeConfig } = useNodeConfig();

/**
 * 画布交互 · 画布数据装配（composable）。
 *
 * 职责：画布 ⇄ 后端 DTO 的双向转换（importGraph / normalizeNodePorts）、
 * 默认节点与「添加节点」抽屉的节点创建（createLibraryNode / addLibraryNode）、
 * 新节点接入链路（insertNodeBeforeEnd）。
 */
export function useFlowGraphData () {
  return {
    initDefaultNode () {
      const result = this.graph.toJSON()
      if (!result.cells.length) {
        this.graph.addNode(queryNodeConfig())
        this.graph.addNode(responseNodeConfig())
        this.$nextTick(() => {
          this.syncAllNodeGeometry()
          this.layoutWorkflowNodes()
          this.zoom('fit')
          this.syncGraphStats()
        })
      }
    },
    /**
     * 新节点直接接在「结束」前面：
     * 结束节点原来的上游改接新节点，新节点再连到结束；这样添加后卡片立刻有输入。
     */
    insertNodeBeforeEnd (node) {
      const end = this.graph.getNodes().find(item => item.shape === 'RESPONSE')
      if (!end) {
        return
      }
      const targetPort = end.getPortsByGroup('in')?.[0]?.id
      const inputPort = node.getPortsByGroup('in')?.[0]?.id
      const outputPort = node.getPortsByGroup('out')?.[0]?.id
      if (!targetPort || !inputPort || !outputPort) {
        return
      }
      const incoming = this.graph.getIncomingEdges(end.id) || []
      incoming.forEach(edge => {
        const sourceId = edge.getSourceCellId()
        const sourcePort = edge.getSourcePortId()
        this.graph.removeEdge(edge.id)
        this.graph.addEdge({
          source: { cell: sourceId, port: sourcePort },
          target: { cell: node.id, port: inputPort },
          attrs: { line: edgeLineAttrs() }
        })
      })
      this.graph.addEdge({
        source: { cell: node.id, port: outputPort },
        target: { cell: end.id, port: targetPort },
        attrs: { line: edgeLineAttrs() }
      })
    },
    /** 按模块类型创建画布节点（沿用模板里的默认算子配置）。 */
    createLibraryNode (shape) {
      const templates = {
        preretriever: [PreRetrieverNodeConfig, 'PRE_RETRIEVER', 'PRE-'],
        retriever: [RetrieverNodeConfig, 'RETRIEVER', 'RE-'],
        postretriever: [PostRetrieverNodeConfig, 'POST_RETRIEVER', 'POST-'],
        responsesynthesizer: [ResponseSynthesizerNodeConfig, 'RESPONSE_SYNTHESIZER', 'SYN-']
      }
      const [template, componentType, prefix] = templates[shape] || templates.preretriever
      const config = JSON.parse(JSON.stringify(withGraphColors(template)))
      config.label = `${prefix}${this.generateRandomUUID()}`
      const node = this.graph.createNode(config)
      const variables = createDefaultVariables(componentType)
      const moduleKey = moduleKeyOf(componentType)
      if (variables && moduleKey) {
        variables[moduleKey].forEach((operator, index) => {
          operator.id = `${node.id}_${index + 1}`
        })
        node.setProp('variables', variables)
        node.setData({ variables })
      }
      return node
    },
    /**
     * @description: 从左侧「添加节点」抽屉里点选模块，放到当前视口中心。
     *
     * 添加节点是点击添加而不是拖动添加；位置取当前缩放/平移后的可视中心，并在
     * 与已有节点重叠时向下错开，避免新节点完全盖住旧节点。
     */
    addLibraryNode (shape) {
      const nodeCount = this.graph?.getNodes?.().length || 0
      if (nodeCount >= 60) {
        this.$message({
          message: this.$t('public.nodeLimit'),
          type: 'warning'
        })
        return
      }
      const node = this.createLibraryNode(shape)
      const container = this.graph.container
      const rect = container.getBoundingClientRect()
      const center = this.graph.clientToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2)
      let x = Math.round(center.x - DEFAULT_CUSTOM_NODE_WIDTH / 2)
      let y = Math.round(center.y - 80)
      while (this.graph.getNodes().some(existing => {
        const position = existing.getPosition()
        return Math.abs(position.x - x) < 40 && Math.abs(position.y - y) < 40
      })) {
        y += 60
      }
      node.position(x, y)
      this.graph.addNode(node)
      this.insertNodeBeforeEnd(node)
      this.libraryVisible = false
      this.scheduleGeometrySync()
      this.syncGraphStats()
      const nodeId = node.id
      this.$nextTick(() => {
        const added = this.graph.getCellById(nodeId)
        if (!added) {
          return
        }
        this.editCardHandle({
          id: nodeId,
          componentType: added.shape,
          label: added.store?.data?.label,
          variables: added.store?.data?.variables
        }, nodeId)
      })
    },
    /**
     * @description: 新建节点到画布中
     *
     * @param {Object} nodeConfig 节点配置
     */
    addNode (nodeConfig) {
      this.graph.addNode(nodeConfig)
    },
    /** 把已加载节点的端口重置为新卡片几何（端口 id 不变，连线自动改挂）。 */
    normalizeNodePorts () {
      const templates = {
        PRE_RETRIEVER: PreRetrieverNodeConfig.ports,
        RETRIEVER: RetrieverNodeConfig.ports,
        POST_RETRIEVER: PostRetrieverNodeConfig.ports,
        RESPONSE_SYNTHESIZER: ResponseSynthesizerNodeConfig.ports,
        QUERY: queryNodeConfig().ports,
        RESPONSE: responseNodeConfig().ports
      }
      this.graph.getNodes().forEach(node => {
        const template = templates[node.shape]
        if (template) {
          node.setProp('ports', JSON.parse(JSON.stringify(template)))
        }
      })
    },
    importGraph (shouldArrange = true) {
      this.nodeLoaded = true
      if (this.jsonDTO) {
        //  fromJSON方法会把json的值全部塞进store.data,因此data.variable永远是有值的
        this.graph.fromJSON(this.jsonDTO)
        // 已加载画布可能带旧端口坐标；卡片几何变化后，必须把节点的 ports 重新
        // 钉到当前模板，否则连线会挂到卡片外
        this.normalizeNodePorts()

        Array.isArray(this.jsonDTO) && this.jsonDTO.forEach(item => {
          if (item.outputVariables) {
            item.outputVariables.forEach(element => {
              const targetNodeInfo = this.graph.getCellById(element.targetNode)
              this.graph.addEdge({
                source: {
                  cell: item.nodeId,
                  port: element.key
                },
                target: {
                  cell: element.targetNode,
                  port: targetNodeInfo.getPortsByGroup('in')[0].id
                },
                attrs: {
                  line: edgeLineAttrs()
                }
              })
            })
          }

          // 下列代码用于点击编辑 什么都没有动 直接保存 赋值variable
          const target = this.graph.getCellById(item.id)
          // 重新加载节点时，将后端返回的值赋给节点
          target.setData({
            type: 'displayData',
            variables: item.variables
          },
          {
            overwrite: true
          })
        })
      }
      // 尺寸/端口是数据层几何（不依赖卡片 DOM）：fromJSON 后立刻同步，
      // 否则 1×1 的节点会在 render:done 之前把端口/连线全摆在节点左上角。
      this.portSideCache = {}
      this.syncAllNodeGeometry()
      // 排版必须等 X6 把 Vue 卡片视图真正挂到 DOM 上（render:done）：
      // 在 nextTick/rAF 里量，foreignObject 还是 1×1、卡片 DOM 尚未挂载，
      // 只能退回默认尺寸，节点会叠在一起。这里只打标记，由 render:done 触发。
      if (shouldArrange) {
        this.pendingArrange = true
        if (this.arrangeFallbackTimer) {
          clearTimeout(this.arrangeFallbackTimer)
        }
        // 兜底：极端情况下 render:done 不触发（例如空图），别让排版一直悬着
        this.arrangeFallbackTimer = setTimeout(() => {
          this.arrangeFallbackTimer = null
          this.runPendingArrange()
        }, 500)
      }
    },
    generateRandomUUID () {
      let uuid = uuidv4()
      uuid = uuid.replace(/-/g, '')
      uuid = uuid.substring(0, 3)
      return uuid
    }
  }
}
