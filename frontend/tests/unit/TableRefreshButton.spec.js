// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/TableRefreshButton.vue`：表格右上角的刷新按钮。
// 钉住四件事：
//   - 成功后行内显示「已刷新 HH:MM」，非行内模式把时间收进按钮 title；
//   - 失败时出现 role=alert 的失败提示与警示图标；
//   - 刷新进行中按钮文案换成「刷新中」（重复点击由 useTableRefresh 兜住）；
//   - 浮层内（inlineFeedback=false）用紧凑样式，不撑开浮层。
import { findByText, mountWithPlugins, textOf } from './helpers/mount'
import TableRefreshButton from '@/shared/ui/TableRefreshButton.vue'

describe('TableRefreshButton（表格刷新按钮）', () => {
  it('点击触发 refresh 并显示行内「已刷新 HH:MM」', async () => {
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: { refresh: async () => {}, inlineFeedback: false }
    })

    await findByText(wrapper, '刷新', 'button').trigger('click')
    await wrapper.flush()

    const status = wrapper.find('.table-refresh-status')
    expect(status.exists()).toBe(true)
    expect(status.attributes('role')).toBe('status')
    expect(textOf(status)).toMatch(/^已刷新 \d{2}:\d{2}:\d{2}$/)
    // 成功图标挂在按钮里
    expect(wrapper.find('.table-refresh-success').exists()).toBe(true)
    expect(wrapper.find('.table-refresh-failure').exists()).toBe(false)
    // 行内时间还带完整时间戳 title（date + time，比按钮里的 HH:MM 更细）
    expect(status.attributes('title')).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/)
  })

  it('inlineFeedback=false（浮层内）：反馈收进按钮 title，不渲染行内时间', async () => {
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: { refresh: async () => {}, inlineFeedback: false }
    })

    await findByText(wrapper, '刷新', 'button').trigger('click')
    await wrapper.flush()

    expect(wrapper.classes()).toContain('has-compact-feedback')
    const button = findByText(wrapper, '刷新', 'button')
    expect(button.attributes('title')).toMatch(/^已刷新 /)
    // 行内反馈仍在 DOM（视觉隐藏），供读屏使用
    expect(wrapper.find('.table-refresh-status').exists()).toBe(true)
  })

  it('刷新失败：出现 role=alert 提示与警示图标，title 也换成失败文案', async () => {
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: {
        refresh: async () => { throw new Error('network down') },
        inlineFeedback: false
      }
    })

    await findByText(wrapper, '刷新', 'button').trigger('click')
    await wrapper.flush()

    const error = wrapper.find('.table-refresh-error')
    expect(error.exists()).toBe(true)
    expect(error.attributes('role')).toBe('alert')
    expect(textOf(error)).toBe('刷新失败，请重试')
    expect(wrapper.find('.table-refresh-failure').exists()).toBe(true)
    expect(wrapper.find('.table-refresh-success').exists()).toBe(false)
    expect(findByText(wrapper, '刷新', 'button').attributes('title')).toBe('刷新失败，请重试')
  })

  it('刷新进行中：按钮显示「刷新中」，aria-busy=true，图标隐藏', async () => {
    let resolveLoad
    const load = () => new Promise(resolve => { resolveLoad = resolve })
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: { refresh: load }
    })

    await findByText(wrapper, '刷新', 'button').trigger('click')

    expect(findByText(wrapper, '刷新中', 'button')).not.toBeNull()
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.find('.table-refresh-success').exists()).toBe(false)
    expect(wrapper.find('.table-refresh-error').exists()).toBe(false)

    resolveLoad()
    await wrapper.flush()
    expect(textOf(wrapper.find('.table-refresh-status'))).toMatch(/^已刷新 /)
  })

  it('还没刷新过：无反馈区，按钮无 title', async () => {
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: { refresh: async () => {}, inlineFeedback: false }
    })

    expect(wrapper.find('.table-refresh-status').exists()).toBe(false)
    expect(wrapper.find('.table-refresh-error').exists()).toBe(false)
    expect(findByText(wrapper, '刷新', 'button').attributes('title')).toBeUndefined()
  })

  it('默认用真实 label 作为无障碍名称', async () => {
    const wrapper = await mountWithPlugins(TableRefreshButton, {
      props: { refresh: async () => {}, label: '刷新知识库列表' }
    })

    expect(findByText(wrapper, '刷新', 'button').attributes('aria-label')).toBe('刷新知识库列表')
  })
})
