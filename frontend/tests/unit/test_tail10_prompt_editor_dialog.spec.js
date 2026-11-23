// @vitest-environment jsdom
/**
 * PromptEditorDialog.vue（workflow 高级展开里的「编辑提示词」弹窗）—— 全量补齐。
 *
 * el-dialog 用「modelValue 为真时渲染默认 + footer 插槽」的透传桩：
 * 组件的所有可见行为都在这两个插槽里（文案、字数、两个按钮）。
 * 钉住：
 * - draft 初始取 props.text；modelValue 从 false→true（或 text 变化）时重新灌入；
 *   modelValue=false 期间改 text 不回灌（watch 里 `if (props.modelValue)` 守卫）；
 * - cancel 只发 update:modelValue=false；confirm 先发 confirm(draft) 再关；
 * - footer 的字数徽标与按钮文案来自 i18n 真词条。
 */
import { describe, expect, it } from 'vitest'
import { h } from 'vue'

import { flush, mountWithPlugins } from './helpers/mount'

import PromptEditorDialog from '@/features/workflow/PromptEditorDialog.vue'

const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'appendToBody', 'destroyOnClose', 'closeOnClickModal'],
  emits: ['update:modelValue'],
  setup (props, { slots }) {
    return () => (props.modelValue
      ? h('div', { class: 'test-dialog' }, [
        slots.default ? slots.default() : null,
        slots.footer ? slots.footer() : null
      ])
      : null)
  }
}

async function mountDialog (props = {}) {
  const wrapper = await mountWithPlugins(PromptEditorDialog, {
    router: null,
    props: { modelValue: false, text: '', subtitle: '', ...props },
    global: { components: { ElDialog: DialogPassthrough } }
  })
  return wrapper
}

async function open (wrapper, props = {}) {
  await wrapper.setProps({ modelValue: true, ...props })
  await flush()
}

describe('PromptEditorDialog', () => {
  it('关闭时不渲染任何内容', async () => {
    const wrapper = await mountDialog({ text: 'abc' })
    expect(wrapper.find('.test-dialog').exists()).toBe(false)
  })

  it('打开后 draft 灌入 props.text，footer 显示字数与两个按钮', async () => {
    const wrapper = await mountDialog({ text: '你好世界', subtitle: '提示词说明' })
    await open(wrapper)

    expect(wrapper.find('.test-dialog').exists()).toBe(true)
    expect(wrapper.find('.fc-expanded-intro').text()).toBe('提示词说明')
    // 正文进 textarea（真 ElInput 由 helpers 注册）
    const textarea = wrapper.find('textarea')
    expect(textarea.element.value).toBe('你好世界')
    // 字数徽标：i18n 词条「{count} 个字符」
    expect(wrapper.find('.fc-expanded-count').text()).toContain('4')
    expect(wrapper.findAll('button').map(b => b.text().trim())).toEqual(['取消', '完成编辑'])
  })

  it('重新打开时按最新 text 重灌 draft', async () => {
    const wrapper = await mountDialog({ text: 'v1' })
    await open(wrapper)
    await wrapper.find('textarea').setValue('用户改过的草稿')
    // 关闭 → 改 text → 再开：草稿被 props.text 覆盖
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ text: 'v2' })
    await open(wrapper)
    expect(wrapper.find('textarea').element.value).toBe('v2')
  })

  it('关闭状态下 text 变化不回灌 draft（再开时才灌）', async () => {
    const wrapper = await mountDialog({ text: 'first' })
    await open(wrapper)
    await wrapper.find('textarea').setValue('草稿')
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ text: 'second' })
    await flush()
    // 组件自己不渲染，draft 保持原值：再开时应看到 second 而不是「草稿」
    await open(wrapper)
    expect(wrapper.find('textarea').element.value).toBe('second')
  })

  it('cancel：只发 update:modelValue=false，不发 confirm', async () => {
    const wrapper = await mountDialog({ text: 'x' })
    await open(wrapper)
    await wrapper.findAll('button').find(b => b.text().includes('取消')).trigger('click')
    await flush()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('confirm：把当前 draft 发给 confirm 并关闭', async () => {
    const wrapper = await mountDialog({ text: 'x' })
    await open(wrapper)
    await wrapper.find('textarea').setValue('最终提示词')
    await wrapper.findAll('button').find(b => b.text().includes('完成编辑')).trigger('click')
    await flush()
    expect(wrapper.emitted('confirm')).toEqual([['最终提示词']])
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([false])
  })
})
