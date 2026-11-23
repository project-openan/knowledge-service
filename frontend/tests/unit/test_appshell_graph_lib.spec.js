// @vitest-environment jsdom
// 图谱编辑器的纯逻辑层残余（覆盖率 0%）：
//   - lib/nodeFactory.ts：主题调色板（明/暗）、形状注册入口、节点默认属性
//   - lib/schemaMapper.js：schema → 可视化映射 / 校验 / 查询三件套
//   - workflow/modules/useRowDrop.js：表格行拖拽重排（sortablejs mock）
//   - chat/lib/errors.ts：错误 → 文案收窄（errText / streamErrorMessage）
// X6 内核注册换成 spy（真实注册已有 x6EditorCore 专项 spec），sortablejs 换 mock。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// errors.ts / nodeFactory 的 $t 走真实 i18n —— 其默认语言跟浏览器（jsdom 是
// en-US）。这里在动态 import 之前钉成 zh，断言才能按中文文案比对。
localStorage.setItem('language-option', JSON.stringify('zh-CN'))

// nodeFactory 顶层 import 了内核的两个注册器；换 spy 才能断言形状清单
vi.mock('@/features/graph/lib/x6-editor-core', () => ({
  registerNodeShape: vi.fn(),
  registerEdgeShape: vi.fn()
}))

// useRowDrop 依赖 sortablejs 的真实 DOM 拖拽；mock 后聚焦重排逻辑
vi.mock('sortablejs', () => ({
  default: { create: vi.fn(() => ({ destroy: vi.fn() })) }
}))

import { registerNodeShape, registerEdgeShape } from '@/features/graph/lib/x6-editor-core'
import Sortable from 'sortablejs'
import Module from 'node:module'

// nodeFactory 用 webpack 语义的 require() 取节点 icon 贴图；vitest 是 ESM，
// '@/assets/graph_entity.svg' 无法被 Node CJS 解析器定位 —— 这里在模块解析层
// 打一个桩（仅本 spec 的 worker 内生效），注册逻辑照常执行。
const originalModuleLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === '@/assets/graph_entity.svg') {
    return 'data:image/svg+xml;mock-graph-entity-icon'
  }
  return originalModuleLoad.call(this, request, ...rest)
}

const {
  getGraphPalette,
  isDarkGraphTheme,
  applyNodeTheme,
  registerCustomNodes,
  getNodeDefaultProperties
} = await import('@/features/graph/lib/nodeFactory')
const {
  mapSchemaToVisualizationData,
  validateMappedData,
  getEntityTypes,
  getEntityProperties,
  getEntityRelations,
  hasRelation,
  getEdgeTypes,
  processSchemaInfo,
  validateSchemaInfo
} = await import('@/features/graph/lib/schemaMapper')
const defaultSchemaMapper = (await import('@/features/graph/lib/schemaMapper')).default
const { useRowDrop } = await import('@/features/workflow/modules/useRowDrop')
const { errText, streamErrorMessage } = await import('@/features/chat/lib/errors')

describe('nodeFactory：主题调色板', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('浅色主题返回内置字面量（切换回浅色 = 回到历史渲染）', () => {
    document.documentElement.classList.remove('dark')
    expect(isDarkGraphTheme()).toBe(false)
    const palette = getGraphPalette()
    expect(palette.nodeFill).toBe('#FFFFFF')
    expect(palette.canvasBackground).toBe('#F5F4F9')
    expect(palette.selection).toBe('#5F95FF')
    // 每次返回副本，外部改它不影响下一次
    palette.nodeFill = '#000'
    expect(getGraphPalette().nodeFill).toBe('#FFFFFF')
  })

  it('深色主题读 --rs-graph-* 语义变量；变量缺失时回落内置值', () => {
    document.documentElement.classList.add('dark')
    expect(isDarkGraphTheme()).toBe(true)
    const palette = getGraphPalette()
    // jsdom 没有真实 CSS 变量 → readCssVar 落到 fallback
    expect(palette.nodeFill).toBe('#13161c')
    expect(palette.canvasBackground).toBe('#080a0d')
    expect(palette.selection).toBe('#7c8cff')
    expect(palette.edgeStroke).toContain('rgba(124, 140, 255')
    expect(palette.nodeShadow).toBe('rgba(0, 0, 0, 0.45)')
  })
})

describe('nodeFactory：applyNodeTheme（原位重绘，不动几何与端口）', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  const makeNode = (ports) => ({
    attr: vi.fn(),
    getPorts: vi.fn(() => ports),
    portProp: vi.fn()
  })

  it('重绘 body/label 与每个有 id 的端口；无 id 的端口跳过', () => {
    const palette = getGraphPalette()
    const node = makeNode([{ id: 'p1' }, { id: 'p2' }, {}])
    applyNodeTheme(node, palette)

    expect(node.attr).toHaveBeenCalledWith('body/fill', palette.nodeFill)
    expect(node.attr).toHaveBeenCalledWith('label/fill', palette.nodeLabel)
    // 每个有 id 的端口写 stroke+fill 两条；无 id 端口一条都不写
    expect(node.portProp).toHaveBeenCalledTimes(4)
    expect(node.portProp).toHaveBeenCalledWith('p1', 'attrs/circle/stroke', palette.portStroke)
    expect(node.portProp).toHaveBeenCalledWith('p1', 'attrs/circle/fill', palette.portFill)
    expect(node.portProp).toHaveBeenCalledWith('p2', 'attrs/circle/stroke', palette.portStroke)
    expect(node.portProp).toHaveBeenCalledWith('p2', 'attrs/circle/fill', palette.portFill)
  })

  it('palette 缺省时实时取当前主题（深色分支）', () => {
    document.documentElement.classList.add('dark')
    const node = makeNode([])
    applyNodeTheme(node)
    expect(node.attr.mock.calls[0][1]).toBe('#13161c')
  })
})

describe('nodeFactory：registerCustomNodes（形状清单）', () => {
  it('注册 1 个基础圆节点 + 7 个类型节点 + 4 种边', () => {
    // 源码里 xlinkHref 用了 require()（webpack 语义）；vitest 是 ESM，补一个桩
    globalThis.require = vi.fn(() => 'data:image/svg+xml;mock')
    try {
      registerNodeShape.mockClear()
      registerEdgeShape.mockClear()

      registerCustomNodes()

      const nodeIds = registerNodeShape.mock.calls.map(call => call[0])
      expect(nodeIds).toContain('base-circle-node')
      for (const type of ['entity', 'fault', 'event', 'resource', 'rootCause', 'plan', 'examItem']) {
        expect(nodeIds).toContain(`${type}-node`)
      }
      // 类型节点继承基础圆节点
      expect(registerNodeShape.mock.calls.find(call => call[0] === 'entity-node')[1].inherit)
        .toBe('base-circle-node')

      const edgeIds = registerEdgeShape.mock.calls.map(call => call[0])
      expect(edgeIds).toEqual(['custom-edge', 'single-arrow-edge', 'double-arrow-edge', 'self-loop-edge'])
    } finally {
      delete globalThis.require
    }
  })

  it('基础圆节点带 icon 贴图与四个端口组', () => {
    // 自足执行：注册是幂等的，这里重跑一遍拿到自己的配置快照
    registerNodeShape.mockClear()
    registerCustomNodes()

    const [, config] = registerNodeShape.mock.calls.find(call => call[0] === 'base-circle-node')
    expect(config.inherit).toBe('circle')
    expect(config.markup.map(part => part.tagName)).toEqual(['circle', 'image', 'text'])
    expect(Object.keys(config.ports.groups)).toEqual(['top', 'bottom', 'fixedLeft', 'fixedRight'])
    expect(config.ports.items).toHaveLength(4)
  })
})

describe('nodeFactory：getNodeDefaultProperties（节点默认属性）', () => {
  it('五个中文类型名与节点面板同词条，entity/examItem 保持英文', () => {
    expect(getNodeDefaultProperties('entity')).toEqual({ name: 'Entity', description: '', attributes: [] })
    expect(getNodeDefaultProperties('examItem').name).toBe('ExamItem')
    for (const type of ['fault', 'event', 'resource', 'rootCause', 'plan']) {
      const props = getNodeDefaultProperties(type)
      expect(props.name.length).toBeGreaterThan(0)
      expect(props.description).toBe('')
      expect(props.attributes).toEqual([])
    }
    expect(getNodeDefaultProperties('rootCause').name).toBe('根因')
  })

  it('未知类型回落为类型名本身', () => {
    expect(getNodeDefaultProperties('mystery')).toEqual({ name: 'mystery', description: '', attributes: [] })
  })
})

describe('schemaMapper：mapSchemaToVisualizationData', () => {
  const SCHEMA = {
    entities: [
      { entity_type: 'Host', entity_desc: '主机', properties: [{ name: 'ip' }] },
      { entity_type: 'App' },
      { entity_desc: '没有类型的实体会被丢弃' }
    ],
    edges: [
      { edge_type: 'runs', edge_desc: '运行', source_entity: 'App', target_entity: 'Host' },
      { edge_desc: '没有 edge_type 的边会被丢弃' },
      { edge_type: 'any', properties: [] }
    ]
  }

  it('标准输入：entity_meta 按类型聚合，无 source/target 的边做全对映射', () => {
    const mapped = mapSchemaToVisualizationData(SCHEMA)

    expect(Object.keys(mapped.entity_meta)).toEqual(['Host', 'App'])
    expect(mapped.entity_meta.Host).toEqual({ entity_desc: '主机', properties: [{ name: 'ip' }] })
    expect(mapped.entity_meta.App.properties).toEqual([])

    // runs 有方向；any 无 source/target → 实体两两全连接（含自环），
    // 且每对实体之间 out/in 两个方向都挂（App→Host = runs-out + any-out + any-in）
    expect(mapped.adjacency_map.App.Host.map(e => e.edge_type)).toEqual(['runs', 'any', 'any'])
    expect(mapped.adjacency_map.App.Host[0]).toMatchObject({ edge_type: 'runs', direction: 'out' })
    expect(mapped.adjacency_map.Host.App[0]).toMatchObject({ edge_type: 'runs', direction: 'in' })
    // 「any」按 entities 数组顺序做笛卡尔积：Host→App 先挂 out，App→Host 的反向
    // in 紧随其后，再轮到 source=App 的那一轮 → App.Host = [runs-out, any-in, any-out]
    expect(mapped.adjacency_map.App.Host[1].direction).toBe('in')
    expect(mapped.adjacency_map.App.Host[2].direction).toBe('out')
    // 自环对：any 也会挂在 Host→Host / App→App 上
    expect(mapped.adjacency_map.Host.Host[0].edge_type).toBe('any')
    expect(mapped.adjacency_map.App.App[0].edge_type).toBe('any')
  })

  it('entities 是顶层数组 / 缺字段时逐级兜底，非数组降级为空并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 顶层数组：全是实体，无边
      const fromArray = mapSchemaToVisualizationData([{ entity_type: 'A' }])
      expect(Object.keys(fromArray.entity_meta)).toEqual(['A'])
      expect(fromArray.adjacency_map).toEqual({})

      // entity_list / edge_list / relations 备用字段名
      const fromAliases = mapSchemaToVisualizationData({
        entity_list: [{ entity_type: 'E1' }],
        relations: [{ edge_type: 'r' }]
      })
      expect(Object.keys(fromAliases.entity_meta)).toEqual(['E1'])
      expect(Object.keys(fromAliases.adjacency_map.E1)).toEqual(['E1'])

      // entities / edges 不是数组 → 空数组兜底
      const degraded = mapSchemaToVisualizationData({ entities: 'bad', edges: 7 })
      expect(degraded.entity_meta).toEqual({})
      expect(degraded.adjacency_map).toEqual({})
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('非法输入抛 Schema mapping failed；错误信息保留原始 message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => mapSchemaToVisualizationData(null)).toThrow('Schema mapping failed')
      expect(() => mapSchemaToVisualizationData(42)).toThrow(/must be an object/)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('自环边：source === target 时只挂一个方向，不建反向键', () => {
    const mapped = mapSchemaToVisualizationData({
      entities: [{ entity_type: 'X' }],
      edges: [{ edge_type: 'loop', source_entity: 'X', target_entity: 'X' }]
    })
    expect(mapped.adjacency_map.X.X).toHaveLength(1)
    expect(mapped.adjacency_map.X.X[0].direction).toBe('out')
  })
})

describe('schemaMapper：validateMappedData / 查询函数', () => {
  const mapped = mapSchemaToVisualizationData({
    entities: [{ entity_type: 'Host', properties: [{ name: 'ip' }] }],
    edges: [{ edge_type: 'runs', source_entity: 'App', target_entity: 'Host' }]
  })

  it('validateMappedData：合法结构 true，缺 entity_meta/adjacency_map/字段 false', () => {
    expect(validateMappedData(mapped)).toBe(true)
    expect(validateMappedData(null)).toBe(false)
    expect(validateMappedData({})).toBe(false)
    expect(validateMappedData({ entity_meta: {} })).toBe(false)
    expect(validateMappedData({ entity_meta: {}, adjacency_map: {} })).toBe(true)
    // entity 缺 entity_desc 字段 → false
    expect(validateMappedData({
      entity_meta: { Host: { properties: [] } },
      adjacency_map: {}
    })).toBe(false)
    // entity.properties 不是数组 → false
    expect(validateMappedData({
      entity_meta: { Host: { entity_desc: '', properties: 'x' } },
      adjacency_map: {}
    })).toBe(false)
    // 邻接表叶子不是数组 → false
    expect(validateMappedData({
      entity_meta: {},
      adjacency_map: { A: { B: 'nope' } }
    })).toBe(false)
  })

  it('getEntityTypes / getEntityProperties / getEntityRelations 各自兜底空值', () => {
    expect(getEntityTypes(mapped)).toEqual(['Host'])
    expect(getEntityTypes(null)).toEqual([])
    expect(getEntityProperties(mapped, 'Host')).toEqual([{ name: 'ip' }])
    expect(getEntityProperties(mapped, 'Ghost')).toEqual([])
    expect(getEntityProperties(null, 'Host')).toEqual([])
    expect(getEntityRelations(mapped, 'App')).toEqual({ Host: mapped.adjacency_map.App.Host })
    expect(getEntityRelations(mapped, 'Ghost')).toEqual({})
  })

  it('hasRelation / getEdgeTypes：无关系时 false / 空数组', () => {
    expect(hasRelation(mapped, 'App', 'Host')).toBe(true)
    // 源实体存在但目标不存在时返回 undefined（`x && x.length > 0` 的短路），按
    // 布尔语义消费方不受影响 —— 钉 truthiness，不改 src 的这个返回值
    expect(hasRelation(mapped, 'App', 'Ghost')).toBeFalsy()
    expect(hasRelation(mapped, 'Ghost', 'Host')).toBe(false)
    expect(hasRelation(null, 'App', 'Host')).toBe(false)
    expect(getEdgeTypes(mapped, 'App', 'Host')).toEqual(['runs'])
    expect(getEdgeTypes(mapped, 'App', 'Ghost')).toEqual([])
  })

  it('processSchemaInfo：映射 + 校验，校验失败抛错', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ok = processSchemaInfo({
        entities: [{ entity_type: 'A' }],
        edges: [{ edge_type: 'r', source_entity: 'A', target_entity: 'A' }]
      })
      expect(ok.entity_meta.A).toBeTruthy()

      // 空对象映射出两张空表，校验对「空 map」是放行的（没有条目就没有坏条目）
      const empty = processSchemaInfo({})
      expect(empty).toEqual({ entity_meta: {}, adjacency_map: {} })

      // 真正会抛的只有映射本身失败（非对象输入）
      expect(() => processSchemaInfo(undefined)).toThrow(/Schema mapping failed/)
    } finally {
      spy.mockRestore()
    }
  })

  it('validateSchemaInfo：空数据 / 缺 entities / 缺 edges / 缺类型字段', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(validateSchemaInfo(null).valid).toBe(false)
      expect(validateSchemaInfo(null).errors.length).toBeGreaterThan(0)

      const missingBoth = validateSchemaInfo({})
      expect(missingBoth.valid).toBe(false)
      expect(missingBoth.errors).toHaveLength(2)

      const sloppy = validateSchemaInfo({
        entities: [{ entity_desc: 'x' }],
        edges: [{ edge_desc: 'y' }]
      })
      expect(sloppy.valid).toBe(false)
      // 两个 error：实体缺 entity_type、边缺 edge_type；warning 只有实体的 properties
      expect(sloppy.errors).toHaveLength(2)
      expect(sloppy.warnings).toHaveLength(1)

      const good = validateSchemaInfo({
        entities: [{ entity_type: 'A', properties: [] }],
        edges: [{ edge_type: 'r' }]
      })
      expect(good).toEqual({ valid: true, errors: [], warnings: [] })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('default 导出与命名导出同源', () => {
    expect(defaultSchemaMapper.mapSchemaToVisualizationData).toBe(mapSchemaToVisualizationData)
    expect(defaultSchemaMapper.validateSchemaInfo).toBe(validateSchemaInfo)
  })
})

describe('useRowDrop（表格行拖拽重排）', () => {
  it('tbody 存在时交给 Sortable，onEnd 按新旧索引重排 tableData', () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'el-table__body-wrapper'
    const tbody = document.createElement('tbody')
    wrapper.appendChild(tbody)
    document.body.appendChild(wrapper)

    const tableData = ['a', 'b', 'c']
    const { rowDrop } = useRowDrop(tableData)
    rowDrop()

    expect(Sortable.create).toHaveBeenCalledTimes(1)
    const [el, options] = Sortable.create.mock.calls[0]
    expect(el).toBe(tbody)
    expect(options.handle).toBe('.btn-drag')
    expect(options.draggable).toBe('.el-table__row')
    expect(options.animation).toBe(500)

    options.onEnd({ oldIndex: 2, newIndex: 0 })
    expect(tableData).toEqual(['c', 'a', 'b'])
  })

  it('页面上没有表格时也不炸（Sortable.create 收到 null）', () => {
    document.body.innerHTML = ''
    const tableData = [1, 2]
    const { rowDrop } = useRowDrop(tableData)
    expect(() => rowDrop()).not.toThrow()
    expect(Sortable.create).toHaveBeenLastCalledWith(null, expect.any(Object))
    expect(tableData).toEqual([1, 2])
  })
})

describe('chat/lib/errors：错误 → 用户可见文案', () => {
  it('errText：falsy 回落 / 字符串直通 / detail > message > title 优先级', () => {
    expect(errText(null, '兜底')).toBe('兜底')
    expect(errText(undefined, '兜底')).toBe('兜底')
    expect(errText('直接是文案', '兜底')).toBe('直接是文案')
    expect(errText({ detail: '服务端 detail' }, '兜底')).toBe('服务端 detail')
    expect(errText({ detail: '', message: '错误消息' }, '兜底')).toBe('错误消息')
    expect(errText({ detail: 7, message: '', title: '标题' }, '兜底')).toBe('标题')
    expect(errText({}, '兜底')).toBe('兜底')
    expect(errText({ detail: null, message: 3, title: '' }, '兜底')).toBe('兜底')
  })

  it('streamErrorMessage：流内 error 事件优先于预流 envelope', () => {
    const result = {
      ok: false,
      status: 502,
      errorEnvelope: { detail: 'envelope 文案' },
      errorEvent: { detail: '事件文案' }
    }
    expect(streamErrorMessage(result, '兜底')).toBe('事件文案')
  })

  it('published_workflow_not_found：有名称时带上名称，没有时用通用术语', () => {
    const result = { status: 400, errorEnvelope: { code: 'published_workflow_not_found', detail: 'RAG_Workflow_x' } }
    expect(streamErrorMessage(result, '兜底', { workflowName: '我的检索' }))
      .toBe('知识检索「我的检索」还没有已发布的版本，请先在画布上保存并发布。')
    expect(streamErrorMessage(result, '兜底'))
      .toBe('所选知识检索还没有已发布的版本，请先在画布上保存并发布。')
  })

  it('两种失败形状都没有时回落 fallback + HTTP 状态后缀', () => {
    expect(streamErrorMessage({ ok: false, status: 502 }, '请求失败')).toBe('请求失败（HTTP 502）')
    expect(streamErrorMessage(null, '请求失败')).toBe('请求失败（HTTP —）')
    expect(streamErrorMessage(undefined, '请求失败')).toBe('请求失败（HTTP —）')
  })

  it('problem 只有 title 时直接用 title（不加状态后缀）', () => {
    expect(streamErrorMessage({ status: 404, errorEnvelope: { title: 'Not Found' } }, '兜底'))
      .toBe('Not Found')
  })

  it('problem 完全没有可读文案（detail/message/title 都缺）→ fallback + 状态后缀', () => {
    expect(streamErrorMessage({ status: 404, errorEnvelope: { code: 'x' } }, '兜底'))
      .toBe('兜底（HTTP 404）')
  })
})

describe('nodeFactory/schemaMapper 冒烟（保证两个 0% 文件真的被 import 过）', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
  })

  it('两个模块的导出形状齐全', () => {
    expect(typeof registerCustomNodes).toBe('function')
    expect(typeof getGraphPalette).toBe('function')
    expect(typeof validateMappedData).toBe('function')
  })

  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })
})
