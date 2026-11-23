// @vitest-environment jsdom
// 「新建知识检索」弹窗（CreateWorkflowDialog.vue）的残余分支（与 createWorkflowDialog.spec.js 互补）：
// - 来源选择校验三条错误（未选 / 未知 id / 已禁用选项）；
// - 无 submitHandler 的 emit 链、submitHandler 成功/失败、名称判重拦提交；
// - 切来源类型时清空已选的提示（sourceNotice）与清空后不提示；
// - 键盘移动 radiogroup（ArrowRight/Home/End，无关按键忽略）；
// - 顺序检索模板的预览说明与 footer 提示的已选文案。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

import { flush, mountWithPlugins } from './helpers/mount'
import { h } from 'vue'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import CreateWorkflowDialog from '@/features/workflow/components/CreateWorkflowDialog.vue'
import RetrievalSourceSelect from '@/features/workflow/components/RetrievalSourceSelect.vue'
import zhDialogs from '@/app/i18n/zh/studioDialogs'

const CW = zhDialogs.createWorkflow

/** el-dialog 透传件：StudioDialog 的 actions 挂在 #footer 上，占位件不渲染 footer。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title'],
  setup (props, { slots }) {
    return () => h('div', { class: 'test-dialog' }, [
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
    ])
  }
}

const GLOBAL = { components: { ElDialog: DialogPassthrough, ElForm, ElFormItem } }

const KB_OPTIONS = [
  { id: 'doc-1', name: '产品手册库', statusLabel: '未发布', isGraph: false, isStruct: false },
  { id: 'doc-2', name: '停用库', statusLabel: '未发布', isGraph: false, isStruct: false, disabled: true }
]

async function mountDialog (props = {}) {
  const wrapper = await mountWithPlugins(CreateWorkflowDialog, {
    props: { modelValue: false, knowledgeOptions: KB_OPTIONS, ...props },
    global: GLOBAL
  })
  await wrapper.setProps({ modelValue: true })
  await flush()
  await flush()
  return wrapper
}

function radiosOf (wrapper, label) {
  return wrapper.find(`[role="radiogroup"][aria-label="${label}"]`).findAll('[role="radio"]')
}

async function pickSources (wrapper, ids) {
  wrapper.findComponent(RetrievalSourceSelect).vm.$emit('update:modelValue', ids)
  await flush()
}

async function fillName (wrapper, value) {
  await wrapper.find('input[maxlength="50"]').setValue(value)
  await flush()
}

async function clickSubmit (wrapper) {
  const button = wrapper.findAll('button').find(b => b.text().includes(CW.submit))
  await button.trigger('click')
  await flush()
  await flush()
}

function formItemState (wrapper, prop) {
  const item = wrapper.findAllComponents(ElFormItem).find(i => i.props('prop') === prop)
  return item ? [item.vm.validateState, item.vm.validateMessage] : null
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('来源选择校验（sourceIds validator）', () => {
  it('未选来源：sourceMissing；未知 id：sourceUnavailableItem（带 id）', async () => {
    const wrapper = await mountDialog()
    await fillName(wrapper, '合法名称')
    await pickSources(wrapper, [])
    await clickSubmit(wrapper)
    const missing = formItemState(wrapper, 'sourceIds')
    expect(missing[0]).toBe('error')
    expect(missing[1]).toBe(CW.sourceMissing.replace('{kind}', '文档知识库'))

    await pickSources(wrapper, ['ghost-id'])
    await clickSubmit(wrapper)
    const ghost = formItemState(wrapper, 'sourceIds')
    expect(ghost[1]).toBe(CW.sourceUnavailableItem.replace('{name}', 'ghost-id').replace('{kind}', '文档知识库'))
  })

  it('选中已禁用的库：错误文案用库名', async () => {
    const wrapper = await mountDialog()
    await fillName(wrapper, '合法名称')
    await pickSources(wrapper, ['doc-2'])
    await clickSubmit(wrapper)
    const state = formItemState(wrapper, 'sourceIds')
    expect(state[1]).toBe(CW.sourceUnavailableItem.replace('{name}', '停用库').replace('{kind}', '文档知识库'))
  })
})

describe('提交链', () => {
  it('无 submitHandler：合法表单 emit create（含 sourceNames），弹窗关闭', async () => {
    const wrapper = await mountDialog()
    await fillName(wrapper, '  我的检索  ')
    await pickSources(wrapper, ['doc-1'])
    await clickSubmit(wrapper)

    const emitted = wrapper.emitted('create')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toMatchObject({
      name: '我的检索',
      sourceType: 'knowledge',
      template: 'Blended',
      sourceIds: ['doc-1'],
      sourceNames: ['产品手册库']
    })
    // 成功后关闭
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('名称与已有工作流重复：拦截提交（uniqueNameRule）', async () => {
    const wrapper = await mountDialog({ existing: [{ name: '已有流' }] })
    await fillName(wrapper, '已有流')
    await pickSources(wrapper, ['doc-1'])
    await clickSubmit(wrapper)
    const name = formItemState(wrapper, 'name')
    expect(name[0]).toBe('error')
    expect(name[1]).toBe(CW.nameDuplicate)
    expect(wrapper.emitted('create')).toBeUndefined()
  })

  it('submitHandler 成功：收到 payload 后关弹窗', async () => {
    const handler = vi.fn(async () => ({}))
    const wrapper = await mountDialog({ submitHandler: handler })
    await fillName(wrapper, '走处理器')
    await pickSources(wrapper, ['doc-1'])
    await clickSubmit(wrapper)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].name).toBe('走处理器')
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('submitHandler 失败：弹窗保持打开，可再次提交', async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({})
    const wrapper = await mountDialog({ submitHandler: handler })
    await fillName(wrapper, '会失败的')
    await pickSources(wrapper, ['doc-1'])
    await clickSubmit(wrapper)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await clickSubmit(wrapper)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })

  it('双击防重：请求在飞时第二次点击直接返回（只发一次）', async () => {
    let resolveHandler
    const handler = vi.fn(() => new Promise(resolve => { resolveHandler = resolve }))
    const wrapper = await mountDialog({ submitHandler: handler })
    await fillName(wrapper, '防重检验')
    await pickSources(wrapper, ['doc-1'])

    await clickSubmit(wrapper)
    await clickSubmit(wrapper) // 请求在飞：被 submitting 挡住
    expect(handler).toHaveBeenCalledTimes(1)

    resolveHandler({})
    await flush()
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })
})

describe('切换来源类型的提示（sourceNotice）', () => {
  it('已选过来源再切换：提示被清除的数量与新旧类型、新模板', async () => {
    const wrapper = await mountDialog()
    await pickSources(wrapper, ['doc-1'])
    await radiosOf(wrapper, CW.sourceTypeLabel)[1].trigger('click') // 切到图谱
    await flush()

    const notice = wrapper.find('.workflow-source-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe(CW.sourceNotice
      .replace('{kind}', '图谱知识库')
      .replace('{count}', '1')
      .replace('{previous}', '文档知识库')
      .replace('{template}', '图谱检索'))
    // 来源下拉跟着清空
    expect(wrapper.findComponent(RetrievalSourceSelect).props('modelValue')).toEqual([])
  })

  it('没选过来源就切换：不提示', async () => {
    const wrapper = await mountDialog()
    await radiosOf(wrapper, CW.sourceTypeLabel)[1].trigger('click')
    await flush()
    expect(wrapper.find('.workflow-source-notice').exists()).toBe(false)
  })

  it('切回同一类型：直接返回，不产生提示', async () => {
    const wrapper = await mountDialog()
    await pickSources(wrapper, ['doc-1'])
    await radiosOf(wrapper, CW.sourceTypeLabel)[0].trigger('click') // 已是 knowledge
    await flush()
    expect(wrapper.findComponent(RetrievalSourceSelect).props('modelValue')).toEqual(['doc-1'])
  })
})

describe('radiogroup 的键盘操作（moveChoice）', () => {
  it('ArrowRight / Home / End 移动选中并聚焦；无关按键忽略', async () => {
    const wrapper = await mountDialog()
    const types = radiosOf(wrapper, CW.sourceTypeLabel)
    expect(types[0].classes()).toContain('selected')

    // 无关按键：无变化、不聚焦
    await types[0].trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).not.toBe(types[1].element)

    // ArrowRight：从第 0 个到第 1 个
    await types[0].trigger('keydown', { key: 'ArrowRight' })
    await flush()
    expect(radiosOf(wrapper, CW.sourceTypeLabel)[1].classes()).toContain('selected')

    // End：直接到最后一个（2 个来源 → 回到第 1 个）
    await radiosOf(wrapper, CW.sourceTypeLabel)[0].trigger('keydown', { key: 'End' })
    await flush()
    expect(radiosOf(wrapper, CW.sourceTypeLabel)[1].classes()).toContain('selected')

    // Home：回到第 0 个
    await radiosOf(wrapper, CW.sourceTypeLabel)[1].trigger('keydown', { key: 'Home' })
    await flush()
    expect(radiosOf(wrapper, CW.sourceTypeLabel)[0].classes()).toContain('selected')
  })

  it('模板 radiogroup 同样支持键盘：End 选中「条件检索」', async () => {
    const wrapper = await mountDialog()
    const templates = radiosOf(wrapper, CW.template)
    await templates.at(-1).trigger('keydown', { key: 'End' })
    await flush()
    expect(radiosOf(wrapper, CW.template)[2].classes()).toContain('selected')
    expect(radiosOf(wrapper, CW.template)[2].attributes('aria-checked')).toBe('true')
  })
})

describe('footer 提示与顺序检索预览', () => {
  it('未选来源：hintEmpty；选了来源：hintSelected（类型/数量/模板）', async () => {
    const wrapper = await mountDialog()
    expect(wrapper.text()).toContain(CW.hintEmpty)

    await pickSources(wrapper, ['doc-1'])
    expect(wrapper.text()).toContain(CW.hintSelected
      .replace('{type}', '文档知识库')
      .replace('{count}', '1')
      .replace('{template}', '混合检索'))
  })

  it('顺序检索模板：预览出现「按选择顺序」说明；切回混合后说明消失', async () => {
    const wrapper = await mountDialog()
    const templates = radiosOf(wrapper, CW.template)
    await templates[1].trigger('click') // Sequential
    await flush()
    expect(wrapper.find('.workflow-preview-note').text()).toBe(CW.previewSequentialNote)

    await templates[0].trigger('click') // 回到 Blended
    await flush()
    expect(wrapper.find('.workflow-preview-note').exists()).toBe(false)
  })
})
