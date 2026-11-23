// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/DeleteConfirmDialog.vue`：批量删除的确认弹窗
// （对象清单 + 4 位本地验证码）。钉住：
//   - 文案结构：标题/副标题按 resourceType 组合，i18n 词条真实存在；
//   - 清单渲染：单项/批量、头像色块与字母占位、meta/tag、明细与备注；
//   - resourceType → 图标的映射（知识库/图谱/密钥/算子/模型…）；
//   - 提交闸门：无对象或未通过验证码时按钮置灰；验证通过 → confirm + 关闭；
//   - 弹窗开着但模型层关掉（open=false）时不得重复提交。
// el-dialog 换成渲染全部插槽的桩，并在挂载时补发一次 opened（真弹窗打开即发）。
import { h, onMounted } from 'vue'
import { Document, Share, Key, SetUp, Box, Connection } from '@element-plus/icons-vue'
import { findByText, mountWithPlugins, textOf } from './helpers/mount'
import DeleteConfirmDialog from '@/shared/ui/DeleteConfirmDialog.vue'

// resourceType 的默认值在组件创建期经全局 `$t`（i18n.js）求值，语言来自
// localStorage —— 钉成中文，标题断言才稳定。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const DialogStub = {
  name: 'ElDialog',
  props: { modelValue: Boolean },
  setup (_, { slots, emit }) {
    // 真弹窗打开后会触发 @opened → 组件拿它做首次聚焦
    onMounted(() => emit('opened'))
    return () => h('div', { class: 'dialog-stub' }, [
      slots.header ? slots.header({ titleId: 'probe-title' }) : null,
      slots.default ? slots.default() : null,
      slots.footer ? slots.footer() : null
    ])
  }
}

const KB_ITEM = { id: 'kb-1', name: '测试知识库', av: 'av-blue', meta: 'kb-0001', tag: '私有' }

async function mountDialog (props = {}) {
  return mountWithPlugins(DeleteConfirmDialog, {
    props: { modelValue: true, resourceType: '知识库', items: [KB_ITEM], ...props },
    global: { components: { ElDialog: DialogStub } }
  })
}

async function passVerification (wrapper) {
  const challenge = textOf(wrapper.find('.delete-confirm-challenge code'))
  await wrapper.find('.delete-confirm-verification input').setValue(challenge)
  await wrapper.flush()
}

describe('DeleteConfirmDialog 文案与结构', () => {
  it('标题/副标题按 resourceType 组合，默认 hint 与取消按钮', async () => {
    const wrapper = await mountDialog({ warning: '删除后数据不可恢复', description: '含 3 篇文档' })

    expect(textOf(wrapper.find('h2'))).toContain('删除知识库')
    expect(textOf(wrapper.find('.studio-dialog-heading p'))).toBe('请核对删除对象与影响，再继续操作。')
    expect(textOf(wrapper.find('.text-body'))).toBe('删除后数据不可恢复')
    expect(textOf(wrapper.find('.delete-confirm-warning p.text-secondary'))).toBe('含 3 篇文档')
    expect(textOf(wrapper.find('.studio-footer-hint'))).toContain('此操作不可撤销')
    expect(findByText(wrapper, '取消', 'button')).not.toBeNull()
  })

  it('单项清单：待删除标签、头像色块、名称、meta、tag', async () => {
    const wrapper = await mountDialog()

    const item = wrapper.find('.delete-confirm-identity')
    expect(item.exists()).toBe(true)
    expect(item.find('.avatar-square.av-blue').exists()).toBe(true)
    expect(textOf(item.find('h3'))).toBe('测试知识库')
    expect(textOf(item.find('code'))).toBe('kb-0001')
    expect(textOf(item.find('.delete-confirm-kind'))).toBe('私有')
    // 单项也标出「待删除{resourceType}」
    expect(textOf(wrapper.find('.delete-confirm-name .text-caption'))).toBe('待删除知识库')
  })

  it('批量清单：批量标题带计数，列表加 is-batch 类', async () => {
    const wrapper = await mountDialog({
      items: [KB_ITEM, { id: 'kb-2', name: '另一个库', letter: 'B' }]
    })

    const heading = wrapper.find('.delete-confirm-batch-heading')
    expect(heading.exists()).toBe(true)
    expect(textOf(heading)).toContain('共 2 项')
    expect(wrapper.find('ul.is-batch').exists()).toBe(true)
    // letter 占位渲染字母，不渲染图标
    const second = wrapper.findAll('.delete-confirm-identity')[1]
    expect(textOf(second.find('.avatar-square'))).toBe('B')
  })

  it('detail / note 各占一行，带提示图标', async () => {
    const wrapper = await mountDialog({ detail: '将删除 3 篇文档', note: '此操作立即生效' })

    expect(textOf(wrapper.find('.delete-confirm-endpoint'))).toContain('将删除 3 篇文档')
    expect(textOf(wrapper.find('.delete-confirm-default'))).toContain('此操作立即生效')
  })
})

describe('DeleteConfirmDialog 资源图标映射', () => {
  const cases = [
    ['知识库', Document], ['图谱知识库', Share], ['密钥', Key],
    ['算子', SetUp], ['模型', Box], ['节点', Connection]
  ]
  for (const [resourceType, expected] of cases) {
    it(`${resourceType} → 对应图标`, async () => {
      const wrapper = await mountDialog({ resourceType })

      expect(wrapper.findComponent(expected).exists()).toBe(true)
    })
  }

  it('未知 resourceType 回落 Document 图标', async () => {
    const wrapper = await mountDialog({ resourceType: '神秘资源' })

    expect(wrapper.findComponent(Document).exists()).toBe(true)
  })
})

describe('DeleteConfirmDialog 提交闸门', () => {
  it('无对象时提交置灰', async () => {
    const wrapper = await mountDialog({ items: [] })

    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeDefined()
  })

  it('需要验证码且未通过时提交置灰；验证通过后可提交', async () => {
    const wrapper = await mountDialog()
    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeDefined()

    await passVerification(wrapper)

    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeUndefined()
  })

  it('验证码匹配时行内给出「验证通过」反馈', async () => {
    const wrapper = await mountDialog()

    await passVerification(wrapper)

    expect(textOf(wrapper.find('.delete-confirm-help'))).toBe('验证通过，请确认是否删除。')
  })

  it('验证通过 → 提交：confirm 事件 + 弹窗关闭（update:modelValue=false）', async () => {
    const wrapper = await mountDialog()

    await passVerification(wrapper)
    await wrapper.find('.delete-confirm-submit').trigger('click')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('验证未通过时回车提交（DeleteVerification 的 submit）被闸门拦下', async () => {
    const wrapper = await mountDialog()

    await wrapper.find('.delete-confirm-verification input').setValue('12')
    await wrapper.find('.delete-confirm-verification input').trigger('keyup.enter')

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('verification=false：无验证码区，有对象即可直接提交', async () => {
    const wrapper = await mountDialog({ verification: false })

    expect(wrapper.find('.delete-confirm-verification').exists()).toBe(false)
    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeUndefined()

    await wrapper.find('.delete-confirm-submit').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('open=false（弹窗已关）：提交闸门直接拦下，不重复上报 confirm', async () => {
    const wrapper = await mountDialog({ modelValue: false, verification: false })

    await wrapper.find('.delete-confirm-submit').trigger('click')

    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('点取消只关弹窗，不发 confirm', async () => {
    const wrapper = await mountDialog({ verification: false })

    await findByText(wrapper, '取消', 'button').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('对象变化后验证状态被重置（重新打开/换清单要重新验证）', async () => {
    const wrapper = await mountDialog()
    await passVerification(wrapper)
    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ items: [{ id: 'kb-9', name: '换一批' }] })
    await wrapper.flush()
    await wrapper.flush()

    expect(wrapper.find('.delete-confirm-submit').attributes('disabled')).toBeDefined()
  })
})
