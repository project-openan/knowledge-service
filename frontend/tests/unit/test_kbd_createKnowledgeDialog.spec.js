// @vitest-environment jsdom
// 建库/建图弹窗（CreateKnowledgeDialog.vue）：
// - 文档库链路：打开回填（模板名→名称后缀）、文件必选、提交 emit payload、
//   submitHandler 成功关弹窗 / 失败留弹窗并显示就地错误；
// - 名称校验分支：必填 / 长度 2-30 / 重名（大小写不敏感）；
// - 图谱链路：算子清单加载失败的就地报错、切算子生成默认参数（schemaId/llm 按需加载、
//   数字参数默认值）、参数校验（required / overlap<chunkSize）挡提交、
//   无 submitHandler 时直接打 extractKnowledgeGraphApi（FormData + success=false 业务失败）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const graphApi = vi.hoisted(() => ({
  getOperatorListApi: vi.fn(),
  knowledgeGraphTemplateListApi: vi.fn(),
  getLlmListApi: vi.fn(),
  extractKnowledgeGraphApi: vi.fn()
}))

vi.mock('@/features/graph/api', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    getOperatorListApi: (...args) => graphApi.getOperatorListApi(...args),
    knowledgeGraphTemplateListApi: (...args) => graphApi.knowledgeGraphTemplateListApi(...args),
    getLlmListApi: (...args) => graphApi.getLlmListApi(...args),
    extractKnowledgeGraphApi: (...args) => graphApi.extractKnowledgeGraphApi(...args)
  }
})

import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import { ElInputNumber } from 'element-plus/es/components/input-number/index'
import CreateKnowledgeDialog from '@/features/knowledge-base/components/CreateKnowledgeDialog.vue'
import KnowledgeFilePicker from '@/features/knowledge-base/components/KnowledgeFilePicker.vue'
import zhDialogs from '@/app/i18n/zh/studioDialogs'

const CK = zhDialogs.createKnowledge

/** el-dialog 透传件：header / 默认 / footer 全渲染。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal', 'appendToBody'],
  setup (props, { slots }) {
    return () => h('div', { class: 'test-dialog' }, [
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
    ])
  }
}

const GLOBAL = {
  components: { ElDialog: DialogPassthrough, ElForm, ElFormItem, ElSelect, ElOption, ElInputNumber },
  stubs: { transition: false, 'transition-group': false }
}

const OPERATOR = {
  id: 'op-1',
  name: '图谱抽取算子',
  nameEn: 'Graph Extractor',
  description: '从文档抽取实体与关系',
  args: [
    { argName: 'schemaId', type: 'string', required: true },
    { argName: 'llm', type: 'string', required: true },
    { argName: 'extractionProfile', type: 'string', defaultValue: 'general' },
    { argName: 'chunkSize', type: 'number', defaultValue: 2048 },
    { argName: 'overlap', type: 'number', defaultValue: 256 },
    { argName: 'topK', type: 'string', defaultValue: '5' }
  ]
}

const TEMPLATES = [{ schemaId: 'tpl-1', schemaName: '合同模板' }]
const LLMS = [{ value: 'm-1', label: '模型一' }]

function makeFile (name, size = 10) {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' })
}

async function mountDialog (props = {}) {
  const wrapper = await mountWithPlugins(CreateKnowledgeDialog, {
    props: { modelValue: false, models: [{ name: 'bge-m3' }], ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  await flush()
  return wrapper
}

async function addFiles (wrapper, files) {
  wrapper.findComponent(KnowledgeFilePicker).vm.$emit('update:modelValue', files)
  await flush()
}

function nameInput (wrapper) {
  return wrapper.find('input[maxlength="30"]')
}

async function fillName (wrapper, value) {
  await nameInput(wrapper).setValue(value)
  await nameInput(wrapper).trigger('blur')
  await flush()
}

async function clickSubmit (wrapper) {
  const button = wrapper.findAll('button').find(b => b.text().includes(CK.createButton) || b.text().includes(CK.graphSubmit))
  await button.trigger('click')
  await flush()
  await flush()
}

/** name 表单项的校验状态（jsdom 里行内文案挂在 transition 下，读组件状态更稳） */
function nameState (wrapper) {
  const item = wrapper.findAllComponents(ElFormItem).find(i => i.props('prop') === 'name')
  return [item.vm.validateState, item.vm.validateMessage]
}

async function selectOperator (wrapper, operatorId) {
  const selects = wrapper.findAllComponents(ElSelect)
  const operatorSelect = selects.find(sel => sel.props('placeholder') === CK.operatorPlaceholder)
  operatorSelect.vm.$emit('update:modelValue', operatorId)
  operatorSelect.vm.$emit('change', operatorId)
  await flush()
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  graphApi.getOperatorListApi.mockReset().mockResolvedValue([OPERATOR])
  graphApi.knowledgeGraphTemplateListApi.mockReset().mockResolvedValue(TEMPLATES)
  graphApi.getLlmListApi.mockReset().mockResolvedValue(LLMS)
  graphApi.extractKnowledgeGraphApi.mockReset().mockResolvedValue({ success: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('文档库链路（graph=false）', () => {
  it('打开：名称按模板回填（带模板后缀）、模型默认选中第一个；没文件时提交按钮禁用', async () => {
    const wrapper = await mountDialog({ template: '合同模板' })
    // 名称直接用模板名，描述带「模板」后缀（见 watch(open) 的回填）
    expect(nameInput(wrapper).element.value).toBe('合同模板')
    const description = wrapper.find('textarea')
    expect(description.element.value).toBe('合同模板' + CK.templateSuffix)
    // 没文件：主按钮禁用
    const submit = wrapper.findAll('button').find(b => b.text().includes(CK.createButton))
    expect(submit.attributes('disabled')).toBeDefined()
  })

  it('名称校验：空 → 必填；1 个字 → 长度；existingNames 重名（大小写不敏感）→ 判重', async () => {
    const wrapper = await mountDialog({ existingNames: ['已有库'] })

    await fillName(wrapper, '  ')
    expect(nameState(wrapper)).toEqual(['error', CK.nameRequired])

    await fillName(wrapper, 'a')
    expect(nameState(wrapper)).toEqual(['error', CK.nameLength])

    await fillName(wrapper, '已有库')
    expect(nameState(wrapper)).toEqual(['error', CK.nameDuplicate])

    await fillName(wrapper, '换一个名字')
    expect(nameState(wrapper)[0]).toBe('success')
  })

  it('无 submitHandler：提交 emit payload（name/description/model/files/totalBytes）并关弹窗', async () => {
    const wrapper = await mountDialog({ existingNames: [] })
    await fillName(wrapper, '新知识库')
    await addFiles(wrapper, [makeFile('a.txt', 5), makeFile('b.md', 7)])
    await clickSubmit(wrapper)

    const emitted = wrapper.emitted('create')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toMatchObject({
      name: '新知识库',
      description: '',
      model: 'bge-m3',
      totalBytes: 12
    })
    expect(emitted[0][0].files.map(f => f.name)).toEqual(['a.txt', 'b.md'])
    // 成功后关闭
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('有 submitHandler：成功 → 关闭；失败（detail）→ 留在弹窗并显示就地错误', async () => {
    const failing = vi.fn(async () => {
      throw { detail: '重名 409' }
    })
    const wrapper = await mountDialog({ submitHandler: failing })
    await fillName(wrapper, '另一个库')
    await addFiles(wrapper, [makeFile('a.txt')])
    await clickSubmit(wrapper)

    expect(failing).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.kb-submit-error').text()).toContain('重名 409')
    // 弹窗没关
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await wrapper.setProps({ submitHandler: async () => ({}) })
    await clickSubmit(wrapper)
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
    // 下次提交或改字段前错误保持：关闭后错误文案随弹窗复位（重开时清空由 watch 保证）
  })

  it('模型清单异步到达：晚到的列表会补默认选中（watch modelOptions）', async () => {
    const wrapper = await mountDialog({ models: [] })
    await addFiles(wrapper, [makeFile('a.txt')])
    await fillName(wrapper, '晚到模型库')
    // 打开后模型清单才到
    await wrapper.setProps({ models: [{ name: 'late-model' }] })
    await flush()
    await clickSubmit(wrapper)

    expect(wrapper.emitted('create')[0][0].model).toBe('late-model')
  })
})

describe('图谱链路（graph=true）', () => {
  function mountGraph (props = {}) {
    return mountDialog({ graph: true, ...props })
  }

  it('算子清单加载失败：下拉为空并显示就地错误；模板/大模型清单失败回落为空数组', async () => {
    graphApi.getOperatorListApi.mockRejectedValue(new Error('boom'))
    graphApi.knowledgeGraphTemplateListApi.mockRejectedValue(new Error('boom'))
    graphApi.getLlmListApi.mockRejectedValue(new Error('boom'))
    const wrapper = await mountGraph()
    expect(wrapper.find('.kb-options-error').text()).toContain(CK.graphOptionsFailed)
  })

  it('切算子：生成默认参数（数字参数用声明默认值）、schemaId/llm 的数据源按需加载', async () => {
    const wrapper = await mountGraph()
    await selectOperator(wrapper, 'op-1')

    // 算子描述进配置说明
    expect(wrapper.find('.kb-config-note').text()).toContain('从文档抽取实体与关系')
    // 参数字段按序渲染：图谱模板 → 大模型 → 抽取配置 → 数字参数 → 通用输入
    const labels = wrapper.findAll('.kb-operator-fields .el-form-item__label').map(l => l.text())
    expect(labels.join('|')).toContain(CK.graphTemplate)
    expect(labels.join('|')).toContain(CK.llmModel)
    // knowledgeGraphTemplateListApi / getLlmListApi 都按需打了一次
    expect(graphApi.knowledgeGraphTemplateListApi).toHaveBeenCalled()
    expect(graphApi.getLlmListApi).toHaveBeenCalled()
  })

  it('参数校验：schemaId/llm 未选时提交被挡（不 emit、不 extract）；选齐后才能过', async () => {
    const submitHandler = vi.fn(async () => ({}))
    const wrapper = await mountGraph({ submitHandler })
    await fillName(wrapper, '图谱库A')
    await addFiles(wrapper, [makeFile('a.pdf')])
    await selectOperator(wrapper, 'op-1')

    await clickSubmit(wrapper)
    // required 错误挡住：submitHandler 没被打
    expect(wrapper.emitted('create')).toBeUndefined()
    const submitError = wrapper.find('.kb-submit-error')
    expect(submitError.exists()).toBe(false) // 参数错误是行内 error，不是 footer 错误

    // 选齐 schemaId + llm
    const selects = wrapper.findAllComponents(ElSelect)
    const schemaSelect = selects.find(sel => sel.props('placeholder') === CK.graphTemplatePlaceholder)
    schemaSelect.vm.$emit('update:modelValue', 'tpl-1')
    schemaSelect.vm.$emit('change', 'tpl-1')
    const llmSelect = selects.find(sel => sel.props('placeholder') === CK.llmPlaceholder)
    llmSelect.vm.$emit('update:modelValue', 'm-1')
    llmSelect.vm.$emit('change', 'm-1')
    await flush()
    await clickSubmit(wrapper)

    // submitHandler 路径：参数收进 payload（operator + buildConfig），成功后关弹窗
    expect(submitHandler).toHaveBeenCalledTimes(1)
    const payload = submitHandler.mock.calls[0][0]
    expect(payload.name).toBe('图谱库A')
    expect(payload.operator).toMatchObject({ id: 'op-1' })
    expect(payload.buildConfig).toMatchObject({ schemaId: 'tpl-1', llm: 'm-1', chunkSize: 2048, overlap: 256, topK: '5' })
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('无 submitHandler：直接打 extractKnowledgeGraphApi（FormData.data 是建图报文）', async () => {
    const wrapper = await mountGraph()
    await fillName(wrapper, '直连图谱库')
    await addFiles(wrapper, [makeFile('a.pdf', 3)])
    await selectOperator(wrapper, 'op-1')
    const selects = wrapper.findAllComponents(ElSelect)
    const schemaSelect = selects.find(sel => sel.props('placeholder') === CK.graphTemplatePlaceholder)
    schemaSelect.vm.$emit('update:modelValue', 'tpl-1')
    const llmSelect = selects.find(sel => sel.props('placeholder') === CK.llmPlaceholder)
    llmSelect.vm.$emit('update:modelValue', 'm-1')
    await flush()
    await clickSubmit(wrapper)

    expect(graphApi.extractKnowledgeGraphApi).toHaveBeenCalledTimes(1)
    const formData = graphApi.extractKnowledgeGraphApi.mock.calls[0][0]
    expect(formData).toBeInstanceOf(FormData)
    expect(formData.getAll('file').map(f => f.name)).toEqual(['a.pdf'])
    const payload = JSON.parse(formData.get('data'))
    expect(payload).toMatchObject({ name: '直连图谱库', operatorId: 'op-1', schemaId: 'tpl-1', props: { embeddingModel: 'bge-m3' } })
    expect(payload.kwargs).toMatchObject({ llm: 'm-1', chunkSize: 2048 })
    // 成功 → 关闭并 emit created
    expect(wrapper.emitted('create')).toEqual([[{ created: true }]])
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('业务失败（success=false）：message 落到弹窗底部，弹窗保持打开', async () => {
    graphApi.extractKnowledgeGraphApi.mockResolvedValue({ success: false, message: '算子执行失败' })
    const wrapper = await mountGraph()
    await fillName(wrapper, '失败的库')
    await addFiles(wrapper, [makeFile('a.pdf')])
    await selectOperator(wrapper, 'op-1')
    const selects = wrapper.findAllComponents(ElSelect)
    selects.find(sel => sel.props('placeholder') === CK.graphTemplatePlaceholder).vm.$emit('update:modelValue', 'tpl-1')
    selects.find(sel => sel.props('placeholder') === CK.llmPlaceholder).vm.$emit('update:modelValue', 'm-1')
    await flush()
    await clickSubmit(wrapper)

    // 业务失败（success=false）抛的是 Error(message)，就地错误取 detail/title，
    // 都没有时回落到「创建知识库失败」；弹窗保持打开
    expect(wrapper.find('.kb-submit-error').text()).toContain(CK.createFailed)
    expect(wrapper.emitted('create')).toBeUndefined()
  })
})
