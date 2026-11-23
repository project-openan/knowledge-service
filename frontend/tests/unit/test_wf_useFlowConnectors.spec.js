import { describe, expect, it, vi } from 'vitest'

// X6 的连接器注册是模块级的（import 即注册）：mock 掉 @antv/x6，把注册表接住，
// 再直接调用注册进去的连线器函数 —— 不需要真的跑一个 Graph 实例。
// （vi.mock 会被提升到 const 之前执行，注册表必须用 vi.hoisted 造。）
const { registeredConnectors } = vi.hoisted(() => ({
  registeredConnectors: {}
}))

// useNodeConfig 只用 types.ts 的 ComponentEnum 形状枚举；types.ts 本体在 import 期
// 用 webpack 的 require() 拉 svg（vitest 里解析不了），这里换一个形状等价的桩。
vi.mock('@/features/workflow/types', () => ({
  ComponentEnum: {
    PRE_RETRIEVER: 'PRE_RETRIEVER',
    RETRIEVER: 'RETRIEVER',
    POST_RETRIEVER: 'POST_RETRIEVER',
    RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
  }
}))

vi.mock('@antv/x6', () => ({
  Graph: {
    registerConnector: (name, factory) => {
      registeredConnectors[name] = factory
    }
  },
  Shape: { Edge: class {} }
}))

import { edgeLineAttrs, portDirectionFor } from '@/features/workflow/composables/useFlowConnectors'
import { directionOf } from '@/features/workflow/lib/flowGeometry'

describe('useFlowConnectors：连线器注册', () => {
  it('import 即注册 flow-prototype 与 flow-adaptive 两个连线器', () => {
    expect(typeof registeredConnectors['flow-prototype']).toBe('function')
    expect(typeof registeredConnectors['flow-adaptive']).toBe('function')
  })
})

describe('flow-prototype：入口在左侧的贝塞尔（含环回分支）', () => {
  it('目标在右侧：水平距离 45% 作控制点偏移', () => {
    const path = registeredConnectors['flow-prototype'](
      { x: 0, y: 100 },
      { x: 300, y: 100 }
    )
    // bend = max(60, 300*0.45=135)
    expect(path).toBe('M0,100 C135,100 165,100 300,100')
  })

  it('水平距离很小时控制点偏移回落到 60', () => {
    const path = registeredConnectors['flow-prototype'](
      { x: 0, y: 0 },
      { x: 20, y: 0 }
    )
    expect(path).toBe('M0,0 C60,0 -40,0 20,0')
  })

  it('环回（目标在左侧且高度接近 30px 内）：从节点上方绕回', () => {
    const path = registeredConnectors['flow-prototype'](
      { x: 300, y: 200 },
      { x: 20, y: 190 }
    )
    // top = min(200,190) - 102 = 88
    expect(path).toContain('C340,200 340,88')
    expect(path).toContain(`L20,88`)
    expect(path).toContain('C-20,88 -20,190 20,190')
  })

  it('目标在左侧但高度差超过 30px：不走环回分支', () => {
    const path = registeredConnectors['flow-prototype'](
      { x: 300, y: 0 },
      { x: 0, y: 200 }
    )
    // bend = max(60, 300*0.45) = 135；控制点 1 = x+bend，控制点 2 = tx-bend
    expect(path).toBe('M300,0 C435,0 -135,200 0,200')
  })
})

describe('edgeLineAttrs：细线样式', () => {
  it('1.6px 圆头细线并显式去掉终点箭头', () => {
    const attrs = edgeLineAttrs()
    expect(attrs.strokeWidth).toBe(1.6)
    expect(attrs.strokeLinecap).toBe('round')
    expect(attrs.strokeLinejoin).toBe('round')
    expect(attrs.vectorEffect).toBe('non-scaling-stroke')
    expect(attrs.targetMarker).toBeNull()
    expect(typeof attrs.stroke).toBe('string')
    expect(attrs.stroke.length).toBeGreaterThan(0)
  })
})

describe('portDirectionFor：由端口坐标反推控制柄方向', () => {
  /** 造一条边 + 一个带端口的节点，模拟 X6 的边/节点 API。 */
  function edgeWithPort ({ nodeId = 'n1', portId = 'p1', args = { x: 0, y: 50 }, size = { width: 264, height: 160 } } = {}) {
    const node = {
      getPort: id => (id === portId ? { id, args } : null),
      getSize: () => size
    }
    return {
      getSourceCellId: () => nodeId,
      getTargetCellId: () => nodeId,
      getSourcePortId: () => portId,
      getTargetPortId: () => portId,
      model: { getCell: id => (id === nodeId ? node : null) }
    }
  }

  it('左端口 → 向左；右端口 → 向右', () => {
    const left = portDirectionFor(edgeWithPort({ args: { x: 0, y: 50 } }), 'source')
    expect(left).toEqual(directionOf('left'))
    const right = portDirectionFor(edgeWithPort({ args: { x: 264, y: 50 } }), 'target')
    expect(right).toEqual(directionOf('right'))
  })

  it('下端口（y = geometry.height，节点高 frameHeight 多 2px）→ 向下', () => {
    const down = portDirectionFor(edgeWithPort({ args: { x: 132, y: 158 } }), 'source')
    expect(down).toEqual(directionOf('bottom'))
  })

  it('上端口 → 向上', () => {
    const up = portDirectionFor(edgeWithPort({ args: { x: 132, y: 0 } }), 'target')
    expect(up).toEqual(directionOf('top'))
  })

  it('端口坐标落在卡片中间：退回端点默认朝向（source=右 / target=左）', () => {
    const source = portDirectionFor(edgeWithPort({ args: { x: 132, y: 80 } }), 'source')
    expect(source).toEqual(directionOf('right'))
    const target = portDirectionFor(edgeWithPort({ args: { x: 132, y: 80 } }), 'target')
    expect(target).toEqual(directionOf('left'))
  })

  it('取不到节点 / 端口 id：退回默认朝向', () => {
    const noNode = edgeWithPort()
    noNode.model.getCell = () => null
    expect(portDirectionFor(noNode, 'source')).toEqual(directionOf('right'))

    const noPortId = edgeWithPort()
    noPortId.getSourcePortId = () => ''
    noPortId.getTargetPortId = () => ''
    expect(portDirectionFor(noPortId, 'target')).toEqual(directionOf('left'))
  })

  it('source / target 各读各的 cell 与 port', () => {
    const sourceNode = {
      getPort: id => (id === 'sp' ? { id, args: { x: 264, y: 10 } } : null),
      getSize: () => ({ width: 264, height: 160 })
    }
    const targetNode = {
      getPort: id => (id === 'tp' ? { id, args: { x: 0, y: 10 } } : null),
      getSize: () => ({ width: 264, height: 160 })
    }
    const edge = {
      getSourceCellId: () => 'src',
      getTargetCellId: () => 'dst',
      getSourcePortId: () => 'sp',
      getTargetPortId: () => 'tp',
      model: {
        getCell: id => (id === 'src' ? sourceNode : (id === 'dst' ? targetNode : null))
      }
    }
    expect(portDirectionFor(edge, 'source')).toEqual(directionOf('right'))
    expect(portDirectionFor(edge, 'target')).toEqual(directionOf('left'))
  })

  it('getPort 返回 undefined（端口缺 args）：退回默认朝向而不是抛错', () => {
    const edge = edgeWithPort({ portId: 'p1' })
    const node = edge.model.getCell('n1')
    node.getPort = () => undefined
    expect(portDirectionFor(edge, 'source')).toEqual(directionOf('right'))
  })

  it('边没有 model（预览边）：退回默认朝向', () => {
    const edge = edgeWithPort()
    edge.model = undefined
    expect(portDirectionFor(edge, 'target')).toEqual(directionOf('left'))
  })
})

describe('flow-adaptive：自适应连线器', () => {
  const viewWith = edge => ({ cell: edge })

  it('预览边（无目标 cell）：控制柄取起点的反方向', () => {
    const edge = {
      getSourceCellId: () => 'src',
      getTargetCellId: () => '',
      getSourcePortId: () => 'sp',
      getTargetPortId: () => '',
      model: { getCell: () => null }
    }
    const path = registeredConnectors['flow-adaptive'](
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      [],
      {},
      viewWith(edge)
    )
    // a = right(1,0)；b = 反方向(-1,0)
    expect(path).toContain('C')
    expect(path).toMatch(/^M0,0/)
  })

  it('正式边：两端各自按端口朝向取控制柄', () => {
    const node = {
      getPort: id => (id === 'sp' ? { id, args: { x: 264, y: 0 } } : null),
      getSize: () => ({ width: 264, height: 160 })
    }
    const edge = {
      getSourceCellId: () => 'src',
      getTargetCellId: () => 'dst',
      getSourcePortId: () => 'sp',
      getTargetPortId: () => 'tp',
      model: { getCell: id => (id === 'src' ? node : null) }
    }
    const path = registeredConnectors['flow-adaptive'](
      { x: 264, y: 0 },
      { x: 500, y: 0 },
      [],
      {},
      viewWith(edge)
    )
    // a = right(1,0)、b = left(-1,0)：控制柄 = clamp(236*0.5, 32, 180) = 118
    expect(path).toBe('M264,0 C382,0 382,0 500,0')
  })

  it('没有 view（无 cell）：source 退回向右、target 退回向左', () => {
    const path = registeredConnectors['flow-adaptive'](
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      [],
      {},
      undefined
    )
    expect(path.startsWith('M0,0')).toBe(true)
    expect(path.endsWith('100,0')).toBe(true)
  })

  it('目标 cell 存在但取不到端口：target 退回向左', () => {
    const edge = {
      getSourceCellId: () => 'src',
      getTargetCellId: () => 'dst',
      getSourcePortId: () => '',
      getTargetPortId: () => '',
      model: { getCell: () => null }
    }
    const path = registeredConnectors['flow-adaptive'](
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      [],
      {},
      viewWith(edge)
    )
    expect(typeof path).toBe('string')
    expect(path).toContain('C')
  })
})

describe('真连线器与 flowCurve 的产物一致', () => {
  it('flow-adaptive 的路径就是 flowCurve 的 path 字段', async () => {
    const { flowCurve } = await import('@/features/workflow/lib/flowGeometry')
    const edge = {
      getSourceCellId: () => '',
      getTargetCellId: () => '',
      getSourcePortId: () => '',
      getTargetPortId: () => '',
      model: { getCell: () => null }
    }
    const path = registeredConnectors['flow-adaptive'](
      { x: 10, y: 20 },
      { x: 300, y: 80 },
      [],
      {},
      { cell: edge }
    )
    const expected = flowCurve(
      { x: 10, y: 20 },
      { x: 300, y: 80 },
      directionOf('right'),
      { dx: -1, dy: 0 }
    ).path
    expect(path).toBe(expected)
  })
})
