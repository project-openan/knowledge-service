import { Graph } from '@antv/x6'
import { directionOf, flowCurve, portSideFromPoint } from '@/features/workflow/lib/flowGeometry'
import { getGraphColors } from '@/features/workflow/useNodeConfig'

/**
 * X6 连线器与连线样式的唯一定义点（画布装配的底层依赖）。
 *
 * edgeLineAttrs / portDirectionFor 被画布事件、几何装饰、连线交互多处复用，
 * 收进独立模块避免循环引用；连接器注册保持**模块级**执行（与拆分前一致：
 * 页面模块被 import 时注册一次）。
 */

/**
 * edgePath()：先画到目标节点左侧的入口点。
 * 用 `max(60, 水平距离 * 0.45)` 作控制点偏移，环回边（目标在源左侧且
 * 高度接近）从节点上方绕回；这里注册成 X6 connector。
 */
Graph.registerConnector('flow-prototype', (source, target) => {
  const x = source.x
  const y = source.y
  const tx = target.x
  const ty = target.y
  if (tx < x && Math.abs(ty - y) < 30) {
    // top 取节点顶边再上移 30；端口在节点顶边下 72，故此处减 102
    const top = Math.min(y, ty) - 102
    return `M${x},${y} C${x + 40},${y} ${x + 40},${top} ${x},${top} L${tx},${top} C${tx - 40},${top} ${tx - 40},${ty} ${tx},${ty}`
  }
  const bend = Math.max(60, Math.abs(tx - x) * 0.45)
  return `M${x},${y} C${x + bend},${y} ${tx - bend},${ty} ${tx},${ty}`
}, true)

/** .flow-edge：1.6px 圆头细线；颜色/悬停由 CSS（--flow-line）接管。 */
function edgeLineAttrs () {
  return {
    stroke: getGraphColors().edge,
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    vectorEffect: 'non-scaling-stroke',
    // X6 默认在终点画 classic 箭头；方向由线中段 12×10 箭头表达（t=0.55），
    // 终点箭头会与之重复（短连线几乎叠在一起），这里显式清掉。
    targetMarker: null
  }
}

/**
 * 连接器读取端口所在的一侧，返回贝塞尔控制柄方向。
 * 端口坐标是节点坐标系里的绝对坐标，节点尺寸 = 卡片实际尺寸；
 * 预览边没有目标 cell 时退回左右方向。
 */
function portDirectionFor (edge, end) {
  const nodeId = end === 'source' ? edge.getSourceCellId() : edge.getTargetCellId()
  const portId = end === 'source' ? edge.getSourcePortId() : edge.getTargetPortId()
  const node = nodeId ? edge.model?.getCell(nodeId) : null
  if (!node || !portId) {
    return directionOf(end === 'source' ? 'right' : 'left')
  }
  const args = node.getPort(portId)?.args || {}
  const size = node.getSize()
  // 下端口 y = geometry.height，而节点高 = frameHeight（多 2px 描边），
  // 不能按 0.5px 容差判等，否则会退回左右朝向、把连线画成绕回来的圈。
  const side = portSideFromPoint({ x: args.x, y: args.y, width: size.width, height: size.height })
  return directionOf(side || (end === 'source' ? 'right' : 'left'))
}

Graph.registerConnector('flow-adaptive', (source, target, routePoints, options, view) => {
  const edge = view?.cell
  const a = edge ? portDirectionFor(edge, 'source') : directionOf('right')
  // 预览边还没有目标 cell：控制柄取起点的反方向（{dx:-a.dx}）
  const b = edge && edge.getTargetCellId()
    ? portDirectionFor(edge, 'target')
    : { dx: -a.dx, dy: -a.dy }
  return flowCurve(
    { x: source.x, y: source.y },
    { x: target.x, y: target.y },
    a,
    b
  ).path
}, true)

export { edgeLineAttrs, portDirectionFor }
