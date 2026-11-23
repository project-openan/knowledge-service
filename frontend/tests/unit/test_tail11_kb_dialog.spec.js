// @vitest-environment jsdom
// 建库/建图弹窗（CreateKnowledgeDialog.vue）的残余分支（10/6）：
// opened 聚焦箭头（el-dialog 桩发 opened）、header 插槽渲染、取消按钮、
// 模型下拉 v-model、参数错误文案的五档映射与清除、算子切换（schemaId/llm 按需加载）、
// graphNameError 的三种分支、模型/算子校验器、提交防重与无文件早退、
// 表单校验不过早退。基础覆盖见 test_kbd_createKnowledgeDialog.spec.js。
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

import { h, watch } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElSelect, ElOption } from 'element-plus/es/components/select/index'
import { ElInputNumber } from 'element-plus/es/components/input-number/index'
import CreateKnowledgeDialog from '@/features/knowledge-base/components/CreateKnowledgeDialog.vue'
import KnowledgeFilePicker from '@/features/knowledge-base/components/KnowledgeFilePicker.vue'
import zhDialogs from '@/app/i18n/zh/studioDialogs'

const CK = zhDialogs.createKnowledge

/** header/default/footer 全渲染 + 打开时发 opened 的透传件。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal', 'appendToBody'],
  emits: ['update:modelValue', 'opened'],
  setup (props, { slots, emit }) {
    watch(() => props.modelValue, value => {
      if (value) {
        emit('opened')
      }
    })
    return () => h('div', { class: 'test-dialog' }, [
      props.modelValue && slots.header ? slots.header({ titleId: 't' }) : null,
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

async function mountDialog (props = {}) {
  graphApi.getOperatorListApi.mockReset().mockResolvedValue([OPERATOR])
  graphApi.knowledgeGraphTemplateListApi.mockReset().mockResolvedValue(TEMPLATES)
  graphApi.getLlmListApi.mockReset().mockResolvedValue(LLMS)
  graphApi.extractKnowledgeGraphApi.mockReset().mockResolvedValue({ success: true })

  const wrapper = await mountWithPlugins(CreateKnowledgeDialog, {
    props: { modelValue: false, models: [{ name: 'bge-m3' }], ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  await flush()
  return wrapper
}

function makeFile (name, size = 10) {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' })
}

async function addFiles (wrapper, files) {
  wrapper.findComponent(KnowledgeFilePicker).vm.$emit('update:modelValue', files)
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('弹窗壳与表单交互', () => {
  it('opened 箭头与 header 插槽渲染（标题按 graph 分支）', async () => {
    const docWrapper = await mountDialog()
    expect(docWrapper.find('.kb-dialog-heading').text()).toContain(CK.title)
    docWrapper.unmount()

    const graphWrapper = await mountDialog({ graph: true })
    expect(graphWrapper.find('.kb-dialog-heading').text()).toContain(CK.titleGraph)
    graphWrapper.unmount()
  })

  it('取消按钮关闭弹窗（v-model 箭头）', async () => {
    const wrapper = await mountDialog()
    const cancel = wrapper.findAll('.test-dialog button').find(b => b.text().includes('取消'))
    await cancel.trigger('click')
    await flush()
    expect(wrapper.vm.open).toBe(false)
  })

  it('模型下拉 v-model：选择回写 form.model', async () => {
    const wrapper = await mountDialog()
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    // 第一个是模型下拉
    selects[0].vm.$emit('update:modelValue', 'bge-m3')
    await flush()
    expect(wrapper.vm.form.model).toBe('bge-m3')
  })
})

describe('参数错误文案与清除', () => {
  it('argErrorText：五档错误文案映射', async () => {
    const wrapper = await mountDialog({ graph: true })
    // 造一个算子错误集
    wrapper.vm.argErrors = {
      chunkSize: 'required',
      overlap: 'integer',
      a: 'chunkSizeRange',
      b: 'overlapRange',
      c: 'overlapLessThanChunkSize'
    }
    await flush()
    expect(wrapper.vm.argErrorText('chunkSize')).toBe(CK.argRequired)
    expect(wrapper.vm.argErrorText('overlap')).toBe(CK.argInteger)
    expect(wrapper.vm.argErrorText('a')).toBe(CK.argChunkSizeRange)
    expect(wrapper.vm.argErrorText('b')).toBe(CK.argOverlapRange)
    expect(wrapper.vm.argErrorText('c')).toBe(CK.argOverlapLessThanChunkSize)
    expect(wrapper.vm.argErrorText('unknown')).toBe('')

    // 清除
    wrapper.vm.clearArgError('chunkSize')
    await flush()
    expect(wrapper.vm.argErrors.chunkSize).toBeUndefined()
    // 空名 / 不存在的错误：不清不炸
    wrapper.vm.clearArgError('')
    wrapper.vm.clearArgError('unknown')
  })

  it('graphNameError：必填 / 长度 / 全空格与非法字符', async () => {
    const wrapper = await mountDialog({ graph: true })
    expect(wrapper.vm.graphNameError('')).toBe(CK.nameRequired)
    expect(wrapper.vm.graphNameError('一')).toBe(CK.graphNameValidation)
    expect(wrapper.vm.graphNameError('a'.repeat(31))).toBe(CK.graphNameValidation)
    expect(wrapper.vm.graphNameError('   ')).toBe(CK.graphNameValidation)
    expect(wrapper.vm.graphNameError('bad@@name')).toBe(CK.graphNameValidation)
    expect(wrapper.vm.graphNameError('合法名称')).toBe('')
  })
})

describe('校验器与提交闸门', () => {
  it('model 校验器：空值给必填错误', async () => {
    const wrapper = await mountDialog()
    let error = null
    wrapper.vm.rules.model[0].validator({}, '', e => { error = e })
    expect(error).toBeTruthy()
    expect(error.message).toBe(CK.modelRequired)
    wrapper.vm.rules.model[0].validator({}, 'bge-m3', e => { error = e })
    expect(error).toBeUndefined()
  })

  it('operatorId 校验器：graph 模式未选算子给必填错误', async () => {
    const wrapper = await mountDialog({ graph: true })
    let error = null
    wrapper.vm.rules.operatorId[0].validator({}, '', e => { error = e })
    expect(error).toBeTruthy()
    expect(error.message).toBe(CK.operatorRequired)
    // 非图模式放行
    const docWrapper = await mountDialog()
    docWrapper.vm.rules.operatorId[0].validator({}, '', e => { error = e })
    expect(error).toBeUndefined()
  })

  it('submit：提交中早退；无文件早退', async () => {
    const handler = vi.fn(async () => true)
    const wrapper = await mountDialog({ submitHandler: handler })
    // 无文件：直接返回
    await wrapper.vm.submit()
    expect(handler).not.toHaveBeenCalled()

    // 提交中：防重
    await addFiles(wrapper, [makeFile('a.txt')])
    wrapper.vm.submitting = true
    await wrapper.vm.submit()
    expect(handler).not.toHaveBeenCalled()
    wrapper.vm.submitting = false
  })

  it('表单校验不过：submit 提前返回（不发请求）', async () => {
    const handler = vi.fn(async () => true)
    const wrapper = await mountDialog({ submitHandler: handler })
    // 名字为空：validate 拦下
    await addFiles(wrapper, [makeFile('a.txt')])
    await wrapper.vm.submit()
    await flush()
    expect(handler).not.toHaveBeenCalled()
  })

  it('算子切换：schemaId/llm 按需加载、默认参数生成', async () => {
    const wrapper = await mountDialog({ graph: true })
    // EP Select 把 attrs 自己消费掉：用占位符识别算子下拉
    const operatorSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find(w => w.props('placeholder') === CK.operatorPlaceholder)
    expect(operatorSelect, '未找到算子下拉').toBeTruthy()
    operatorSelect.vm.$emit('update:modelValue', OPERATOR.id)
    await flush()
    // EP 的 change 只在用户交互时发；程序化更新走 change 处理器直调
    await wrapper.vm.handleOperatorChange()
    await flush()
    // 默认参数已生成
    expect(wrapper.vm.params.chunkSize).toBe(2048)
    expect(wrapper.vm.params.extractionProfile).toBe('general')
    // schemaId / llm 清单按需加载
    expect(wrapper.vm.templates).toHaveLength(TEMPLATES.length)
    expect(wrapper.vm.llmModels).toHaveLength(LLMS.length)
    // 再换同一个算子：参数清空重建
    wrapper.vm.handleOperatorChange()
    await flush()
    expect(wrapper.vm.params.chunkSize).toBe(2048)

    // 清空清单后再切：schemaId / llm 按需加载分支
    wrapper.vm.templates = []
    wrapper.vm.llmModels = []
    await wrapper.vm.handleOperatorChange()
    await flush()
    expect(wrapper.vm.templates).toHaveLength(TEMPLATES.length)
    expect(wrapper.vm.llmModels).toHaveLength(LLMS.length)
  })

  it('graph 提交：名字非法被名称校验拦下；参数校验失败就地挡下', async () => {
    const handler = vi.fn(async () => true)
    const wrapper = await mountDialog({ graph: true, submitHandler: handler })
    await addFiles(wrapper, [makeFile('a.txt')])
    // 名字太短：名称校验器（graph 分支）报错，submit 在表单校验处拦下
    await wrapper.find('input[maxlength="30"]').setValue('a')
    await wrapper.vm.submit()
    await flush()
    expect(handler).not.toHaveBeenCalled()

    // 名字合法但参数非法（llm 置空）：validateBuildParams 挡在 submitHandler 前
    await wrapper.find('input[maxlength="30"]').setValue('合法图谱名')
    wrapper.vm.form.model = 'bge-m3'
    wrapper.vm.form.operatorId = OPERATOR.id
    await wrapper.vm.handleOperatorChange() // 选中算子后按 args 重建参数
    await flush()
    wrapper.vm.params.llm = '' // 置空必填参数：validateBuildParams 就地挡下
    await wrapper.vm.submit()
    await flush()
    expect(Object.keys(wrapper.vm.argErrors).length).toBeGreaterThan(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it('关闭弹窗：复位表单与参数', async () => {
    const wrapper = await mountDialog({ graph: true })
    wrapper.vm.form.name = '临时名'
    await wrapper.setProps({ modelValue: false })
    await flush()
    // 复位链路走完不炸即可（params 清空、operatorArgs 清空）
    expect(wrapper.vm.operatorArgs).toEqual([])
  })
})
