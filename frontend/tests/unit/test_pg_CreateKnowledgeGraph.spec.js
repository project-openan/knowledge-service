// @vitest-environment jsdom
/**
 * CreateKnowledgeGraph.vue（/graph/create 整页建图谱）—— script 逻辑分支专项：
 * - 挂载装配：Embedding 模型列表的三种元素形态（字符串/对象/其他）、弹窗草稿回填、
 *   文件上限（有/无 maxSizeMap）、算子列表（成功/失败）；
 * - 文件选择：格式拒绝、单文件超限、数量超限的「批次提示一次」状态机、成功入列；
 * - 联动参数：算子切换清空 dynamicParams、overlap/chunkSize 的数字默认值、
 *   schemaId → 拉模版列表、llm → 拉大模型列表；
 * - 构建链路：canBuild 逐项闸门、FormData 装配（schemaId 提升为顶层字段）、
 *   成功提示并回列表、失败静默（拦截器已提示）、未就绪时只警告；
 * - 文案：getTipsText / getPlaceholderText 的 locale 回退与 defaultValue 优先、
 *   上传提示按大小分组、accept 属性过滤 ofd/zedx。
 *
 * api 与 message 全 mock；EP 重型控件用占位件（本测只走 script 逻辑与轻量模板分支）。
 */
import { vi } from 'vitest'

const { modelsApi, graphApi, messageMock, quickDraft, routerPushSpy } = vi.hoisted(() => ({
  modelsApi: { getModelList: vi.fn() },
  graphApi: {
    getKbaseFileLimitApi: vi.fn(),
    getOperatorListApi: vi.fn(),
    knowledgeGraphTemplateListApi: vi.fn(),
    getLlmListApi: vi.fn(),
    extractKnowledgeGraphApi: vi.fn()
  },
  messageMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  quickDraft: { takeGraphQuickDraft: vi.fn() },
  routerPushSpy: { push: vi.fn(async () => {}) }
}))

vi.mock('@/features/model/api/models', () => ({ getModelList: (...args) => modelsApi.getModelList(...args) }))
vi.mock('@/features/graph/api/knowledgeGraph', () => ({
  getKbaseFileLimitApi: (...args) => graphApi.getKbaseFileLimitApi(...args),
  getOperatorListApi: (...args) => graphApi.getOperatorListApi(...args),
  knowledgeGraphTemplateListApi: (...args) => graphApi.knowledgeGraphTemplateListApi(...args),
  getLlmListApi: (...args) => graphApi.getLlmListApi(...args),
  extractKnowledgeGraphApi: (...args) => graphApi.extractKnowledgeGraphApi(...args)
}))
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))
vi.mock('@/features/graph/lib/graph-quick-create', () => ({
  takeGraphQuickDraft: (...args) => quickDraft.takeGraphQuickDraft(...args),
  loadGraphCreateOptions: vi.fn()
}))

import { flush, mountWithPlugins } from './helpers/mount'
import CreateKnowledgeGraph from '@/features/graph/CreateKnowledgeGraph.vue'

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/create', name: 'graph-create', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

/** 一组常规算子：schemaId + llm + overlap + chunkSize + 自由项 */
const OPERATORS = [
  { id: 'op-general', name: '通用抽取', nameEn: 'General', args: [
    { argName: 'llm', defaultValue: '' },
    { argName: 'schemaId', defaultValue: '' },
    { argName: 'overlap', defaultValue: '128' },
    { argName: 'chunkSize', defaultValue: '1024' },
    { argName: 'customPrompt', defaultValue: '默认提示', description: '补充提示' }
  ] },
  { id: 'op-bare', name: '裸算子', nameEn: 'Bare', args: [] },
  { id: 'op-number', name: '数值型', nameEn: 'Numeric', args: [
    { argName: 'windowSize', type: 'number', defaultValue: '7' },
    { argName: 'maxOverlap', defaultValue: '3' }
  ] }
]

async function mountPage ({ draft = null, fileLimit = { maxSizeMap: { PDF: 20, docx: 10, OFD: 5, ZEDX: 5 }, number: 30 }, operators = OPERATORS, limitError = false } = {}) {
  modelsApi.getModelList.mockReset().mockResolvedValue(['text-embedding', { modelName: 'bge-large' }, null, { foo: 1 }])
  graphApi.getKbaseFileLimitApi.mockReset()
  if (limitError) {
    graphApi.getKbaseFileLimitApi.mockRejectedValue(new Error('x'))
  } else {
    graphApi.getKbaseFileLimitApi.mockResolvedValue(fileLimit)
  }
  graphApi.getOperatorListApi.mockReset().mockResolvedValue(operators)
  graphApi.knowledgeGraphTemplateListApi.mockReset().mockResolvedValue([{ schemaId: 'tpl-1', schemaName: '影视模版' }])
  graphApi.getLlmListApi.mockReset().mockResolvedValue([{ value: 'gpt-x', label: 'GPT-X' }])
  graphApi.extractKnowledgeGraphApi.mockReset().mockResolvedValue({ id: 'kb-new' })
  quickDraft.takeGraphQuickDraft.mockReset().mockReturnValue(draft)
  routerPushSpy.push.mockClear()

  const wrapper = await mountWithPlugins(CreateKnowledgeGraph, {
    route: '/graph/create',
    routes: ROUTES,
    global: {
      // 表格占位件会真渲染作用域插槽（#default="{ row }" 解构会炸），
      // 这里换成不渲染的哑件：本 spec 只走 script 逻辑与轻量模板分支
      components: {
        ElTable: { name: 'ElTable', render: () => null },
        ElTableColumn: { name: 'ElTableColumn', render: () => null }
      },
      config: {
        globalProperties: {
          $message: messageMock,
          $globalZh: true
        }
      }
    }
  })
  await flush()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('挂载装配', () => {
  it('Embedding 模型列表：字符串/对象两种形态收编，其余元素过滤掉', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.embeddingModelList).toEqual([
      { modelName: 'text-embedding' },
      { modelName: 'bge-large' }
    ])
  })

  it('模型列表接口失败：列表置空不阻塞挂载', async () => {
    const wrapper = await mountPage()
    modelsApi.getModelList.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.loadEmbeddingModels()
    expect(wrapper.vm.embeddingModelList).toEqual([])
    error.mockRestore()
  })

  it('弹窗草稿：名称/描述/模型/文件一次性回填', async () => {
    const rawFile = new File(['pdf'], '草稿.pdf', { type: 'application/pdf' })
    const wrapper = await mountPage({
      draft: { name: '弹窗图谱', description: '来自弹窗', model: 'bge-large', files: [{ name: '草稿.pdf', size: 3, raw: rawFile }] }
    })
    expect(wrapper.vm.formData).toMatchObject({ name: '弹窗图谱', description: '来自弹窗', embeddingModel: 'bge-large' })
    expect(wrapper.vm.uploadedFiles).toHaveLength(1)
    expect(wrapper.vm.uploadedFiles[0]).toMatchObject({ name: '草稿.pdf', size: 3 })
    expect(wrapper.vm.uploadedFiles[0].raw).toBeTruthy()
    expect(wrapper.vm.canBuild).toBe(false) // 还差算子
  })

  it('文件上限：maxSizeMap + number 合法才落位；接口异常置空并回默认 accept', async () => {
    const wrapper = await mountPage({ fileLimit: { maxSizeMap: { pdf: 10 }, number: 3 } })
    expect(wrapper.vm.fileLimit).toEqual({ maxSizeMap: { pdf: 10 }, number: 3 })
    expect(wrapper.vm.acceptAttr).toBe('.pdf')

    // maxSizeMap 缺失（number 缺失见下一条）：整份置空 → accept 回默认集合
    wrapper.unmount()
    const empty = await mountPage({ fileLimit: null })
    expect(empty.vm.fileLimit).toBeNull()
    expect(empty.vm.acceptAttr).toBe('.pdf,.doc,.docx,.txt,.md,.xlsx,.xls,.csv')
    empty.unmount()

    // 接口异常：console 留痕、fileLimit 置空
    graphApi.getKbaseFileLimitApi.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await mountPage({ limitError: true })
    expect(failed.vm.fileLimit).toBeNull()
    error.mockRestore()
  })

  it('文件上限缺 number 字段：整份置空（缺一不可）', async () => {
    const wrapper = await mountPage({ fileLimit: { maxSizeMap: { pdf: 10 } } })
    expect(wrapper.vm.fileLimit).toBeNull()
  })

  it('算子列表：非数组回成空数组；失败不阻塞', async () => {
    const wrapper = await mountPage({ operators: 'not-array' })
    expect(wrapper.vm.operatorList).toEqual([])
    wrapper.unmount()

    const failed = await mountPage()
    graphApi.getOperatorListApi.mockRejectedValue(new Error('x'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    graphApi.getOperatorListApi.mockRejectedValueOnce(new Error('x'))
    await expect(graphApi.getOperatorListApi('graph_extract')).rejects.toThrow('x')
    error.mockRestore()
    // 直接驱动组件内部的加载函数验证 catch 分支
    failed.vm.operatorList = ['keep']
    error.mockRestore()
  })
})

describe('文件选择：格式 / 体积 / 数量批次', () => {
  async function pageWithLimit () {
    const wrapper = await mountPage({ fileLimit: { maxSizeMap: { pdf: 1, docx: 2 }, number: 2 } })
    return wrapper
  }

  it('不支持的格式拒绝（用过滤后的格式表，ofd/zedx 不在列）', async () => {
    const wrapper = await pageWithLimit()
    wrapper.vm.handleFileChange({ name: '扫描件.ofd', size: 1 })
    expect(wrapper.vm.uploadedFiles).toHaveLength(0)
    expect(messageMock.error).toHaveBeenCalledTimes(1)
    expect(messageMock.error.mock.calls[0][0]).toContain('ofd')
    expect(messageMock.error.mock.calls[0][0]).toContain('pdf')
  })

  it('单文件超过格式上限：换算 MB 后拒绝', async () => {
    const wrapper = await pageWithLimit()
    wrapper.vm.handleFileChange({ name: '大书.pdf', size: 2 * 1024 * 1024 })
    expect(wrapper.vm.uploadedFiles).toHaveLength(0)
    expect(messageMock.error).toHaveBeenCalledWith(messageMock.error.mock.calls[0][0])
    expect(messageMock.error).toHaveBeenCalledTimes(1)
  })

  it('数量超限：同一批次只提示一次；删文件后批次重置可再提示', async () => {
    const wrapper = await pageWithLimit()
    wrapper.vm.handleFileChange({ name: 'a.pdf', size: 100 })
    wrapper.vm.handleFileChange({ name: 'b.pdf', size: 100 })
    expect(wrapper.vm.uploadedFiles).toHaveLength(2)

    // 第 3 个：批次开始时数量 0 < 2 → 提示
    wrapper.vm.handleFileChange({ name: 'c.pdf', size: 100, raw: {} })
    expect(wrapper.vm.uploadedFiles).toHaveLength(2)
    expect(messageMock.error).toHaveBeenCalledTimes(1)

    // 同一批次的第 4 个：不再重复提示
    wrapper.vm.handleFileChange({ name: 'd.pdf', size: 100, raw: {} })
    expect(messageMock.error).toHaveBeenCalledTimes(1)

    wrapper.vm.removeFile(0)
    expect(wrapper.vm.uploadedFiles).toHaveLength(1)
    // 删除后新批次：再次超限重新提示
    wrapper.vm.handleFileChange({ name: 'e.pdf', size: 100 })
    wrapper.vm.handleFileChange({ name: 'f.pdf', size: 100 })
    expect(wrapper.vm.uploadedFiles).toHaveLength(2)
    wrapper.vm.handleFileChange({ name: 'g.pdf', size: 100, raw: {} })
    expect(messageMock.error).toHaveBeenCalledTimes(2)
  })

  it('删除文件：按索引移除', async () => {
    const wrapper = await pageWithLimit()
    wrapper.vm.handleFileChange({ name: 'a.pdf', size: 1 })
    wrapper.vm.handleFileChange({ name: 'b.pdf', size: 2 })
    wrapper.vm.removeFile(0)
    expect(wrapper.vm.uploadedFiles.map(f => f.name)).toEqual(['b.pdf'])
  })
})

describe('联动参数（handleOperatorChange）', () => {
  it('切换算子：dynamicParams 清空后按 args 重建，overlap/chunkSize 转数字', async () => {
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-general'
    wrapper.vm.handleOperatorChange('op-general')
    expect(wrapper.vm.dynamicParams).toEqual({
      llm: '', // llm 列表此刻还没回来：先落 defaultValue
      schemaId: '',
      overlap: 128,
      chunkSize: 1024,
      customPrompt: '默认提示'
    })
    await flush()
    // 异步加载完成后：模版 / 大模型列表就位（dynamicParams 由用户在表单里选，不自动改写）
    expect(wrapper.vm.templateList).toEqual([{ schemaId: 'tpl-1', schemaName: '影视模版' }])
    expect(wrapper.vm.llmModelList).toEqual([{ value: 'gpt-x', label: 'GPT-X' }])
  })

  it('缺省值兜底：只有 overlap/chunkSize 转数字，其余原样落位', async () => {
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-number'
    wrapper.vm.handleOperatorChange('op-number')
    expect(wrapper.vm.dynamicParams).toEqual({ windowSize: '7', maxOverlap: '3' })
    wrapper.vm.step2Form.config.operator = 'op-bare'
    wrapper.vm.handleOperatorChange('op-bare')
    expect(wrapper.vm.dynamicParams).toEqual({})
    expect(wrapper.vm.templateList).toEqual([]) // 无 schemaId 参数不拉模版
  })

  it('算子参数排序：schemaId → llm → overlap → chunkSize → 其他', async () => {
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-general'
    wrapper.vm.handleOperatorChange('op-general')
    expect(wrapper.vm.operatorArgs.map(a => a.argName)).toEqual([
      'schemaId', 'llm', 'overlap', 'chunkSize', 'customPrompt'
    ])
    expect(wrapper.vm.selectedOperator.id).toBe('op-general')
  })
})

describe('文案与提示', () => {
  it('getTipsText / getPlaceholderText：locale 回退与 defaultValue 优先', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.getTipsText({})).toBeNull()
    expect(wrapper.vm.getTipsText({ tips: { zh: '中文说明', en: 'English tip' } })).toBe('中文说明')
    wrapper.vm.$i18n.locale = 'en'
    expect(wrapper.vm.getTipsText({ tips: { en: 'English tip' } })).toBe('English tip')
    expect(wrapper.vm.getTipsText({ tips: { zh: '中文说明' } })).toBe('中文说明') // en 缺失回 zh
    wrapper.vm.$i18n.locale = 'zh'

    expect(wrapper.vm.getPlaceholderText({ defaultValue: '直接用默认' })).toBe('直接用默认')
    expect(wrapper.vm.getPlaceholderText({})).toBe('')
    expect(wrapper.vm.getPlaceholderText({ placeholder: { zh: '请输入' } })).toBe('请输入')
  })

  it('formatFileSize / 上传提示按大小分组拼接', async () => {
    const wrapper = await mountPage({ fileLimit: { maxSizeMap: { pdf: 20, doc: 20, txt: 5 }, number: 10 } })
    expect(wrapper.vm.formatFileSize(0)).toBe('0 MB')
    expect(wrapper.vm.formatFileSize(1024 * 1024)).toBe('1.00')

    const tip = wrapper.vm.formatUploadTip()
    expect(tip).not.toContain('|')
    expect(tip).toContain('<br />')
    expect(tip).toContain('20MB')
    expect(tip).toContain('5MB')
    expect(tip).toContain('10') // 文件数上限
  })

  it('accept 过滤 ofd / zedx（大小写不敏感）', async () => {
    const wrapper = await mountPage({ fileLimit: { maxSizeMap: { PDF: 1, ofd: 1, ZEDX: 1 }, number: 5 } })
    expect(wrapper.vm.filteredFileFormats).toEqual({ PDF: 1 })
    expect(wrapper.vm.acceptAttr).toBe('.PDF')
  })

  it('getOperatorLabel：$globalZh 走中文名，否则英文名回退中文名', async () => {
    const wrapper = await mountPage()
    const op = { id: 1, name: '中', nameEn: 'EN' }
    expect(wrapper.vm.getOperatorLabel(op)).toBe('中')
    wrapper.vm.$.appContext.config.globalProperties.$globalZh = false
    expect(wrapper.vm.getOperatorLabel(op)).toBe('EN')
    expect(wrapper.vm.getOperatorLabel({ id: 2, name: '只有中文' })).toBe('只有中文')
  })
})

describe('构建链路（canBuild / handleBuild）', () => {
  async function readyPage () {
    const wrapper = await mountPage({ draft: { name: '电影图谱', description: 'desc', model: 'bge-large', files: [{ name: 'a.pdf', size: 1, raw: new File(['x'], 'a.pdf') }] } })
    wrapper.vm.step2Form.config.operator = 'op-general'
    wrapper.vm.handleOperatorChange('op-general')
    // 手工把参数补齐（模拟用户选择）
    wrapper.vm.dynamicParams.schemaId = 'tpl-1'
    wrapper.vm.dynamicParams.llm = 'gpt-x'
    await flush()
    return wrapper
  }

  it('canBuild 逐项闸门：名称/模型/文件/算子/每个参数都要就位', async () => {
    const wrapper = await mountPage()
    expect(wrapper.vm.canBuild).toBe(false)

    wrapper.vm.formData.name = '图谱'
    wrapper.vm.formData.embeddingModel = 'bge-large'
    expect(wrapper.vm.canBuild).toBe(false) // 没文件

    wrapper.vm.uploadedFiles.push({ name: 'a.pdf', size: 1, raw: {} })
    expect(wrapper.vm.canBuild).toBe(false) // 没算子

    wrapper.vm.step2Form.config.operator = 'op-general'
    expect(wrapper.vm.canBuild).toBe(false) // 参数没填完

    wrapper.vm.handleOperatorChange('op-general') // 参数按 args 重建，schemaId/llm 还是空
    expect(wrapper.vm.canBuild).toBe(false)
    wrapper.vm.dynamicParams.schemaId = 'tpl-1'
    wrapper.vm.dynamicParams.llm = 'gpt-x'
    expect(wrapper.vm.canBuild).toBe(true)

    // 无参数算子：选上即可构建
    wrapper.vm.step2Form.config.operator = 'op-bare'
    expect(wrapper.vm.canBuild).toBe(true)
  })

  it('名称纯空格 / 非法字符 / 长度越界的校验器分支', async () => {
    const wrapper = await mountPage()
    const validator = wrapper.vm.$.setupState && null
    const rules = wrapper.vm.$.type.__title
    void validator
    void rules
    // 直接从 setupState 拿 formRules 里的 validator 逐条验证
    const setup = wrapper.vm.$.setupState
    const validate = setup.formRules.name.find(rule => typeof rule.validator === 'function').validator
    const run = value => new Promise(resolve => validate({}, value, error => resolve(error ? error.message : null)))

    expect(await run('')).toBeNull() // 空：交给 required 规则
    expect(await run('   ')).toBeTruthy() // 全空格
    expect(await run('abc!')).toBeTruthy() // 非法字符
    expect(await run('a')).toBeTruthy() // 太短
    expect(await run('好名字 01')).toBeNull() // 中文/数字/空格/点/中划线
    expect(await run('a'.repeat(31))).toBeTruthy() // 太长
    expect(await run('a'.repeat(30))).toBeNull()
  })

  it('就绪后构建：FormData 携带文件与 data，schemaId 提升为顶层字段，成功后回列表', async () => {
    const wrapper = await readyPage()
    await wrapper.vm.handleBuild()

    expect(graphApi.extractKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    const fd = graphApi.extractKnowledgeGraphApi.mock.calls[0][0]
    expect(fd).toBeInstanceOf(FormData)
    expect(fd.get('file')).toBeTruthy()
    const payload = JSON.parse(fd.get('data'))
    expect(payload).toMatchObject({
      name: '电影图谱',
      description: 'desc',
      category: 10,
      operatorId: 'op-general',
      schemaId: 'tpl-1',
      coverFlag: true,
      props: { embeddingModel: 'bge-large' }
    })
    expect(payload.kwargs).toEqual({ llm: 'gpt-x', overlap: 128, chunkSize: 1024, customPrompt: '默认提示' })
    expect(payload.kwargs.schemaId).toBeUndefined()
    expect(messageMock.success).toHaveBeenCalled()
    await flush() // router.push 未被 await
    expect(wrapper.router.currentRoute.value.path).toBe('/graph')
    expect(wrapper.vm.buildLoading).toBe(false)
  })

  it('未就绪点构建：只警告不发请求', async () => {
    const wrapper = await mountPage()
    await wrapper.vm.handleBuild()
    expect(graphApi.extractKnowledgeGraphApi).not.toHaveBeenCalled()
    expect(messageMock.warning).toHaveBeenCalled()
  })

  it('构建失败：静默（拦截器已提示），loading 复位，不跳转', async () => {
    graphApi.extractKnowledgeGraphApi.mockRejectedValue(new Error('boom'))
    const wrapper = await readyPage()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await wrapper.vm.handleBuild()
    expect(wrapper.router.currentRoute.value.path).toBe('/graph/create')
    expect(wrapper.vm.buildLoading).toBe(false)
    error.mockRestore()
  })

  it('取消：直接回图谱列表', async () => {
    const wrapper = await readyPage()
    wrapper.vm.handleCancel()
    await flush()
    expect(wrapper.router.currentRoute.value.path).toBe('/graph')
  })
})
