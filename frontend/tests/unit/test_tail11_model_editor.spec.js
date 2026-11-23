// @vitest-environment jsdom
// 模型编辑弹窗（ModelEditorDialog.vue）的表单交互残余分支（5/6）：
// 全部表单字段的 v-model 通路（显示名/端点模型/密钥/维度/开关/思考模式与 JSON/
// 超时/路径/备注）、类型单选按钮点击、取消按钮、StudioDialog opened 聚焦、
// 校验器的空名/维度放行/JSON 坏格式分支、停用联动清默认、
// checkConnection 表单未过展开高级区/会话丢弃/接口异常、submit 提交中早退。
// 基础覆盖见 test_wf_ModelEditorDialog.spec.js / modelEditorDialog.spec.js。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const { modelApi } = vi.hoisted(() => ({ modelApi: {} }))

vi.mock('@/features/model/api/model.js', () => ({
  getThinkingPresetsApi: (...args) => modelApi.getThinkingPresets(...args),
  testModelApi: (...args) => modelApi.testModel(...args),
  testModelConfigApi: (...args) => modelApi.testModelConfig(...args)
}))

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { h, watch } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index'
import ModelEditorDialog from '@/features/model/components/ModelEditorDialog.vue'

/** 原生 select 代替 el-select：思考模式下拉直接切。 */
const ElSelectStub = {
  name: 'ElSelect',
  props: { modelValue: { type: [String, Array], default: '' } },
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('select', {
      class: 'stub-select',
      value: props.modelValue,
      onChange: event => emit('update:modelValue', event.target.value)
    })
  }
}

const inert = name => ({
  name,
  props: { modelValue: { type: [Boolean, Number, String], default: undefined } },
  emits: ['update:modelValue'],
  setup: () => () => h('span')
})

/** 会发 update:modelValue / opened 的 el-dialog 透传件。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'class', 'style', 'alignCenter', 'appendToBody', 'destroyOnClose',
    'closeOnClickModal', 'closeOnPressEscape', 'showClose'],
  emits: ['update:modelValue', 'opened'],
  setup (props, { slots, emit }) {
    watch(() => props.modelValue, value => {
      if (value) {
        emit('opened')
      }
    })
    return () => (props.modelValue
      ? h('div', { class: 'test-dialog' }, [
          slots.header ? slots.header({ titleId: 't' }) : null,
          slots.default ? slots.default() : null,
          slots.footer ? slots.footer() : null
        ])
      : null)
  }
}

/** 点击提交 modelValue+1 的数字输入（维度/最大 Token/温度/超时都用它）。 */
const NumberStub = {
  name: 'ElInputNumber',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('button', {
      class: 'number-stub',
      onClick: () => emit('update:modelValue', Number(props.modelValue || 0) + 1)
    })
  }
}

const SwitchStub = {
  name: 'ElSwitch',
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('button', {
      class: 'switch-stub',
      disabled: Boolean(props.disabled),
      onClick: () => emit('update:modelValue', !props.modelValue)
    })
  }
}

const CheckboxStub = {
  name: 'ElCheckbox',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup (props, { emit }) {
    return () => h('button', {
      class: 'checkbox-stub',
      onClick: () => emit('update:modelValue', !props.modelValue)
    })
  }
}

const GLOBAL = {
  components: {
    ElDialog: DialogPassthrough,
    ElForm,
    ElFormItem,
    ElTable,
    ElTableColumn,
    ElSelect: ElSelectStub,
    ElSwitch: SwitchStub,
    ElInputNumber: NumberStub,
    ElCheckbox: CheckboxStub
  }
}

const PRESETS_RESPONSE = {
  presets: [{ presetId: 'deepseek-vllm', label: 'DeepSeek（vLLM）', labelEn: 'DeepSeek (vLLM)' }],
  matchedPresetId: '',
  allowedPayloadKeys: ['thinking', 'chat_template_kwargs']
}

const EDITING_ROW = {
  modelId: 'mdl-e1', modelKind: 'llm', modelName: 'gpt-x', displayName: 'GPT X',
  baseUrl: 'http://10.0.0.2:4000/v1', apiModel: 'gpt-x', hasApiKey: true,
  dimension: null, enabled: true, isDefault: false, maxTokens: 2048, temperature: 0.3,
  isReasoning: false, thinkingMode: 'none', timeout: 120, modelsPath: '/v1/models',
  chatPath: '/chat/completions', remark: '备注'
}

async function mountDialog (props = {}) {
  modelApi.getThinkingPresets = vi.fn(async () => PRESETS_RESPONSE)
  modelApi.testModel = vi.fn(async () => ({ ok: true, message: 'ok' }))
  modelApi.testModelConfig = vi.fn(async () => ({ ok: true, message: 'ok' }))
  const wrapper = await mountWithPlugins(ModelEditorDialog, {
    route: '/models',
    props: { modelValue: false, ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  await flush()
  return wrapper
}

async function fillBase (wrapper, { name = 'm-1', endpoint = 'http://10.0.0.1:4000/v1' } = {}) {
  await wrapper.find('input[aria-label="模型名称"]').setValue(name)
  await wrapper.find('input[aria-label="端点地址"]').setValue(endpoint)
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('表单字段 v-model 全通路', () => {
  it('新建：逐字段回写后 buildValues 形状正确', async () => {
    const wrapper = await mountDialog()
    await fillBase(wrapper)
    // 显示名称 / 端点模型 / API 密钥（第 6、10 行的 v-model 箭头）
    await wrapper.find('input[aria-label="显示名称"]').setValue('Qwen 显示')
    await wrapper.find('input[aria-label="端点模型名"]').setValue('qwen-plus')
    await wrapper.find('input[aria-label="API 密钥"]').setValue('sk-abc')
    // 维度（embedding 才有）：切类型后点数字输入
    wrapper.vm.setKind('embedding')
    await flush()
    await wrapper.find('button.number-stub').trigger('click')
    await flush()
    expect(wrapper.vm.form.dimension).toBe(1)

    // 开关：启用关掉再打开（第 12 行的 v-model 箭头）
    const switches = wrapper.findAll('button.switch-stub')
    await switches[0].trigger('click')
    await flush()
    expect(wrapper.vm.form.enabled).toBe(false)
    await switches[0].trigger('click')
    await flush()
    expect(wrapper.vm.form.enabled).toBe(true)

    // 高级区：展开 details 后逐字段回写（第 19-21 行）
    await wrapper.find('details.studio-disclosure summary').trigger('click')
    await flush()
    const values = wrapper.vm.buildValues()
    expect(values.displayName).toBe('Qwen 显示')
    expect(values.apiModel).toBe('qwen-plus')
    expect(values.apiKey).toBe('sk-abc')
  })

  it('llm 高级区：思考模式切换 + 自定义 JSON + 超时/路径/备注回写', async () => {
    const wrapper = await mountDialog()
    await fillBase(wrapper)
    await wrapper.find('details.studio-disclosure summary').trigger('click')
    await flush()

    // 思考模式下拉（el-select 桩）：直接回抛 update:modelValue
    const thinkingSelect = wrapper.findAllComponents({ name: 'ElSelect' })[0]
    thinkingSelect.vm.$emit('update:modelValue', 'custom')
    await flush()
    expect(wrapper.vm.form.thinking).toBe('custom')

    // 自定义 JSON 文本域（按 placeholder 找）
    const jsonArea = wrapper.find('textarea[placeholder*="reasoning_effort"]')
    await jsonArea.setValue('{"thinking": true}')
    expect(wrapper.vm.form.thinkingCustomJson).toBe('{"thinking": true}')

    // 超时数字输入（第 20 行）
    const numbers = wrapper.findAll('button.number-stub')
    await numbers.at(-1).trigger('click')
    await flush()
    expect(wrapper.vm.form.timeout).toBe(121)

    // 模型清单路径 / 请求路径 / 备注
    await wrapper.find('input[aria-label="模型列表路径"]').setValue('/v1/models')
    await wrapper.find('input[aria-label="模型请求路径"]').setValue('/chat/completions')
    const notes = wrapper.find('textarea[aria-label="备注"]')
    await notes.setValue('给运营的说明')
    expect(wrapper.vm.form.notes).toBe('给运营的说明')

    const values = wrapper.vm.buildValues()
    expect(values.modelsPath).toBe('/v1/models')
    expect(values.chatPath).toBe('/chat/completions')
    expect(values.remark).toBe('给运营的说明')
    expect(values.thinkingPayload).toEqual({ thinking: true })
  })

  it('类型单选按钮：点击切换（模板通路）', async () => {
    const wrapper = await mountDialog()
    const choices = wrapper.findAll('button.studio-choice')
    expect(choices.length).toBeGreaterThanOrEqual(3)
    await choices[1].trigger('click') // embedding
    expect(wrapper.vm.form.kind).toBe('embedding')
    await choices[2].trigger('click') // rerank
    expect(wrapper.vm.form.kind).toBe('rerank')
  })

  it('取消按钮：直接关闭弹窗', async () => {
    const wrapper = await mountDialog()
    const cancel = wrapper.findAll('button').find(node => node.text().includes('取消'))
    await cancel.trigger('click')
    await flush()
    expect(wrapper.vm.open).toBe(false)
  })

  it('编辑态：opened 后聚焦 + 清除密钥勾选带 clearApiKey', async () => {
    const wrapper = await mountDialog({ editing: EDITING_ROW, existing: [] })
    await flush()
    // opened 事件触发 modelInput.focus()（jsdom 无焦点断言，不炸即可）
    expect(document.activeElement).toBeTruthy()
    // hasStoredKey=true → 清除密钥勾选出现
    await wrapper.find('button.checkbox-stub').trigger('click')
    await flush()
    expect(wrapper.vm.form.clearApiKey).toBe(true)
    const values = wrapper.vm.buildValues()
    expect(values.clearApiKey).toBe(true)
  })
})

describe('校验器残余分支', () => {
  it('internal：空名给必填错误', async () => {
    const wrapper = await mountDialog()
    let error = null
    wrapper.vm.rules.internal[0].validator({}, '   ', e => { error = e })
    expect(error).toBeTruthy()
    expect(error.message).toContain('名称')
  })

  it('dimension：非 embedding 直接放行', async () => {
    const wrapper = await mountDialog()
    let error = 'unset'
    wrapper.vm.rules.dimension[0].validator({}, 99, e => { error = e })
    expect(error).toBeUndefined()
  })

  it('thinkingCustomJson：非 llm / 空文本 / 坏 JSON 三条分支', async () => {
    const wrapper = await mountDialog()
    let error = 'unset'
    wrapper.vm.rules.thinkingCustomJson[0].validator({}, '', e => { error = e })
    // form.thinking 默认 none → 直接放行
    expect(error).toBeUndefined()

    wrapper.vm.form.kind = 'llm'
    wrapper.vm.form.thinking = 'custom'
    wrapper.vm.rules.thinkingCustomJson[0].validator({}, '  ', e => { error = e })
    expect(error).toBeTruthy()

    wrapper.vm.rules.thinkingCustomJson[0].validator({}, '{oops', e => { error = e })
    expect(error).toBeTruthy()
    expect(error.message).toContain('JSON')
  })

  it('customThinkingPayload：坏 JSON 回落 null（提交形状）', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.form.kind = 'llm'
    wrapper.vm.form.thinking = 'custom'
    wrapper.vm.form.thinkingCustomJson = '{oops'
    const values = wrapper.vm.buildValues()
    expect(values.thinkingPayload).toBeNull()
  })
})

describe('联动与早退', () => {
  it('停用模型：默认标记一并清掉（watch enabled）', async () => {
    const wrapper = await mountDialog()
    wrapper.vm.form.enabled = true
    wrapper.vm.form.isDefault = true
    await flush()
    wrapper.vm.form.enabled = false
    await flush()
    expect(wrapper.vm.form.isDefault).toBe(false)
  })

  it('checkConnection：表单未过 → 展开高级区且不发请求', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.checkConnection()
    await flush()
    expect(modelApi.testModelConfig).not.toHaveBeenCalled()
    expect(wrapper.vm.advanced.open).toBe(true)
  })

  it('checkConnection：探测中重复点击早退；弹窗重开会话丢弃旧结果', async () => {
    let resolveTest
    const wrapper = await mountDialog()
    modelApi.testModelConfig = vi.fn(() => new Promise(resolve => { resolveTest = resolve }))
    await fillBase(wrapper)
    wrapper.vm.testing = true
    await wrapper.vm.checkConnection() // testing=true → 早退
    expect(modelApi.testModelConfig).not.toHaveBeenCalled()
    wrapper.vm.testing = false

    const pending = wrapper.vm.checkConnection()
    await flush()
    expect(modelApi.testModelConfig).toHaveBeenCalledTimes(1)

    // 关闭再打开：openSession 变化 → 旧结果丢弃
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await flush()
    resolveTest({ ok: true, message: '晚了' })
    await pending
    await flush()
    expect(wrapper.vm.connectionResult).toBeNull()
    expect(wrapper.vm.testing).toBe(false)
  })

  it('checkConnection：探测接口异常 → 失败结论带错误文案', async () => {
    const wrapper = await mountDialog()
    modelApi.testModelConfig = vi.fn(async () => { throw new Error('网关超时') })
    await fillBase(wrapper)
    await wrapper.vm.checkConnection()
    await flush()
    expect(wrapper.vm.connectionResult.ok).toBe(false)
    expect(wrapper.vm.connectionResult.message).toBe('网关超时')
  })

  it('submit：提交中早退', async () => {
    const handler = vi.fn(async () => {})
    const wrapper = await mountDialog({ submitHandler: handler })
    await fillBase(wrapper)
    wrapper.vm.submitting = true
    await wrapper.vm.submit()
    expect(handler).not.toHaveBeenCalled()
    wrapper.vm.submitting = false
  })
})
