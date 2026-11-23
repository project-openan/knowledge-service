import { Document, Share, Coin } from '@/shared/lib/icons'
import {
  flowCurve,
  getNodeOperators,
  nodeGeometry,
  portPosition,
  portSide
} from '@/features/workflow/lib/flowGeometry'
import { sourceKindMeta, sourceKindsFromOperators } from '@/features/workflow/lib/retrievalSources'
import { portDirectionFor } from '@/features/workflow/composables/useFlowConnectors'

/**
 * 画布交互 · 卡片几何 / 端口 / 连线装饰 / 统计与排版缩放（composable）。
 *
 * 职责：让 X6 节点尺寸与端口坐标跟随卡片实际几何（syncAllNodeGeometry）、
 * 线中段箭头与端口 a11y 装饰（decorateEdges / decoratePortA11y）、画布
 * 统计与来源类型标签、拓扑排版与缩放（zoom / fit）。
 */
export function useFlowGeometry () {
  return {
    moduleTitleKeyOf (shape) {
      return {
        PRE_RETRIEVER: 'ragFlow.preretrieverTitle',
        RETRIEVER: 'ragFlow.retrieverTitle',
        POST_RETRIEVER: 'ragFlow.postretrieverTitle',
        RESPONSE_SYNTHESIZER: 'ragFlow.responsesynthesizerTitle',
        QUERY: 'ragFlow.start',
        RESPONSE: 'ragFlow.end'
      }[shape] || ''
    },
    moduleTitleOf (shape) {
      const key = this.moduleTitleKeyOf(shape)
      return key ? this.$t(key) : ''
    },
    moduleToneOf (shape) {
      return {
        PRE_RETRIEVER: 'purple',
        RETRIEVER: 'orange',
        POST_RETRIEVER: 'blue',
        RESPONSE_SYNTHESIZER: 'green',
        QUERY: 'blue',
        RESPONSE: 'blue'
      }[shape] || 'blue'
    },
    nodeVariables (node) {
      const data = node?.store?.data || {}
      return data.data?.variables ?? data.variables
    },
    nodeGeometryFor (node) {
      const shape = node?.shape || node?.store?.data?.shape
      const variables = this.nodeVariables(node)
      const operators = getNodeOperators({ shape, variables })
      const inputCount = (this.graph?.getIncomingEdges?.(node.id) || []).length
      return nodeGeometry({ shape, operatorCount: operators.length, inputCount })
    },
    scheduleGeometrySync () {
      if (this.geometryFrame) {
        return
      }
      this.geometryFrame = requestAnimationFrame(() => {
        this.geometryFrame = null
        this.syncAllNodeGeometry()
      })
    },
    /**
     * 让 X6 节点尺寸 / 端口坐标与卡片几何一致。
     *
     * 卡片宽度固定 264、高度由算子行和上游输入行决定；端口在左/右/上/下四边中
     * 选择朝向，删掉连线后保持上一次朝向（portSideCache）。
     */
    syncAllNodeGeometry () {
      if (!this.graph) {
        return
      }
      const infos = new Map()
      this.graph.getNodes().forEach(node => {
        const geometry = this.nodeGeometryFor(node)
        infos.set(node.id, { node, geometry })
        const size = node.getSize()
        if (Math.abs(size.width - geometry.width) > 0.5 || Math.abs(size.height - geometry.frameHeight) > 0.5) {
          node.resize(geometry.width, geometry.frameHeight, { silent: true })
        }
      })
      infos.forEach(({ node, geometry }) => {
        const position = node.getPosition()
        const peersFor = direction => {
          const edges = direction === 'output'
            ? (this.graph.getOutgoingEdges(node.id) || [])
            : (this.graph.getIncomingEdges(node.id) || [])
          return edges.map(edge => {
            const id = direction === 'output' ? edge.getTargetCellId() : edge.getSourceCellId()
            const peer = infos.get(id)
            if (!peer) {
              return null
            }
            const peerPosition = peer.node.getPosition()
            return {
              x: peerPosition.x,
              y: peerPosition.y,
              width: peer.geometry.width,
              height: peer.geometry.height
            }
          }).filter(Boolean)
        }
        const previous = this.portSideCache[node.id] || {}
        const outputSide = portSide({
          node: position,
          peers: peersFor('output'),
          geometry,
          direction: 'output',
          fallbackSide: previous.output
        })
        const inputSide = portSide({
          node: position,
          peers: peersFor('input'),
          geometry,
          direction: 'input',
          fallbackSide: previous.input
        })
        this.portSideCache[node.id] = { input: inputSide, output: outputSide }
        this.applyPortPosition(node, 'in', inputSide, 'input', geometry)
        this.applyPortPosition(node, 'out', outputSide, 'output', geometry)
      })
      this.scheduleEdgeDecorations()
    },
    applyPortPosition (node, group, side, direction, geometry) {
      const port = node.getPortsByGroup(group)?.[0]
      if (!port) {
        return
      }
      const point = portPosition({ geometry, side, direction })
      const current = port.args || {}
      if (Math.abs((current.x || 0) - point.x) < 0.01 && Math.abs((current.y || 0) - point.y) < 0.01) {
        return
      }
      node.portProp(port.id, 'args', point)
    },
    /** 线中段的实心箭头：在 t=0.55 处画 12×10、随缩放反比缩放、带画布底色描边。 */
    scheduleEdgeDecorations () {
      if (this.decorateFrame) {
        return
      }
      this.decorateFrame = requestAnimationFrame(() => {
        this.decorateFrame = null
        this.decorateEdges()
        // X6 的边视图更新（端口移动后的端点/路径重算）排在 requestIdleCallback 队列里，
        // 可能晚于这里的 rAF：箭头会先按旧端点贴一次，路径随后才变，箭头就留在了原地。
        // 收尾等空闲队列刷完再贴一次，箭头才落在最终曲线上。
        this.scheduleEdgeSettle()
      })
    },
    scheduleEdgeSettle () {
      if (this.decorateIdle) {
        return
      }
      const run = () => {
        this.decorateIdle = null
        this.decorateEdges()
      }
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        this.decorateIdle = window.requestIdleCallback(run, { timeout: 120 })
      } else {
        this.decorateIdle = window.setTimeout(run, 0)
      }
    },
    decorateEdges () {
      if (!this.graph) {
        return
      }
      const zoom = this.graph.zoom() || 1
      this.graph.getEdges().forEach(edge => {
        const view = this.graph.findViewByCell(edge)
        if (!view?.container) {
          return
        }
        const preview = !!edge.getData()?.preview
        view.container.classList.toggle('flow-edge-preview', preview)
        view.container.classList.toggle('flow-connection', !preview)
        view.container.classList.toggle('selected', !preview && this.selectedEdge?.id === edge.id)
        if (preview) {
          return
        }
        const hit = view.container.querySelector('path')
        if (hit) {
          hit.setAttribute('tabindex', '0')
          hit.setAttribute('role', 'button')
          hit.setAttribute(
            'aria-label',
            this.$t('modules.workflow.selectEdgeLabel', {
              source: this.nodeDisplayName(edge.getSourceCellId()),
              target: this.nodeDisplayName(edge.getTargetCellId())
            })
          )
        }
        let arrow = view.container.querySelector('.flow-edge-direction')
        if (!arrow) {
          arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          arrow.setAttribute('d', 'M-6,-5 L6,0 L-6,5 L-2,0 Z')
          arrow.setAttribute('class', 'flow-edge-direction')
          view.container.appendChild(arrow)
        }
        const source = view.sourcePoint
        const target = view.targetPoint
        if (!source || !target) {
          return
        }
        const a = portDirectionFor(edge, 'source')
        const b = portDirectionFor(edge, 'target')
        const connection = flowCurve(
          { x: source.x, y: source.y },
          { x: target.x, y: target.y },
          a,
          b
        )
        arrow.setAttribute(
          'transform',
          `translate(${connection.arrow.x},${connection.arrow.y}) rotate(${connection.arrow.angle}) scale(${1 / zoom})`
        )
      })
      this.decoratePortA11y()
    },
    /** X6 的端口是 SVG 圆点：补 tabindex/role/aria，支持键盘 Tab + Enter 连线。 */
    decoratePortA11y () {
      this.graph?.getNodes?.().forEach(node => {
        const view = this.graph.findViewByCell(node)
        const title = this.moduleTitleOf(node.shape) || node.store?.data?.label || node.id
        ;(node.getPorts() || []).forEach(port => {
          if (!port?.id) {
            return
          }
          const element = view?.container?.querySelector?.(`[port="${port.id}"]`)
          if (!element) {
            return
          }
          element.setAttribute('tabindex', '0')
          element.setAttribute('role', 'button')
          element.setAttribute(
            'aria-label',
            port.group === 'out'
              ? this.$t('modules.workflow.connectFromNode', { name: title })
              : this.$t('modules.workflow.connectToNode', { name: title })
          )
        })
      })
    },
    nodeDisplayName (id) {
      const node = this.graph?.getCellById?.(id)
      if (!node) {
        return id
      }
      return this.moduleTitleOf(node.shape) || node.store?.data?.label || id
    },
    topologicalOrderNodes () {
      const nodes = this.graph?.getNodes?.() || []
      const degree = new Map(nodes.map(node => [node.id, (this.graph.getIncomingEdges(node.id) || []).length]))
      const queue = nodes.filter(node => degree.get(node.id) === 0)
      const result = []
      while (queue.length) {
        const node = queue.shift()
        result.push(node)
        for (const edge of this.graph.getOutgoingEdges(node.id) || []) {
          const targetId = edge.getTargetCellId()
          degree.set(targetId, degree.get(targetId) - 1)
          if (degree.get(targetId) === 0) {
            const target = this.graph.getCellById(targetId)
            if (target) {
              queue.push(target)
            }
          }
        }
      }
      nodes.forEach(node => {
        if (!result.includes(node)) {
          result.push(node)
        }
      })
      return result
    },
    /** 基准布局：拓扑序每列两张卡，列宽 264+76、上下间距 48。 */
    layoutWorkflowNodes () {
      const order = this.topologicalOrderNodes()
      if (!order.length) {
        return
      }
      const info = new Map(order.map(node => [node.id, this.nodeGeometryFor(node)]))
      const width = info.get(order[0].id).width
      order.forEach((node, index) => {
        const column = Math.floor(index / 2)
        const x = 60 + column * (width + 76)
        const y = index % 2
          ? 60 + info.get(order[index - 1].id).height + 48
          : 60
        node.position(x, y)
      })
      this.portSideCache = {}
      this.syncAllNodeGeometry()
    },
    arrangeWorkflow () {
      if (!this.graph?.getNodes?.().length) {
        return
      }
      this.toolsOpen = false
      this.layoutWorkflowNodes()
      this.$nextTick(() => this.zoom('fit'))
    },
    resetZoom () {
      if (!this.graph) {
        return
      }
      this.graph.zoomTo(1)
      this.scheduleEdgeDecorations()
    },
    zoom (type = 'in') {
      // 按 15% 比例缩放，范围 0.2–1.6，缩放到画布中心。
      if (type === 'in' || type === 'out') {
        const factor = type === 'in' ? 1.15 : 1 / 1.15
        const next = Math.min(1.6, Math.max(0.2, this.graph.zoom() * factor))
        this.graph.zoom(next, { absolute: true })
        return
      }
      // 底部「适应画布」：与 fit() 语义一致 —— 按实测卡片
      // 尺寸算出能放下整张图的缩放（0.2–1.6，最多 100%），再居中/左上对齐。
      const nodes = this.graph?.getNodes?.() || []
      if (!nodes.length) {
        return
      }
      const { width, height } = this.getCanvasSize()
      const boxes = nodes.map(node => {
        const position = node.getPosition()
        const size = this.getNodeDisplaySize(node)
        return {
          left: position.x,
          top: position.y,
          right: position.x + size.width,
          bottom: position.y + size.height
        }
      })
      const minX = Math.min(...boxes.map(box => box.left))
      const minY = Math.min(...boxes.map(box => box.top))
      const contentWidth = Math.max(...boxes.map(box => box.right)) - minX
      const contentHeight = Math.max(...boxes.map(box => box.bottom)) - minY
      const padding = 60
      const zoom = Math.min(1.6, Math.max(0.2, Math.min(
        (width - padding) / Math.max(1, contentWidth),
        (height - padding) / Math.max(1, contentHeight),
        1
      )))
      this.graph.zoomTo(zoom)
      const translateX = contentWidth * zoom <= width - padding
        ? (width - contentWidth * zoom) / 2 - minX * zoom
        : 24 - minX * zoom
      const translateY = contentHeight * zoom <= height - padding
        ? (height - contentHeight * zoom) / 2 - minY * zoom
        : 24 - minY * zoom
      this.graph.translate(translateX, translateY)
    },
    // 端口 y 不再按「算子条数 × 24」硬算，统一交给卡片几何。
    updateOuputPortForSingleOutput () {
      this.scheduleGeometrySync()
    },
    updatePortAfterChangingOperators () {
      this.scheduleGeometrySync()
    },
    syncGraphStats () {
      const nodes = this.graph?.getNodes?.() || []
      this.nodeCount = nodes.length
      this.edgeCount = (this.graph?.getEdges?.() || []).filter(edge => !edge.getData()?.preview).length
      const operators = nodes.flatMap(node => getNodeOperators({
        shape: node.shape,
        variables: this.nodeVariables(node)
      }))
      this.operatorCount = operators.length
      this.sourceKinds = sourceKindsFromOperators(operators)
    },
    /** 来源类型 meta + 图标（模板里按 kind 取）。 */
    sourceKindOf (kind) {
      const icons = { knowledge: Document, graph: Share, database: Coin }
      return { ...sourceKindMeta(kind), icon: icons[kind] || Document }
    },
    /** 只绑图谱库的工作流展示为「图谱检索」，其余仍按编排引擎显示模板名。 */
    workflowTypeLabel () {
      if (this.sourceKinds.length === 1 && this.sourceKinds[0] === 'graph') {
        return this.$t('modules.workflow.graphRetrieval')
      }
      return this.workflowTypeMap[this.queryEngineType] || ''
    }
  }
}
