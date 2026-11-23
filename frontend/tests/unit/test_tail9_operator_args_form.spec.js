// @vitest-environment jsdom
/**
 * OperatorArgsForm.vue（图谱构建的算子联动参数表单）—— 按 `operatorArgs` 逐项
 * 渲染不同控件：schemaId/llm/extractionProfile 走下拉，overlap/chunkSize 与
 * 「数字型」参数走数字框，其余走文本框；所有交互只做一件事：把新值合并后
 * `update:dynamicParams` 抛给父级。这里逐臂触发 + 断言合并结果。
 *
 * el-select / el-input-number 用替身（jsdom 里真 select 要开弹层），change 事件
 * 通过组件实例 `$emit` 直发；el-input 用真件（setValue 即可触发 update:modelValue）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import OperatorArgsForm from '@/features/graph/components/OperatorArgsForm.vue'

/** 下拉替身：只渲染插槽，测试里经 vm.$emit 直发 update:modelValue / change。 */
const SelectStub = {
  name: 'SelectStub',
  props: { modelValue: { type: null, default: '' }, placeholder: String, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  template: '<div class="ops-stub-select"><slot /></div>'
}

/** 数字框替身：同上。 */
const NumberStub = {
  name: 'NumberStub',
  props: { modelValue: { type: null, default: 0 }, min: Number, max: Number, placeholder: String },
  emits: ['update:modelValue'],
  template: '<div class="ops-stub-number" />'
}

function mounts () {
  return {
    global: {
      components: { ElForm, ElFormItem, ElInput, ElSelect: SelectStub, ElInputNumber: NumberStub },
      stubs: { transition: false, 'transition-group': false }
    },
    router: null
  }
}

/** 一组覆盖全部渲染分支的算子参数。 */
const ARGS = [
  { argName: 'schemaId', description: '知识图谱模版' },
  { argName: 'llm', description: '大模型' },
  { argName: 'extractionProfile' }, // 无 description → 回落本地化词条
  { argName: 'overlap', defaultValue: '128' },
  { argName: 'chunkSize', defaultValue: '1024' },
  { argName: 'windowSize', type: 'number', defaultValue: '7' },
  { argName: 'customPrompt', description: '自定义提示', defaultValue: '' }
]

const TEMPLATES = [
  { schemaId: 'tpl-a', schemaName: '影视模版' },
  { id: 'tpl-b', name: '合同模版' }
]

async function mountForm (props = {}) {
  return mountWithPlugins(OperatorArgsForm, {
    ...mounts(),
    props: {
      operatorArgs: ARGS,
      dynamicParams: {},
      schemaInfo: null,
      templateNotFound: false,
      currentOperator: null,
      templateList: TEMPLATES,
      llmModelList: [{ value: 'gpt-x', label: 'GPT-X' }, { id: 'm2', name: 'Qwen' }],
      ...props
    }
  })
}

const selects = wrapper => wrapper.findAllComponents(SelectStub)
const numbers = wrapper => wrapper.findAllComponents(NumberStub)

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('渲染分支', () => {
  it('七个参数渲染：3 个下拉 + 3 个数字框 + 1 个文本框', async () => {
    const wrapper = await mountForm()
    expect(wrapper.text()).toContain('知识图谱模版')
    expect(wrapper.text()).toContain('LLM模型')
    // 无 description 的 extractionProfile 回落本地化词条
    expect(wrapper.text()).toContain('抽取模式')
    expect(selects(wrapper)).toHaveLength(3)
    expect(numbers(wrapper)).toHaveLength(3)
    expect(wrapper.findAll('.el-input').length).toBe(1)
  })

  it('schemaId：schemaInfo 存在时插入当前模版选项且下拉被禁用', async () => {
    const wrapper = await mountForm({
      schemaInfo: { schema_id: 'tpl-cur', schema_name: '当前模版' },
      currentOperator: { id: 'op-1' },
      dynamicParams: { schemaId: 'tpl-cur' }
    })
    const options = selects(wrapper)[0].findAllComponents({ name: 'ElOption' })
    expect(options).toHaveLength(3)
    expect(options[0].vm.$attrs.label).toBe('当前模版')
    expect(selects(wrapper)[0].props('disabled')).toBeTruthy()
  })

  it('templateNotFound：占位文案切换为「未找到模版」提示', async () => {
    const wrapper = await mountForm({ templateNotFound: true })
    expect(selects(wrapper)[0].props('placeholder')).toBe('模版不存在')
  })

  it('llm 下拉：label 取 label/name/value 的第一优先', async () => {
    const wrapper = await mountForm({
      llmModelList: [{ value: 'v1' }, { id: 'i2', name: 'n2' }, { k: 3 }]
    })
    const options = selects(wrapper)[1].findAllComponents({ name: 'ElOption' })
    // 3 个 llm 选项（第三个没有可显示字段，label 渲染为空）
    expect(options.length).toBe(3)
    expect(options[0].vm.$attrs.value).toBe('v1')
    expect(options[1].vm.$attrs.value).toBe('i2')
  })
})

describe('交互 → update:dynamicParams', () => {
  it('schemaId 下拉变更：合并 schemaId 抛出', async () => {
    const wrapper = await mountForm()
    selects(wrapper)[0].vm.$emit('update:modelValue', 'tpl-b')
    await flush()
    expect(wrapper.emitted('update:dynamicParams')[0][0]).toEqual({ schemaId: 'tpl-b' })
  })

  it('llm 下拉变更：合并 llm 抛出', async () => {
    const wrapper = await mountForm({ dynamicParams: { schemaId: 'tpl-a' } })
    selects(wrapper)[1].vm.$emit('update:modelValue', 'gpt-x')
    await flush()
    expect(wrapper.emitted('update:dynamicParams')[0][0]).toEqual({ schemaId: 'tpl-a', llm: 'gpt-x' })
  })

  it('extractionProfile 下拉变更：走 handleTextInput 合并', async () => {
    const wrapper = await mountForm()
    selects(wrapper)[2].vm.$emit('update:modelValue', 'general_attributes')
    await flush()
    expect(wrapper.emitted('update:dynamicParams')[0][0]).toEqual({ extractionProfile: 'general_attributes' })
  })

  it('overlap / chunkSize / 通用数字参数：三路 handleNumberInput', async () => {
    const wrapper = await mountForm({ dynamicParams: { overlap: 256 } })

    numbers(wrapper)[0].vm.$emit('update:modelValue', 512)
    numbers(wrapper)[1].vm.$emit('update:modelValue', 2048)
    numbers(wrapper)[2].vm.$emit('update:modelValue', 9)
    await flush()

    const emissions = wrapper.emitted('update:dynamicParams')
    expect(emissions[0][0]).toEqual({ overlap: 512 })
    expect(emissions[1][0]).toEqual({ overlap: 256, chunkSize: 2048 })
    expect(emissions[2][0]).toEqual({ overlap: 256, windowSize: 9 })
  })

  it('普通文本参数：真 el-input 输入即合并（含已有值保留）', async () => {
    const wrapper = await mountForm({ dynamicParams: { customPrompt: '默认提示' } })
    await wrapper.find('.el-input__inner').setValue('改过的提示')
    expect(wrapper.emitted('update:dynamicParams')[0][0]).toEqual({ customPrompt: '改过的提示' })
  })

  it('模型列表条目缺 value/id 时 value 回落 undefined 仍可发出', async () => {
    const wrapper = await mountForm({ llmModelList: [{ label: '仅标签' }] })
    selects(wrapper)[1].vm.$emit('update:modelValue', 'whatever')
    await flush()
    expect(wrapper.emitted('update:dynamicParams')[0][0]).toEqual({ llm: 'whatever' })
  })
})
