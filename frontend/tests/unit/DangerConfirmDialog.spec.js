// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/DangerConfirmDialog.vue`：高危操作（删除知识库等）的
// 验证码确认弹窗。钉住交互闭环：
//   - openDialog 注入文案并重置输入/验证码/错误；
//   - 验证码输错 → 明确的错误提示 + 自动换一张码 + 清空输入（按钮不置灰让用户猜）；
//   - 输对 → confirm 事件带 done / setLoading 两个回调（done 关弹窗、setLoading 控状态）；
//   - 取消直接关弹窗并报 cancel；输入中清掉上一次的错误提示。
// el-dialog 是重型组件，换成会渲染全部插槽的桩。
import { h } from 'vue'
import { mountWithPlugins, textOf } from './helpers/mount'
import DangerConfirmDialog from '@/shared/ui/DangerConfirmDialog.vue'

// 组件的默认按钮文案（public.delete / public.cancel）在模块加载期经全局 `$t`
// 求值，语言来自 localStorage —— 钉成中文，断言才稳定。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

// 验证码生成器换成**递增的确定性序列**：真实实现是纯随机 4 位，断言「换了一张新码」
// 会有 1/10000 的撞码概率 —— 这里让每次调用都产出不同且可控的码，用例不掷骰子。
// CaptchaInput 的「输入与显示码比对」仍是真逻辑，不受影响。
vi.mock('@/shared/lib/captcha', () => {
  let seq = 1000
  return {
    generateNumericCaptcha: () => {
      seq += 7
      return String(seq)
    }
  }
})

/** 渲染 header/default/footer 三个插槽的 el-dialog 桩。 */
const DialogStub = {
  name: 'ElDialog',
  props: { modelValue: Boolean },
  setup (_, { slots }) {
    return () => h('div', { class: 'dialog-stub' }, [
      slots.default ? slots.default() : null,
      slots.footer ? slots.footer() : null
    ])
  }
}

async function mountDialog (props = {}) {
  const wrapper = await mountWithPlugins(DangerConfirmDialog, {
    props,
    global: { components: { ElDialog: DialogStub } }
  })
  return wrapper
}

/** 造一个必然与当前验证码不同的 4 位串。 */
function wrongCodeOf (code) {
  return code === '9999' ? '1111' : '9999'
}

describe('DangerConfirmDialog（危险操作验证码确认弹窗）', () => {
  it('未 openDialog 时什么都不渲染', async () => {
    const wrapper = await mountDialog()

    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
  })

  it('openDialog 注入 message/description，重置输入与验证码', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '删除知识库「demo」？', description: '删除后文档与图谱数据不可恢复' })

    expect(wrapper.find('.dialog-stub').exists()).toBe(true)
    expect(textOf(wrapper.find('.title'))).toBe('删除知识库「demo」？')
    expect(textOf(wrapper.find('.desc'))).toBe('删除后文档与图谱数据不可恢复')
    expect(textOf(wrapper.find('.captcha-code'))).toMatch(/^\d{4}$/)
    expect(wrapper.find('.captcha-error').exists()).toBe(false)
    // 验证码未输入，确认按钮置灰
    expect(findByButton(wrapper, '删除').attributes('disabled')).toBeDefined()
  })

  it('description 缺省时不渲染 desc（不渲染空壳）', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '只删一个文件' })

    expect(wrapper.find('.desc').exists()).toBe(false)
  })

  it('验证码输错：错误提示 + 自动换码 + 清空输入，不触发 confirm', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '删除' })

    const firstCode = textOf(wrapper.find('.captcha-code'))
    await wrapper.find('input').setValue(wrongCodeOf(firstCode))
    await findByButton(wrapper, '删除').trigger('click')

    const error = wrapper.find('.captcha-error')
    expect(error.exists()).toBe(true)
    expect(error.attributes('role')).toBe('alert')
    expect(textOf(error)).toBe('验证码不正确，请重新输入')
    // 换了一张新码（避免用户再输一遍刚错的）
    expect(textOf(wrapper.find('.captcha-code'))).not.toBe(firstCode)
    // 输入被清空，按钮回到置灰
    expect(wrapper.find('input').element.value).toBe('')
    expect(findByButton(wrapper, '删除').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('输入中清掉上一次的错误提示（handleInput）', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '删除' })

    await wrapper.find('input').setValue(wrongCodeOf(textOf(wrapper.find('.captcha-code'))))
    await findByButton(wrapper, '删除').trigger('click')
    expect(wrapper.find('.captcha-error').exists()).toBe(true)

    await wrapper.find('input').setValue('1')
    expect(wrapper.find('.captcha-error').exists()).toBe(false)
  })

  it('验证码输对：confirm 事件带 done / setLoading；done 关弹窗并复位 loading', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '删除' })

    await wrapper.find('input').setValue(textOf(wrapper.find('.captcha-code')))
    const button = findByButton(wrapper, '删除')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    const { done, setLoading } = wrapper.emitted('confirm')[0][0]
    expect(typeof done).toBe('function')
    expect(typeof setLoading).toBe('function')

    setLoading(true)
    expect(findByButton(wrapper, '删除').classes()).toContain('is-loading')

    done()
    await wrapper.flush()
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
    // 关闭后 loading 复位，下次打开不会带着旧状态
    await wrapper.vm.openDialog({ message: '再删一个' })
    expect(findByButton(wrapper, '删除').classes()).not.toContain('is-loading')
  })

  it('取消：直接关弹窗并报 cancel 事件', async () => {
    const wrapper = await mountDialog()
    await wrapper.vm.openDialog({ message: '删除' })

    await findByButton(wrapper, '取消').trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.find('.dialog-stub').exists()).toBe(false)
  })

  it('confirmText / cancelText 可由调用方覆盖默认「删除 / 取消」', async () => {
    const wrapper = await mountDialog({ confirmText: '确认删除', cancelText: '返回' })
    await wrapper.vm.openDialog({ message: '删除' })

    expect(findByButton(wrapper, '确认删除')).not.toBeNull()
    expect(findByButton(wrapper, '返回')).not.toBeNull()
    expect(findByButton(wrapper, '删除', { exact: true })).toBeNull()
  })
})

/** 在弹窗 footer 里按文案找按钮；exact=true 时要求整词相等（区分「删除/确认删除」）。 */
function findByButton (wrapper, text, { exact = true } = {}) {
  const buttons = wrapper.findAll('button')
    .filter(node => {
      const label = textOf(node)
      return exact ? label === text : label.includes(text)
    })
  return buttons[buttons.length - 1] || null
}
