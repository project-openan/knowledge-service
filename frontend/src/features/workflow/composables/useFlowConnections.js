import { Shape } from '@antv/x6'
import { requestDeletion } from '@/shared/composables/deletion'
import { edgeLineAttrs } from '@/features/workflow/composables/useFlowConnectors'

/**
 * 画布交互 · 连线（composable）。
 *
 * 职责：拖拽连线校验（含成环检测）、「点击-点击」连线模式（预览边跟随鼠标）、
 * 连线选中与删除、节点视图选中态、Esc 取消连线等键盘交互。
 */
export function useFlowConnections () {
  return {
    /** source→target 是否会形成环：从 target 顺着出边能走回 source 即为环。 */
    wouldCreateCycle (sourceId, targetId) {
      return this.wouldCreateCycleInEdges(
        (this.graph?.getEdges?.() || [])
          .filter(edge => !edge.getData()?.preview)
          .map(edge => ({
            source: edge.getSourceCellId(),
            target: edge.getTargetCellId()
          })),
        sourceId,
        targetId
      )
    },
    wouldCreateCycleInEdges (edges, sourceId, targetId) {
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
    },
    handleCanvasKeydown (event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      const portEl = event.target?.closest?.('.x6-port-body')
      if (!portEl) {
        const edgeEl = event.target?.closest?.('.x6-edge')
        const edge = edgeEl ? this.graph.getCellById(edgeEl.getAttribute('data-cell-id')) : null
        if (edge && !edge.getData()?.preview) {
          event.preventDefault()
          event.stopPropagation()
          this.selectEdge(edge)
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const group = portEl.getAttribute('port-group')
      const nodeId = portEl.closest('.x6-cell')?.getAttribute('data-cell-id')
      const portId = portEl.getAttribute('port')
      const node = nodeId ? this.graph.getCellById(nodeId) : null
      if (!node) {
        return
      }
      if (group === 'out') {
        this.beginClickConnection(node, portId)
      } else if (group === 'in' && this.connectingSource) {
        this.finishClickConnection(node)
      }
    },
    selectEdge (edge) {
      this.cancelConnection()
      this.selectedEdge = {
        id: edge.id,
        sourceLabel: this.nodeDisplayName(edge.getSourceCellId()),
        targetLabel: this.nodeDisplayName(edge.getTargetCellId())
      }
      this.scheduleEdgeDecorations()
    },
    async removeSelectedEdge () {
      const edge = this.selectedEdge
      if (!edge) {
        return
      }
      const confirmed = await requestDeletion({
        resourceType: this.$t('modules.workflow.resourceEdge'),
        title: this.$t('modules.workflow.removeEdge'),
        warning: this.$t('modules.workflow.removeEdgeWarning'),
        description: this.$t('modules.workflow.removeEdgeDescription'),
        items: [{ id: edge.id, name: `${edge.sourceLabel} → ${edge.targetLabel}` }],
        verification: false,
        hint: this.$t('modules.workflow.removeEdgeHint'),
        confirmText: this.$t('modules.workflow.removeEdgeConfirm')
      })
      if (!confirmed) {
        return
      }
      this.selectedEdge = null
      this.graph.removeEdge(edge.id)
      this.scheduleEdgeDecorations()
    },
    selectNodeView (id) {
      this.clearNodeSelection()
      const node = this.graph?.getCellById?.(id)
      const view = node ? this.graph.findViewByCell(node) : null
      view?.container?.classList.add('selected')
    },
    clearNodeSelection () {
      this.graph?.getNodes?.().forEach(node => {
        this.graph.findViewByCell(node)?.container?.classList.remove('selected')
      })
    },
    handleConnectionKey (event) {
      if (event.key !== 'Escape') {
        return
      }
      if (this.connectingSource) {
        event.preventDefault()
        event.stopPropagation()
        this.cancelConnection()
        return
      }
      if (this.selectedEdge) {
        this.selectedEdge = null
        this.scheduleEdgeDecorations()
      }
    },
    /** 点击输出端点后进入「点击-点击」连线模式，并挂一条跟随鼠标的预览边。 */
    beginClickConnection (node, portId) {
      this.cancelConnection()
      this.selectedEdge = null
      this.clearNodeSelection()
      this.connectingSource = node.id
      this.connectingSourceLabel = this.nodeDisplayName(node.id)
      this.connectingPortId = portId
      const config = node.getPort(portId)
      const position = node.getPosition()
      const args = config?.args || { x: 0, y: 0 }
      const edge = new Shape.Edge({
        source: { cell: node.id, port: portId },
        target: { x: position.x + (args.x || 0), y: position.y + (args.y || 0) },
        attrs: {
          line: {
            ...edgeLineAttrs(),
            strokeDasharray: '6 5'
          }
        },
        zIndex: 0,
        data: { preview: true }
      })
      this.graph.addEdge(edge)
      this.previewEdgeId = edge.id
      this.scheduleEdgeDecorations()
    },
    updateClickConnection (event) {
      if (!this.connectingSource || !this.previewEdgeId) {
        return
      }
      const edge = this.graph.getCellById(this.previewEdgeId)
      if (!edge) {
        return
      }
      const point = this.graph.clientToLocal(event.clientX, event.clientY)
      edge.setTarget(point)
      const portEl = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.x6-port-body')
      const group = portEl?.getAttribute('port-group') || portEl?.parentElement?.getAttribute('port-group')
      const nodeId = portEl?.closest?.('.x6-cell')?.getAttribute('data-cell-id')
      const connectable = portEl && group === 'in' && nodeId &&
        nodeId !== this.connectingSource && !this.wouldCreateCycle(this.connectingSource, nodeId)
      if (this.hoveredPortEl && this.hoveredPortEl !== portEl) {
        this.hoveredPortEl.classList.remove('is-target')
      }
      this.hoveredPortEl = connectable ? portEl : null
      if (connectable) {
        portEl.classList.add('is-target')
      }
      this.connectionTargetId = connectable ? nodeId : ''
    },
    clearHoveredPort () {
      if (this.hoveredPortEl) {
        this.hoveredPortEl.classList.remove('is-target')
        this.hoveredPortEl = null
      }
      this.connectionTargetId = ''
    },
    finishClickConnection (target) {
      const sourceId = this.connectingSource
      const sourcePort = this.connectingPortId
      const targetPort = target.getPortsByGroup('in')?.[0]?.id
      if (!sourceId || !targetPort) {
        this.cancelConnection()
        return
      }
      if (sourceId === target.id || this.wouldCreateCycle(sourceId, target.id)) {
        this.$message.warning(this.$t('modules.workflow.connectionCycle'))
        this.cancelConnection()
        return
      }
      const exists = (this.graph.getEdges() || []).some(edge =>
        edge.getSourceCellId() === sourceId && edge.getTargetCellId() === target.id
      )
      if (!exists) {
        this.graph.addEdge({
          source: { cell: sourceId, port: sourcePort },
          target: { cell: target.id, port: targetPort },
          attrs: { line: edgeLineAttrs() }
        })
        this.$message.success(this.$t('modules.workflow.connectionCreated'))
      }
      this.cancelConnection()
      this.syncGraphStats()
    },
    cancelConnection () {
      this.clearHoveredPort()
      if (this.previewEdgeId && this.graph) {
        const edge = this.graph.getCellById(this.previewEdgeId)
        if (edge) {
          this.graph.removeEdge(edge)
        }
      }
      this.previewEdgeId = ''
      this.connectingSource = ''
      this.connectingSourceLabel = ''
      this.connectingPortId = ''
      this.connectionTargetId = ''
      if (this.graph && !this.currentNodeId) {
        this.clearNodeSelection()
      }
    }
  }
}
