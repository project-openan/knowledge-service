// @vitest-environment jsdom
/**
 * graph 下剩余 0% 的纯逻辑文件一次性补齐：
 * - composables/useFileUpload.js —— 文件上传状态机（新上传/已存在两份列表 + 批次提示、
 *   zedx 拦截、MB 换算、删除归类到 deletedFiles、恢复、过期响应丢弃、上限加载）；
 * - composables/useKnowledgeGraphBuild.js —— canBuild 的逐项闸门（纯 computed）；
 * - composables/useOperatorValidation.js —— 算子校验：列表排序、validateOperator 的
 *   命中/未命中/过期回调/异常四条出口、schemaId/llm/数值参数的默认值推导；
 * - lib/schemaMapper.js —— schema → 可视化映射（entity_meta / adjacency_map 双向边、
 *   无 source/target 的通配展开）、mapped 数据校验与查询函数、validateSchemaInfo；
 * - lib/nodeFactory.ts —— 主题调色板（亮/暗）、节点默认属性、原位重绘主题。
 *
 * 这些文件互相独立、无 DOM/X6 依赖（nodeFactory 只读 CSS 变量），直接函数级驱动。
 */
import { vi } from 'vitest'
import { ref, computed, reactive } from 'vue'

const { fileApi, messageMock } = vi.hoisted(() => ({
  fileApi: {
    getKbaseFileLimitApi: vi.fn(),
    getKnowledgeGraphFileListApi: vi.fn()
  },
  messageMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}))

vi.mock('@/shared/lib/message', () => ({ default: messageMock }))
vi.mock('@/features/graph/api/knowledgeGraph', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    // 全部包成 spy：组合逻辑层要直接编排这些 mock 的返回值
    getKbaseFileLimitApi: vi.fn((...args) => fileApi.getKbaseFileLimitApi(...args)),
    getKnowledgeGraphFileListApi: vi.fn((...args) => fileApi.getKnowledgeGraphFileListApi(...args)),
    getOperatorListApi: vi.fn((...args) => actual.getOperatorListApi(...args)),
    getLlmListApi: vi.fn((...args) => actual.getLlmListApi(...args)),
    knowledgeGraphTemplateListApi: vi.fn((...args) => actual.knowledgeGraphTemplateListApi(...args))
  }
})

import { flush } from './helpers/mount'
import { useFileUpload } from '@/features/graph/composables/useFileUpload'
import { useKnowledgeGraphBuild } from '@/features/graph/composables/useKnowledgeGraphBuild'
import { useOperatorValidation } from '@/features/graph/composables/useOperatorValidation'
import {
  mapSchemaToVisualizationData,
  validateMappedData,
  getEntityTypes,
  getEntityProperties,
  getEntityRelations,
  hasRelation,
  getEdgeTypes,
  processSchemaInfo,
  validateSchemaInfo
} from '@/features/graph/lib/schemaMapper'
import { getGraphPalette, isDarkGraphTheme, applyNodeTheme, getNodeDefaultProperties } from '@/features/graph/lib/nodeFactory'

const proxy = { $t: key => key }

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('useFileUpload', () => {
  function setup ({ limit = { maxSizeMap: { pdf: 1, docx: 2, ZEDX: 9 }, number: 2 } } = {}) {
    const upload = useFileUpload()
    fileApi.getKbaseFileLimitApi.mockResolvedValue(limit)
    return upload
  }

  it('loadFileLimit：maxSizeMap+number 才落位；缺字段 / 异常置空', async () => {
    const upload = setup()
    await upload.loadFileLimit()
    expect(upload.fileLimit.value).toEqual({ maxSizeMap: { pdf: 1, docx: 2, ZEDX: 9 }, number: 2 })
    expect(upload.acceptAttr.value).toBe('.pdf,.docx') // zedx 被剔除

    fileApi.getKbaseFileLimitApi.mockResolvedValue({ maxSizeMap: { pdf: 1 } })
    await upload.loadFileLimit()
    expect(upload.fileLimit.value).toBeNull()

    fileApi.getKbaseFileLimitApi.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await upload.loadFileLimit()
    expect(upload.fileLimit.value).toBeNull()
    expect(upload.acceptAttr.value).toBe('.pdf,.doc,.docx,.txt,.md,.xlsx,.xls,.csv')
    error.mockRestore()
  })

  it('loadExistingFiles：items 映射 + 剩余清单；空列表清空；过期响应丢弃；异常吞掉', async () => {
    const upload = setup()
    fileApi.getKnowledgeGraphFileListApi.mockResolvedValue({
      items: [{ id: 'f1', title: '旧文件', fileSize: 10, fileFrom: '2' }]
    })
    await upload.loadExistingFiles('kb1')
    expect(fileApi.getKnowledgeGraphFileListApi).toHaveBeenCalledWith('kb1', expect.objectContaining({ kbaseId: 'kb1', pageSize: 50 }))
    expect(upload.existingFiles.value).toEqual([{ id: 'f1', title: '旧文件', fileSize: 10, fileFrom: '2', isUploaded: false }])
    expect(upload.remainingFiles.value).toEqual(['f1'])

    // 空图谱：清空 + 警告（响应没有 items 字段）
    fileApi.getKnowledgeGraphFileListApi.mockResolvedValue({ data: 'weird' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await upload.loadExistingFiles('kb1')
    expect(upload.existingFiles.value).toEqual([])
    expect(upload.remainingFiles.value).toEqual([])
    expect(warn).toHaveBeenCalled()

    // 过期响应：isCurrent 为假直接丢弃
    fileApi.getKnowledgeGraphFileListApi.mockResolvedValue({ items: [{ id: 'f2', title: 'x', fileSize: 1, fileFrom: '1' }] })
    await upload.loadExistingFiles('kb1', () => false)
    expect(upload.existingFiles.value).toEqual([])

    fileApi.getKnowledgeGraphFileListApi.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await upload.loadExistingFiles('kb1')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    warn.mockRestore()
  })

  it('handleFileChange：zedx 拦截 / 超限拒绝 / 数量批次一次提示 / 成功入列', async () => {
    const upload = setup()
    await upload.loadFileLimit()

    upload.handleFileChange({ name: '扫描.zedx', size: 1 }, proxy)
    expect(upload.uploadedFiles.value).toHaveLength(0)
    expect(messageMock.error).toHaveBeenCalledTimes(1)

    upload.handleFileChange({ name: '大.pdf', size: 5 * 1024 * 1024 }, proxy) // 上限 1MB
    expect(upload.uploadedFiles.value).toHaveLength(0)
    expect(messageMock.error).toHaveBeenCalledTimes(2)

    // 第 1、2 个成功；第 3 个（同批次）提示一次；第 4 个不再提示
    upload.handleFileChange({ name: 'a.pdf', size: 100, raw: {} }, proxy)
    upload.handleFileChange({ name: 'b.docx', size: 100, raw: {} }, proxy)
    expect(upload.uploadedFiles.value.map(f => f.title)).toEqual(['a.pdf', 'b.docx'])
    upload.handleFileChange({ name: 'c.pdf', size: 100, raw: {} }, proxy)
    expect(messageMock.error).toHaveBeenCalledTimes(3)
    upload.handleFileChange({ name: 'd.pdf', size: 100, raw: {} }, proxy)
    expect(messageMock.error).toHaveBeenCalledTimes(3)
    expect(upload.uploadedFiles.value).toHaveLength(2)
    expect(upload.uploadedFiles.value[0]).toEqual({ title: 'a.pdf', fileSize: 100, raw: {}, isUploaded: true })
  })

  it('removeFile：新上传的移出列表，已存在的进 deletedFiles 并移出 remaining', async () => {
    const upload = setup()
    upload.uploadedFiles.value.push({ title: '新.pdf', fileSize: 1, raw: {}, isUploaded: true })
    upload.existingFiles.value.push({ id: 'f1', title: '旧.pdf', fileSize: 2, isUploaded: false })
    upload.remainingFiles.value.push('f1')

    upload.removeFile(1) // 已存在文件（allFiles 顺序：新上传在前）
    expect(upload.existingFiles.value).toHaveLength(0)
    expect(upload.deletedFiles.value).toEqual(['f1'])
    expect(upload.remainingFiles.value).toEqual([])

    upload.removeFile(0) // 新上传
    expect(upload.uploadedFiles.value).toHaveLength(0)
    expect(upload.allFiles.value).toHaveLength(0)
  })

  it('restoreFile：已存在不重复恢复；恢复后回填三份列表', async () => {
    const upload = setup()
    const file = { id: 'f1', title: '旧.pdf', fileSize: 2, isUploaded: false }
    upload.restoreFile(file) // 不在 existing 里也直接入列
    expect(upload.existingFiles.value).toEqual([file])
    upload.restoreFile({ id: 'f1' }) // 重复恢复被忽略
    expect(upload.existingFiles.value).toHaveLength(1)

    upload.removeFile(0)
    expect(upload.deletedFiles.value).toEqual(['f1'])
    upload.restoreFile(file)
    expect(upload.deletedFiles.value).toEqual([])
    expect(upload.remainingFiles.value).toEqual(['f1'])
    expect(upload.restoreFile(null)).toBeUndefined()
  })

  it('allFiles 合并视图：新上传标 isUploaded/fileFrom=1', () => {
    const upload = useFileUpload()
    upload.uploadedFiles.value.push({ title: 'a', fileSize: 1 })
    upload.existingFiles.value.push({ id: 'f1', title: 'b' })
    expect(upload.allFiles.value).toEqual([
      { title: 'a', fileSize: 1, isUploaded: true, fileFrom: '1' },
      { id: 'f1', title: 'b', isUploaded: false }
    ])
    expect(upload.formatFileSize(0)).toBe('0 MB')
    expect(upload.formatFileSize(1024 * 1024 * 2)).toBe('2.00')
  })
})

describe('useKnowledgeGraphBuild', () => {
  function build ({ operatorNotFound = false, templateNotFound = false, form = {}, files = 1, operator = 'op', args = [], params = {} } = {}) {
    return useKnowledgeGraphBuild(
      reactive(form),
      reactive({ config: { operator } }),
      ref(operatorNotFound),
      ref(templateNotFound),
      ref(files ? [{ id: 1 }] : []),
      computed(() => args),
      params
    )
  }

  it('闸门逐项生效：算子/模版缺失、名称、模型、文件、算子、参数', () => {
    expect(build().canBuild.value).toBe(false) // 没名称
    expect(build({ form: { name: '  ' } }).canBuild.value).toBe(false) // 纯空格
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' } }).canBuild.value).toBe(true) // 基本齐了
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, files: 0 }).canBuild.value).toBe(false) // 没文件
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, operator: '' }).canBuild.value).toBe(false)
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, operatorNotFound: true }).canBuild.value).toBe(false)
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, templateNotFound: true }).canBuild.value).toBe(false)

    // 算子无 args：选上即可构建
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' } }).canBuild.value).toBe(true)

    // 有 args：全部参数非空才放行
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, args: [{ argName: 'llm' }], params: { llm: '' } }).canBuild.value).toBe(false)
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, args: [{ argName: 'llm' }, { argName: 'k' }], params: { llm: 'x', k: 0 } }).canBuild.value).toBe(true)
    expect(build({ form: { name: '图谱', embeddingModel: 'bge' }, args: [{ argName: 'k' }], params: { k: null } }).canBuild.value).toBe(false)
  })
})

describe('useOperatorValidation', () => {
  const OPERATORS = [
    { id: 1, name: '通用', args: [
      { argName: 'schemaId', defaultValue: '' },
      { argName: 'llm', defaultValue: 'local-llm' },
      { argName: 'overlap', defaultValue: '64' },
      { argName: 'windowSize', type: 'number', defaultValue: '7' }
    ] },
    { id: 2, name: '裸', args: [] }
  ]

  async function validated ({ operators = OPERATORS, schemaInfo, isCurrent } = {}) {
    const v = useOperatorValidation()
    fileApi.getKbaseFileLimitApi.mockResolvedValue(null)
    const { getOperatorListApi, getLlmListApi, knowledgeGraphTemplateListApi } = await import('@/features/graph/api/knowledgeGraph')
    vi.mocked(getOperatorListApi).mockResolvedValue(operators)
    vi.mocked(getLlmListApi).mockResolvedValue([{ value: 'gpt-x', id: 'gpt-id' }])
    vi.mocked(knowledgeGraphTemplateListApi).mockResolvedValue([{ schemaId: 'tpl-1' }])
    await v.validateOperator(1, schemaInfo, isCurrent)
    await flush()
    return v
  }

  it('命中算子：currentOperator / dynamicParams.operatorId / 参数默认值按规则推导', async () => {
    const v = await validated({ schemaInfo: { schema_name: '影视模版', schema_id: 'tpl-9' } })
    expect(v.currentOperator.value.id).toBe(1)
    expect(v.operatorNotFound.value).toBe(false)
    expect(v.templateNotFound.value).toBe(false)
    expect(v.dynamicParams).toMatchObject({
      operatorId: '1',
      schemaId: 'tpl-9', // schemaInfo 命中 → 回填模版 id
      llm: 'gpt-x', // loadRelatedData 加载完大模型列表后回填第一项
      overlap: 64, // overlap/chunkSize 转数字
      windowSize: 7 // number 类型转 Number
    })
    // loadRelatedData：schemaId → 模版列表；llm → 大模型列表 + 回填第一项
    expect(v.templateList.value).toEqual([{ schemaId: 'tpl-1' }])
    expect(v.llmModelList.value).toEqual([{ value: 'gpt-x', id: 'gpt-id' }])

    // 参数排序：schemaId → llm → overlap → chunkSize → 其他
    expect(v.operatorArgs.value.map(a => a.argName)).toEqual(['schemaId', 'llm', 'overlap', 'windowSize'])
    expect(v.selectedOperator.value.id).toBe(1)
  })

  it('schemaInfo 无模版名：templateNotFound 置位且 schemaId 清空', async () => {
    const v = await validated({ schemaInfo: { schema_id: 'tpl-9' } })
    expect(v.templateNotFound.value).toBe(true)
    expect(v.dynamicParams.schemaId).toBe('')
  })

  it('算子不存在 / 列表接口异常：setOperatorNotFound 兜底', async () => {
    const { getOperatorListApi } = await import('@/features/graph/api/knowledgeGraph')
    const v = await validated({ operators: [{ id: 9, name: '别的', args: [] }] })
    expect(v.operatorNotFound.value).toBe(true)
    expect(v.currentOperator.value).toBeNull()
    expect(v.dynamicParams.operatorId).toBe('')

    vi.mocked(getOperatorListApi).mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await v.validateOperator(1)
    expect(v.operatorNotFound.value).toBe(true)
    error.mockRestore()
  })

  it('isCurrent 回调为假：列表加载后直接返回，不写状态', async () => {
    const v = await validated({ isCurrent: () => false })
    expect(v.operatorList.value).toHaveLength(2) // 列表还是加载了
    expect(v.currentOperator.value).toBeNull()
    expect(v.operatorNotFound.value).toBe(false)
  })

  it('模版 / 大模型列表接口失败：console 留痕、列表置空', async () => {
    const { getLlmListApi, knowledgeGraphTemplateListApi } = await import('@/features/graph/api/knowledgeGraph')
    vi.mocked(getLlmListApi).mockRejectedValue(new Error('x'))
    vi.mocked(knowledgeGraphTemplateListApi).mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = useOperatorValidation()
    await v.loadLLMModels()
    await v.loadTemplateList()
    expect(v.llmModelList.value).toEqual([])
    expect(v.templateList.value).toEqual([])
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('processOtherArg：非数字参数原样落位（含空 defaultValue）', async () => {
    const { getOperatorListApi } = await import('@/features/graph/api/knowledgeGraph')
    vi.mocked(getOperatorListApi).mockResolvedValue([{ id: 3, name: 'x', args: [{ argName: 'custom', defaultValue: null }] }])
    const v = useOperatorValidation()
    await v.validateOperator(3)
    expect(v.dynamicParams.custom).toBe('')
  })
})

describe('schemaMapper', () => {
  const SCHEMA = {
    entities: [
      { entity_type: 'Scene', entity_desc: '场景', properties: [{ name: 'name', type: 'STRING', desc: '名称' }] },
      { entity_type: 'Character', entity_desc: '', properties: [] }
    ],
    edges: [
      { edge_type: 'Relates', edge_desc: '关联', source_entity: 'Scene', target_entity: 'Character', properties: [{ name: 'since' }] },
      { edge_type: 'SelfLoop', source_entity: 'Scene', target_entity: 'Scene', properties: [] }
    ]
  }

  it('processSchemaInfo：entity_meta / adjacency_map（双向边 out/in，自闭环只挂自身）', () => {
    const mapped = processSchemaInfo(SCHEMA)
    expect(Object.keys(mapped.entity_meta)).toEqual(['Scene', 'Character'])
    expect(mapped.entity_meta.Scene).toEqual({ entity_desc: '场景', properties: SCHEMA.entities[0].properties })
    // Scene→Character：正向 out；反向 in；自闭环只在 Scene 自身
    expect(mapped.adjacency_map.Scene.Character).toHaveLength(1)
    expect(mapped.adjacency_map.Scene.Character[0]).toMatchObject({ edge_type: 'Relates', direction: 'out' })
    expect(mapped.adjacency_map.Character.Scene[0]).toMatchObject({ edge_type: 'Relates', direction: 'in' })
    expect(mapped.adjacency_map.Scene.Scene).toHaveLength(1)
    expect(mapped.adjacency_map.Scene.Scene[0]).toMatchObject({ edge_type: 'SelfLoop', direction: 'out' })
    expect(mapped.adjacency_map.Character).not.toHaveProperty('Character')

    expect(validateMappedData(mapped)).toBe(true)
    expect(getEntityTypes(mapped)).toEqual(['Scene', 'Character'])
    expect(getEntityProperties(mapped, 'Scene')).toEqual(SCHEMA.entities[0].properties)
    expect(getEntityProperties(mapped, 'nope')).toEqual([])
    expect(getEntityRelations(mapped, 'Scene')).toBe(mapped.adjacency_map.Scene)
    expect(getEntityRelations(mapped, 'nope')).toEqual({})
    expect(hasRelation(mapped, 'Scene', 'Character')).toBe(true)
    expect(hasRelation(mapped, 'Character', 'Character')).toBeFalsy() // 无关系时返回 undefined（真值判定兜住）
    expect(getEdgeTypes(mapped, 'Scene', 'Character')).toEqual(['Relates'])
  })

  it('mapSchemaToVisualizationData：数组形态 / 备选字段名 / 非数组兜底 / 非对象抛错', () => {
    expect(mapSchemaToVisualizationData(SCHEMA.entities)).toEqual({ entity_meta: expect.any(Object), adjacency_map: expect.any(Object) })
    const alt = mapSchemaToVisualizationData({ entity_list: SCHEMA.entities, edge_list: SCHEMA.edges })
    expect(Object.keys(alt.entity_meta)).toEqual(['Scene', 'Character'])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fallback = mapSchemaToVisualizationData({ entities: 'not-array', edges: null })
    expect(fallback.entity_meta).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => mapSchemaToVisualizationData(null)).toThrow('Schema mapping failed')
    expect(() => mapSchemaToVisualizationData('str')).toThrow('Schema mapping failed')
    error.mockRestore()
  })

  it('validateMappedData：结构不合规返回 false', () => {
    expect(validateMappedData(null)).toBe(false)
    expect(validateMappedData({})).toBe(false)
    expect(validateMappedData({ entity_meta: {}, adjacency_map: {} })).toBe(true)
    expect(validateMappedData({ entity_meta: { S: {} }, adjacency_map: {} })).toBe(false) // 缺 entity_desc
    expect(validateMappedData({ entity_meta: { S: { entity_desc: '', properties: 'x' } }, adjacency_map: {} })).toBe(false)
    expect(validateMappedData({ entity_meta: {}, adjacency_map: { S: 'x' } })).toBe(false)
    expect(validateMappedData({ entity_meta: {}, adjacency_map: { S: { T: 'x' } } })).toBe(false)
  })

  it('validateSchemaInfo：空对象 / 缺数组 / 缺类型各有错误；properties 缺失只警告', () => {
    expect(validateSchemaInfo(null).valid).toBe(false)
    const missing = validateSchemaInfo({})
    expect(missing.valid).toBe(false)
    expect(missing.errors).toHaveLength(2)

    const badEntity = validateSchemaInfo({ entities: [{ properties: [] }], edges: [{ edge_type: 'R' }] })
    expect(badEntity.valid).toBe(false)
    expect(badEntity.warnings).toHaveLength(0)

    const warningsOnly = validateSchemaInfo({ entities: [{ entity_type: 'S' }], edges: [{ edge_type: 'R' }, {}] })
    expect(warningsOnly.valid).toBe(false) // 缺 edge_type 的边产生错误
    expect(warningsOnly.warnings).toHaveLength(1)
  })
})

describe('nodeFactory（纯逻辑部分）', () => {
  it('isDarkGraphTheme / getGraphPalette：亮色返回浅色盘，暗色读 CSS 变量', () => {
    expect(isDarkGraphTheme()).toBe(false)
    const light = getGraphPalette()
    expect(light.templateEdgeStroke).toBe('#0077FF')
    expect(light.nodeFill).toBeTruthy()

    document.documentElement.classList.add('dark')
    expect(isDarkGraphTheme()).toBe(true)
    const dark = getGraphPalette()
    expect(dark.nodeFill).toBe('#13161c') // CSS 变量缺失时的回退值
    expect(dark.nodeShadow).toBe('rgba(0, 0, 0, 0.45)')
  })

  it('applyNodeTheme：原位重绘节点与端口（无 id 的端口跳过）', () => {
    const portProp = vi.fn()
    const node = {
      attr: vi.fn(),
      getPorts: () => [{ id: 'p1' }, {}],
      portProp
    }
    applyNodeTheme(node, getGraphPalette())
    expect(node.attr).toHaveBeenCalledWith('body/fill', expect.any(String))
    expect(node.attr).toHaveBeenCalledWith('label/fill', expect.any(String))
    expect(portProp).toHaveBeenCalledTimes(2)
    expect(portProp).toHaveBeenCalledWith('p1', 'attrs/circle/stroke', expect.any(String))

    // 默认调色板参数：不传 palette 也能工作
    applyNodeTheme(node)
    expect(node.attr).toHaveBeenCalledTimes(4)
  })

  it('getNodeDefaultProperties：内置类型给默认名，未知类型回退为类型名', () => {
    expect(getNodeDefaultProperties('entity')).toEqual({ name: 'Entity', description: '', attributes: [] })
    expect(getNodeDefaultProperties('examItem')).toEqual({ name: 'ExamItem', description: '', attributes: [] })
    const fault = getNodeDefaultProperties('fault')
    expect(fault.name).not.toContain('modules.kbWorkspace.') // 真词条
    expect(fault.attributes).toEqual([])
    expect(getNodeDefaultProperties('unknown-type')).toEqual({ name: 'unknown-type', description: '', attributes: [] })
  })
})
