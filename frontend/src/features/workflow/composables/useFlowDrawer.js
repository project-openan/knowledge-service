import { isFixedShape, getNodeOperators } from '@/features/workflow/lib/flowGeometry'
import { requestDeletion } from '@/shared/composables/deletion'
import { replaceNodeVariables } from '@/features/workflow/lib/cellData'
import { edgeLineAttrs } from '@/features/workflow/composables/useFlowConnectors'

/**
 * 节点配置面板（composable）。
 *
 * 职责：节点配置抽屉的打开与回填（editCardHandle）、抽屉校验与应用
 * （drawerSubmitHandle / applyDrawerUpstreams / showDrawerError）、
 * 卡片回调（initCardHandle / inputDeleteHandle）、节点与连线的删除确认
 * 与桥接（confirmNodeDeletion / removeNodeWithBridge / deleteCurrentNode）。
 */
export function useFlowDrawer () {
  return {
    showDrawerError (message) {
      this.$refs.drawerFrameRef?.showError?.(message)
    },
    editCardHandle (nodeInfo, nodeId) {
      // 打开编辑抽屉前刷新结构化知识库标志，确保读取到检索器最新的算子配置
      this.toolsOpen = false
      this.refreshStructKnowledgeFlag()
      const id = nodeId || nodeInfo?.id || ''
      const node = this.graph?.getCellById?.(id)
      if (!node) {
        return
      }
      this.cancelConnection()
      this.selectedEdge = null
      this.currentNodeId = id
      this.currentNodeData = {
        id,
        componentType: node.shape,
        label: node.store?.data?.label || '',
        variables: this.nodeVariables(node) || null
      }
      const shape = node.shape
      this.drawerFixed = isFixedShape(shape)
      this.drawerTitle = this.moduleTitleOf(shape)
      this.drawerTone = this.moduleToneOf(shape)
      this.drawerOperatorCount = getNodeOperators({
        shape,
        variables: this.currentNodeData.variables
      }).length
      this.drawerFixedDirection = shape === 'QUERY'
        ? this.$t('modules.workflow.output')
        : this.$t('modules.workflow.inputs')
      this.drawerFixedField = shape === 'RESPONSE' ? 'Answer' : 'Question'
      const incoming = this.graph.getIncomingEdges(id) || []
      this.drawerBasics = {
        label: this.currentNodeData.label,
        upstreams: incoming.map(edge => edge.getSourceCellId())
      }
      this.drawerUpstreamOptions = this.graph.getNodes()
        .filter(candidate => candidate.id !== id && candidate.shape !== 'RESPONSE')
        .map(candidate => ({
          id: candidate.id,
          label: `${candidate.shape === 'QUERY'
            ? this.$t('modules.workflow.question')
            : this.moduleTitleOf(candidate.shape)} · ${candidate.store?.data?.label || candidate.id}`
        }))
      this.selectNodeView(id)
      this.isComponentLoaded = false
      this.dynamicComponent = null
      if (!this.drawerFixed) {
        const directory = this.shapeAndPortIdMap[shape]
        this.dynamicComponent = require(`../modules/${directory}/Drawer`).default
        this.$nextTick(() => {
          this.isComponentLoaded = true
        })
      }
      this.$refs.drawerFrameRef?.openDrawer(shape)
    },
    /** 节点 / 连线 / 算子删除统一确认。 */
    async confirmNodeDeletion (id) {
      const node = this.graph?.getCellById?.(id)
      if (!node || node.shape === 'QUERY' || node.shape === 'RESPONSE') {
        return false
      }
      const operators = getNodeOperators({
        shape: node.shape,
        variables: this.nodeVariables(node)
      })
      return await requestDeletion({
        resourceType: this.$t('modules.workflow.resourceNode'),
        title: this.$t('modules.workflow.deleteNode'),
        warning: this.$t('modules.workflow.deleteNodeWarning'),
        description: this.$t('modules.workflow.deleteNodeDescription'),
        items: [{
          id,
          name: this.nodeDisplayName(id),
          meta: `${id} · ${this.$t('modules.workflow.operatorCountBadge', { count: operators.length })}`
        }],
        verification: false,
        hint: this.$t('modules.workflow.deleteNodeHint'),
        confirmText: this.$t('modules.workflow.deleteNodeConfirm')
      })
    },
    /** 删除节点后用「上游→下游」桥接连线，避免整条链路断掉。 */
    removeNodeWithBridge (id) {
      const incoming = this.graph.getIncomingEdges(id) || []
      const outgoing = this.graph.getOutgoingEdges(id) || []
      const bridges = []
      incoming.forEach(sourceEdge => {
        outgoing.forEach(targetEdge => {
          const sourceId = sourceEdge.getSourceCellId()
          const targetId = targetEdge.getTargetCellId()
          if (!sourceId || !targetId || sourceId === targetId) {
            return
          }
          const targetPort = this.graph.getCellById(targetId)?.getPortsByGroup('in')?.[0]?.id
          if (!targetPort) {
            return
          }
          const exists = this.graph.getEdges().some(edge =>
            edge.getSourceCellId() === sourceId && edge.getTargetCellId() === targetId
          )
          if (!exists) {
            bridges.push({
              source: { cell: sourceId, port: sourceEdge.getSourcePortId() },
              target: { cell: targetId, port: targetPort },
              attrs: { line: edgeLineAttrs() }
            })
          }
        })
      })
      this.graph.removeNode(id)
      bridges.forEach(edge => this.graph.addEdge(edge))
      this.scheduleGeometrySync()
      this.syncGraphStats()
    },
    async deleteCurrentNode () {
      const id = this.currentNodeId
      if (!id || !await this.confirmNodeDeletion(id)) {
        return
      }
      this.$refs.drawerFrameRef?.closeDrawer()
      this.clearNodeSelection()
      this.removeNodeWithBridge(id)
      this.currentNodeId = ''
    },
    /** 抽屉里的「输入连接」：从图中的入边实时取，删除即断开连线。 */
    refreshDrawerInputs () {
      if (!this.graph || !this.currentNodeId) {
        this.drawerInputs = [];
        return;
      }
      const edges = this.graph.getIncomingEdges(this.currentNodeId) || [];
      this.drawerInputs = edges.map(edge => {
        const sourceId = edge.getSourceCellId();
        const source = sourceId ? this.graph.getCellById(sourceId) : null;
        return {
          edgeId: edge.id,
          label: source?.store?.data?.label || sourceId || '--',
          port: edge.getSourcePortId() || ''
        };
      });
    },
    removeDrawerInput (edgeId) {
      this.graph.removeEdge(edgeId);
      this.$nextTick(() => this.refreshDrawerInputs());
    },
    async deleteNode (id) {
      if (!await this.confirmNodeDeletion(id)) {
        return
      }
      this.removeNodeWithBridge(id)
    },
    inputDeleteHandle (inputVariable, id) {
      const incomingE = this.graph.getIncomingEdges(id)
      incomingE && incomingE.forEach(item => {
        const sourcePortId = item.getSourcePortId()
        const sourceCell = item.getSourceCell()
        if (sourcePortId === inputVariable.key && sourceCell.id === inputVariable.sourceNode) {
          this.graph.removeEdge(item.id)
        }
      })
    },
    initCardHandle (nodeInfo) {
      const prop = nodeInfo.variables[this.shapeAndPortIdMap[nodeInfo.componentType]]
      if (prop) {
        for (let i = 0; i < prop.length; i++) {
          prop[i].id = `${nodeInfo.id}_${i + 1}`
        }
      }
      const target = this.graph.getCellById(nodeInfo.id)
      target.setProp('variables', nodeInfo.variables)
      target.setData({
        type: 'saveData',
        variables: nodeInfo.variables
      })
      this.scheduleGeometrySync()
      this.syncGraphStats()
    },
    /**
     * 抽屉里的「输入 · 上游节点」多选：只保留选中的入边，缺的补上。
     * 先按「删掉当前节点全部入边」的边集做环检测，避免删完一半才发现成环。
     */
    applyDrawerUpstreams (target, upstreams) {
      const targetPortId = target.getPortsByGroup('in')?.[0]?.id
      if (!targetPortId) {
        return this.$t('modules.workflow.noInputPort')
      }
      const desired = [...new Set((upstreams || []).filter(Boolean))]
      if (!desired.length) {
        return this.$t('modules.workflow.needUpstream')
      }
      const incoming = this.graph.getIncomingEdges(target.id) || []
      const keptEdges = (this.graph.getEdges() || []).filter(edge => edge.getTargetCellId() !== target.id)
      const edgeList = keptEdges.map(edge => ({
        source: edge.getSourceCellId(),
        target: edge.getTargetCellId()
      }))
      for (const sourceId of desired) {
        if (!this.graph.getCellById(sourceId)) {
          return this.$t('modules.workflow.upstreamMissing')
        }
        if (edgeList.some(edge => edge.source === sourceId && edge.target === target.id)) {
          continue
        }
        if (this.wouldCreateCycleInEdges(edgeList, sourceId, target.id)) {
          return this.$t('modules.workflow.connectionCycle')
        }
        edgeList.push({ source: sourceId, target: target.id })
      }
      incoming.forEach(edge => {
        if (!desired.includes(edge.getSourceCellId())) {
          this.graph.removeEdge(edge.id)
        }
      })
      desired.forEach(sourceId => {
        const exists = (this.graph.getIncomingEdges(target.id) || [])
          .some(edge => edge.getSourceCellId() === sourceId)
        if (exists) {
          return
        }
        const source = this.graph.getCellById(sourceId)
        const sourcePortId = source?.getPortsByGroup('out')?.[0]?.id
        if (!sourcePortId) {
          return
        }
        this.graph.addEdge({
          source: { cell: sourceId, port: sourcePortId },
          target: { cell: target.id, port: targetPortId },
          attrs: { line: edgeLineAttrs() }
        })
      })
      return ''
    },
    drawerSubmitHandle () {
      const componentRef = this.$refs[`${this.currentNodeData.componentType}Ref`]
      if (!componentRef) {
        return
      }
      // ⚠️ `validate()` 是**工厂**（返回回调式校验器），但**调用本身有副作用**：
      // 它内部跑 `validateAndStoreKnowledgeBaseNames()`，失败时弹
      // 「…知识资产已删除，请更新配置！」。取一次、判一次、用一次
      // （保持 `componentRef.validate()` 的方法调用形式，别先解构成裸函数再调 —— 那样会丢 `this`）。
      const validate = componentRef.validate
      if (typeof validate !== 'function') {
        return
      }
      const validator = componentRef.validate()
      if (typeof validator !== 'function') {
        return
      }
      validator(valid => {
        if (!valid) {
          return
        }
        const target = this.graph.getCellById(this.currentNodeData.id)
        if (!target) {
          return
        }
        const label = (this.drawerBasics.label || '').trim()
        if (!label) {
          this.showDrawerError(this.$t('modules.workflow.nodeNameRequired'))
          return
        }
        const upstreamError = this.applyDrawerUpstreams(target, this.drawerBasics.upstreams)
        if (upstreamError) {
          this.showDrawerError(upstreamError)
          return
        }
        const data = componentRef.sendOperatorListData()
        const moduleKey = this.shapeAndPortIdMap[this.currentNodeData.componentType]
        ;(data?.[moduleKey] || []).forEach(item => Reflect.deleteProperty(item, 'showConfig'))
        target.setProp('label', label)
        // 两份 variables 整体替换（默认深合并会把删掉的库/算子留在数组尾巴里，
        // 见 lib/cellData.js 的注释）
        replaceNodeVariables(target, data)
        this.currentNodeData.label = label
        this.currentNodeData.variables = data
        this.$refs.drawerFrameRef?.closeDrawer()
        this.clearNodeSelection()
        this.currentNodeId = ''
        this.scheduleGeometrySync()
        this.syncGraphStats()
        this.refreshStructKnowledgeFlag()
        this.$message.success(this.$t('modules.workflow.nodeApplied'))
      })
    },
    drawerCancelHandle () {
      this.clearNodeSelection()
      this.currentNodeId = ''
    }
  }
}
