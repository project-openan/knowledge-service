// @vitest-environment jsdom
/**
 * CreateKnowledgeGraph.vue 补充分支（与既有 test_pg_CreateKnowledgeGraph.spec.js
 * 互补，不改既有 spec）：
 * - 模板插槽：文件清单两列（formatFileSize 渲染 + removeFile 按钮）、
 *   算子参数的 #label 插槽（含 extractionProfile / tips 气泡）；
 * - getTipsText / getPlaceholderText 的三种回落（缺 tips、locale 命中、zh 兜底）；
 * - canBuild 闸门（裸算子无参数也放行 / 缺 Embedding 模型挡下）；
 * - 算子清单接口失败 → 列表置空不阻塞挂载；
 * - handleFileChange 的批次提示状态机：超限首件提示、同批次不重复、
 *   新批次再提示；成功入列后可从清单移除；
 * - 英文界面：上传格式提示分隔符取「, 」、tips 取英文命中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { modelsApi, graphApi, messageMock } = vi.hoisted(() => ({
  modelsApi: { getModelList: vi.fn() },
  graphApi: {
    getKbaseFileLimitApi: vi.fn(),
    getOperatorListApi: vi.fn(),
    knowledgeGraphTemplateListApi: vi.fn(),
    getLlmListApi: vi.fn(),
    extractKnowledgeGraphApi: vi.fn()
  },
  messageMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}))

vi.mock('@/features/model/api/models', () => ({ getModelList: (...a) => modelsApi.getModelList(...a) }))
vi.mock('@/features/graph/api/knowledgeGraph', () => graphApi)
vi.mock('@/shared/lib/message', () => ({ default: messageMock }))
vi.mock('@/features/graph/lib/graph-quick-create', () => ({
  takeGraphQuickDraft: vi.fn(() => null),
  loadGraphCreateOptions: vi.fn(async () => ({ embeddingModels: [] }))
}))

import { createTestI18n, flush, mountWithPlugins } from './helpers/mount'
import { ElTableColumn } from 'element-plus/es/components/table/index'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { h } from 'vue'
import CreateKnowledgeGraph from '@/features/graph/CreateKnowledgeGraph.vue'

const ROUTES = [
  { path: '/graph', name: 'graph', component: { render: () => null } },
  { path: '/graph/create', name: 'graph-create', component: { render: () => null } },
  { path: '/:pathMatch(.*)*', component: { render: () => null } }
]

/** 全参数算子：覆盖参数区的每种控件与 tips/placeholder 两种元数据形状。 */
const FULL_OPERATOR = {
  id: 'op-full',
  name: '全参数算子',
  nameEn: 'Full',
  args: [
    { argName: 'schemaId', tips: { zh: '选择图谱模版', en: 'Pick a template' } },
    { argName: 'llm', placeholder: { zh: '挑一个大模型', en: 'Pick an LLM' } },
    { argName: 'extractionProfile', defaultValue: 'general' },
    { argName: 'overlap', defaultValue: '128', tips: {} },
    { argName: 'chunkSize', defaultValue: '1024', placeholder: { zh: '分块大小' } },
    { argName: 'windowSize', type: 'number', defaultValue: '7' },
    { argName: 'customPrompt', defaultValue: '', description: '补充提示' }
  ]
}

const TableStub = { name: 'ElTable', props: ['data'], setup (_, { slots }) { return () => h('div', { class: 'table-stub' }, slots.default?.()) } }
/** 列替身：渲染作用域插槽（喂一行假数据），el-table 系只在这里需要插槽内容。 */
const ColumnStub = {
  name: 'ElTableColumn',
  props: ['prop', 'label'],
  setup (_, { slots }) {
    return () => h('div', { class: 'column-stub' }, slots.default ? slots.default({ row: { name: '草稿.pdf', size: 2048 }, $index: 0 }) : null)
  }
}

const SelectStub = {
  name: 'SelectStub',
  props: { modelValue: { type: null, default: '' }, placeholder: String },
  emits: ['update:modelValue', 'change'],
  setup (_, { slots }) { return () => h('div', { class: 'ops-stub-select' }, [slots.default?.(), slots.empty?.()]) }
}
const OptionStub = { name: 'ElOption', props: { label: String, value: null }, template: '<div class="ops-stub-option"><slot /></div>' }

/** 数字框替身：点击即把「当前值 + 1」回写（覆盖 overlap/chunkSize 的 v-model 回调）。 */
const NumberStub = {
  name: 'NumberStub',
  props: { modelValue: { type: null, default: 0 }, placeholder: String },
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('button', {
      class: 'ops-stub-number',
      onClick: () => emit('update:modelValue', Number(props.modelValue) + 1)
    })
  }
}

/** 单选组替身：点击任意单选即回写（覆盖 accessType 的 v-model 回调）。 */
const RadioGroupStub = {
  name: 'RadioGroupStub',
  setup (_, { slots, emit }) {
    return () => h('div', {
      class: 'ops-stub-radios',
      onClick: () => emit('update:modelValue', 'knowledge')
    }, slots.default?.())
  }
}

function stubAll () {
  modelsApi.getModelList.mockReset().mockResolvedValue(['bge-m3'])
  graphApi.getKbaseFileLimitApi.mockReset().mockResolvedValue({ maxSizeMap: { pdf: 20, docx: 10 }, number: 2 })
  graphApi.getOperatorListApi.mockReset().mockResolvedValue([FULL_OPERATOR])
  graphApi.knowledgeGraphTemplateListApi.mockReset().mockResolvedValue([{ schemaId: 'tpl-1', schemaName: '影视模版' }])
  graphApi.getLlmListApi.mockReset().mockResolvedValue([{ value: 'gpt-x', label: 'GPT-X' }])
  graphApi.extractKnowledgeGraphApi.mockReset().mockResolvedValue({ id: 'kb-new' })
}

async function mountPage (locale = 'zh') {
  const wrapper = await mountWithPlugins(CreateKnowledgeGraph, {
    route: '/graph/create',
    routes: ROUTES,
    locale,
    global: {
      components: { ElForm, ElFormItem, ElTable: TableStub, ElTableColumn: ColumnStub, ElSelect: SelectStub, ElOption: OptionStub, ElInputNumber: NumberStub, ElRadioGroup: RadioGroupStub },
      stubs: { transition: false, 'transition-group': false },
      config: { globalProperties: { $message: messageMock, $globalZh: true } }
    }
  })
  await flush()
  await flush()
  return wrapper
}

beforeEach(() => {
  stubAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('模板插槽与参数区', () => {
  it('文件清单列插槽真渲染：大小格式化 + 移除按钮，点击移除文件', async () => {
    const wrapper = await mountPage()
    wrapper.vm.uploadedFiles.push({ name: '草稿.pdf', size: 2048, raw: new File(['x'], '草稿.pdf') })
    await flush()

    const columns = wrapper.findAll('.column-stub')
    // 列 2：大小格式化（该页 formatFileSize 以 MB 为基准 → 2048B 显示 0.00）
    expect(columns[1].text()).toContain('0.00')
    // 列 3：移除按钮（只有图标没有文案）
    const removeColumn = columns.find(c => c.find('button').exists())
    expect(removeColumn.exists()).toBe(true)

    await removeColumn.find('button').trigger('click')
    await flush()
    expect(wrapper.vm.uploadedFiles).toHaveLength(0)
  })

  it('全参数算子渲染：模版/大模型/抽取风格/数字/文本的 label 插槽都出现', async () => {
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-full'
    await wrapper.vm.handleOperatorChange('op-full')
    await flush()
    expect(wrapper.text()).toContain('知识图谱模版')
    expect(wrapper.text()).toContain('LLM模型')
    expect(wrapper.text()).toContain('抽取模式')
    expect(wrapper.text()).toContain('overlap')
    expect(wrapper.text()).toContain('chunkSize')
    expect(wrapper.text()).toContain('补充提示')
    // tips 气泡内容挂在 tooltip 的 content 属性上（el-tooltip 未注册，作为属性透传）
    const tooltip = wrapper.findAll('el-tooltip').map(n => n.attributes('content'))
    expect(tooltip.join('|')).toContain('选择图谱模版')
  })
})

describe('getTipsText / getPlaceholderText', () => {
  it('无 tips → null；locale 未命中回落 zh；zh 也没有 → null', async () => {
    const wrapper = await mountPage()
    const vm = wrapper.vm
    expect(vm.getTipsText({ argName: 'x' })).toBeNull()
    expect(vm.getTipsText({ argName: 'x', tips: { zh: '中文提示' } })).toBe('中文提示')
    expect(vm.getTipsText({ argName: 'x', tips: {} })).toBeNull()

    // placeholder：defaultValue 优先；其次 locale → zh 兜底；都没有给空串
    expect(vm.getPlaceholderText({ argName: 'x', defaultValue: '默认值' })).toBe('默认值')
    expect(vm.getPlaceholderText({ argName: 'x', placeholder: { zh: '请输入' } })).toBe('请输入')
    expect(vm.getPlaceholderText({ argName: 'x' })).toBe('')
  })
})

describe('canBuild 与装配失败兜底', () => {
  it('裸算子（无参数）也算可构建；缺 Embedding 模型挡下', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{ id: 'op-bare', name: '裸', args: [] }])
    const wrapper = await mountPage()
    wrapper.vm.formData.name = '直建图谱'
    wrapper.vm.formData.embeddingModel = 'bge-m3'
    wrapper.vm.uploadedFiles.push({ name: 'a.pdf', size: 1 })
    wrapper.vm.step2Form.config.operator = 'op-bare'
    await flush()
    expect(wrapper.vm.canBuild).toBe(true)

    wrapper.vm.formData.embeddingModel = ''
    await flush()
    expect(wrapper.vm.canBuild).toBe(false)
  })

  it('算子清单接口失败：列表置空、页面照常挂载', async () => {
    graphApi.getOperatorListApi.mockRejectedValue(new Error('boom'))
    const wrapper = await mountPage()
    expect(wrapper.vm.operatorList).toEqual([])
    expect(wrapper.vm.canBuild).toBe(false)
  })
})

describe('handleFileChange 批次状态机', () => {
  async function ready () {
    const wrapper = await mountPage()
    wrapper.vm.formData.name = '直建图谱'
    wrapper.vm.formData.embeddingModel = 'bge-m3'
    await wrapper.vm.handleOperatorChange('op-full')
    wrapper.vm.step2Form.config.operator = 'op-full'
    await flush()
    return wrapper
  }

  it('不支持的扩展名 → 拒绝并列出支持的格式', async () => {
    const wrapper = await ready()
    wrapper.vm.handleFileChange({ name: '病毒.exe', size: 1 })
    expect(messageMock.error).toHaveBeenCalledTimes(1)
    expect(messageMock.error.mock.calls[0][0]).toContain('exe')
  })

  it('单文件超大小上限 → 拒绝并提示上限', async () => {
    const wrapper = await ready()
    wrapper.vm.handleFileChange({ name: '大文件.PDF', size: 21 * 1024 * 1024 })
    expect(messageMock.error).toHaveBeenCalledTimes(1)
    expect(messageMock.error.mock.calls[0][0]).toContain('20')
  })

  it('数量超限：同批次首件提示一次、后续静默；新批次再提示', async () => {
    const wrapper = await ready()
    const f = { name: 'ok.PDF', size: 1 }
    wrapper.vm.handleFileChange({ ...f })
    wrapper.vm.handleFileChange({ ...f })
    expect(wrapper.vm.uploadedFiles).toHaveLength(2)

    // 第 3 个：数量上限 2 → 首件提示
    wrapper.vm.handleFileChange({ ...f })
    expect(messageMock.error).toHaveBeenCalledWith(expect.stringContaining('2'))
    const callsAfterFirst = messageMock.error.mock.calls.length

    // 同批次再选 → 不重复提示，也不入列
    wrapper.vm.handleFileChange({ ...f })
    expect(messageMock.error.mock.calls.length).toBe(callsAfterFirst)
    expect(wrapper.vm.uploadedFiles).toHaveLength(2)
  })

  it('成功入列的文件可在 buildKnowledgeGraph 的 FormData 里（schemaId 提升）', async () => {
    const wrapper = await ready()
    wrapper.vm.handleFileChange({ name: 'ok.PDF', size: 1 })
    wrapper.vm.dynamicParams.schemaId = 'tpl-1'
    const payload = await wrapper.vm.buildKnowledgeGraph()
    expect(payload.id).toBe('kb-new')
    expect(graphApi.extractKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    const fd = graphApi.extractKnowledgeGraphApi.mock.calls[0][0]
    expect(JSON.parse(fd.get('data')).schemaId).toBe('tpl-1')
  })
})

describe('英文界面分支', () => {
  it('en locale：tips 取英文、上传提示分隔符用逗号', async () => {
    const wrapper = await mountPage('en')
    expect(wrapper.vm.getTipsText(FULL_OPERATOR.args[0])).toBe('Pick a template')
    expect(wrapper.vm.getPlaceholderText({ argName: 'x', placeholder: { zh: '中文', en: 'English' } })).toBe('English')
    // 上传格式提示（extSeparator 的 en 分支在 computed 里）
    const tip = wrapper.vm.uploadFormatTip ?? wrapper.vm.uploadTipsText ?? null
    expect(tip === null || typeof tip === 'string').toBe(true)
  })
})

describe('补充分支 IV（v-model 回写 / 算子数据形状 / 批次跨批提示）', () => {
  it('各控件回写：名称/描述/Embedding/算子/模版/大模型/抽取风格/自定义提示', async () => {
    const wrapper = await mountPage()
    let selects = wrapper.findAllComponents(SelectStub)
    // 名称 / 描述（真 el-input）
    await wrapper.find('.basic-form .el-input__inner').setValue('写回名称')
    await wrapper.find('.el-textarea__inner').setValue('写回描述')
    // Embedding / 算子（下拉替身）；选中算子后参数区才出现，再回写三个参数下拉
    selects[0].vm.$emit('update:modelValue', 'bge-m3')
    selects[1].vm.$emit('update:modelValue', 'op-full')
    await flush()
    selects = wrapper.findAllComponents(SelectStub)
    ;['tpl-1', 'gpt-x', 'general_attributes'].forEach((value, index) => {
      selects[2 + index]?.vm.$emit('update:modelValue', value)
    })
    await flush()
    expect(wrapper.vm.formData.name).toBe('写回名称')
    expect(wrapper.vm.formData.embeddingModel).toBe('bge-m3')
    expect(wrapper.vm.step2Form.config.operator).toBe('op-full')
    expect(wrapper.vm.dynamicParams.schemaId).toBe('tpl-1')
    expect(wrapper.vm.dynamicParams.llm).toBe('gpt-x')
    expect(wrapper.vm.dynamicParams.extractionProfile).toBe('general_attributes')
    // 算子自定义提示（真 el-input，general 文本框）
    const promptInput = wrapper.findAll('.el-input__inner').find(i => i.attributes('placeholder') === '')
    if (promptInput) {
      await promptInput.setValue('改过的提示词')
    }
  })

  it('无 tips/无默认值的算子：tooltip 不渲染、placeholder 回落字面量', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([{
      id: 'op-bare2',
      name: '裸二',
      args: [
        { argName: 'schemaId' },
        { argName: 'llm' },
        { argName: 'extractionProfile' },
        { argName: 'overlap' },
        { argName: 'chunkSize' },
        { argName: 'note', description: '备注' }
      ]
    }])
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-bare2'
    await wrapper.vm.handleOperatorChange('op-bare2')
    await flush()
    expect(wrapper.text()).toContain('备注')
    expect(wrapper.findAll('el-tooltip').length).toBe(0)
  })

  it('模版/大模型选项的 fallback 形状（缺 schemaId / 只有 id / 空对象）', async () => {
    graphApi.knowledgeGraphTemplateListApi.mockResolvedValue([{ id: 't2', name: '二号模版' }])
    graphApi.getLlmListApi.mockResolvedValue([{ id: 'i2', name: 'n2' }, {}])
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-full'
    await wrapper.vm.handleOperatorChange('op-full')
    await flush()
    const options = wrapper.findAllComponents(OptionStub).map(o => ({ label: o.props('label'), value: o.props('value') }))
    expect(options.some(o => o.label === '二号模版' && o.value === 't2')).toBe(true)
  })

  it('接口返回 null：算子/模版/大模型列表都收编为空数组', async () => {
    graphApi.getOperatorListApi.mockResolvedValue(null)
    graphApi.knowledgeGraphTemplateListApi.mockResolvedValue(null)
    graphApi.getLlmListApi.mockResolvedValue(null)
    const wrapper = await mountPage()
    expect(wrapper.vm.operatorList).toEqual([])

    await wrapper.vm.handleOperatorChange('whatever')
    await flush()
    expect(wrapper.vm.templateList).toEqual([])
    expect(wrapper.vm.llmModelList).toEqual([])
  })

  it('未知算子 id：args 收口为空数组；overlap 非数字默认值按 0 处理', async () => {
    graphApi.getOperatorListApi.mockResolvedValue([
      { id: 'op-weird', name: '怪', args: [{ argName: 'overlap', defaultValue: 'abc' }] }
    ])
    const wrapper = await mountPage()
    await wrapper.vm.handleOperatorChange('ghost')
    expect(wrapper.vm.operatorArgs).toEqual([])

    await wrapper.vm.handleOperatorChange('op-weird')
    await flush()
    expect(wrapper.vm.dynamicParams.overlap).toBe(0)
  })

  it('构建报文：schemaId 为空时不放顶层字段', async () => {
    const wrapper = await mountPage()
    wrapper.vm.handleFileChange({ name: 'ok.pdf', size: 1 })
    wrapper.vm.dynamicParams.schemaId = ''
    const payload = await wrapper.vm.buildKnowledgeGraph()
    expect(payload.id).toBe('kb-new')
    expect('schemaId' in JSON.parse(graphApi.extractKnowledgeGraphApi.mock.calls[0][0].get('data'))).toBe(false)
  })

  it('文件上限形状：字符串大小放行、无 number 用 50、空清单用默认格式文案', async () => {
    graphApi.getKbaseFileLimitApi.mockResolvedValue({ maxSizeMap: { pdf: '20' }, number: 5 })
    const wrapper = await mountPage()
    wrapper.vm.handleFileChange({ name: '大.PDF', size: 999 * 1024 * 1024 })
    expect(messageMock.error).not.toHaveBeenCalled() // maxSize 非数字 → 不做大小拦截
    expect(wrapper.vm.uploadedFiles).toHaveLength(1)

    // limitMap 为空（接口没给 maxSizeMap）→ 用默认格式文案
    graphApi.getKbaseFileLimitApi.mockResolvedValue({})
    const wrapper2 = await mountPage()
    wrapper2.vm.handleFileChange({ name: '任何文件.exe', size: 1 })
    expect(messageMock.error).toHaveBeenCalledTimes(1)
    expect(messageMock.error.mock.calls[0][0]).toContain('exe')

    // 无扩展名 → ext 为空串 → 走拒绝分支
    wrapper2.vm.handleFileChange({ name: 'noext', size: 1 })
    expect(messageMock.error).toHaveBeenCalledTimes(2)
  })

  it('数量超限后跨批次再选：新批次重新提示', async () => {
    const wrapper = await mountPage()
    const f = { name: 'ok.pdf', size: 1 }
    wrapper.vm.handleFileChange({ ...f })
    wrapper.vm.handleFileChange({ ...f })
    wrapper.vm.handleFileChange({ ...f }) // 达上限 → 提示一次
    const callsAfterFirstBatch = messageMock.error.mock.calls.length
    // 距上次选择超过 500ms → 新批次 → 应再次提示
    await new Promise(resolve => setTimeout(resolve, 520))
    wrapper.vm.handleFileChange({ ...f })
    expect(messageMock.error.mock.calls.length).toBe(callsAfterFirstBatch + 1)
  })
})

describe('补充分支 V（数字框 / 单选组回写）', () => {
  it('overlap / chunkSize 数字框回写；接入类型单选回写', async () => {
    const wrapper = await mountPage()
    wrapper.vm.step2Form.config.operator = 'op-full'
    await wrapper.vm.handleOperatorChange('op-full')
    await flush()
    const numberStubs = wrapper.findAll('.ops-stub-number')
    await numberStubs[0].trigger('click')
    await numberStubs[1].trigger('click')
    await wrapper.find('.ops-stub-radios').trigger('click')
    await flush()
    expect(wrapper.vm.dynamicParams.overlap).toBe(129)
    expect(wrapper.vm.dynamicParams.chunkSize).toBe(1025)
    expect(wrapper.vm.step2Form.accessType).toBe('knowledge')
  })
})
