// @vitest-environment jsdom
//
// 一组 shared/ui 下的小组件：
//   - SectionTitle（区块标题，h{level} + 竖条变体）；
//   - TableIcon（表格行内图标按钮：tip / disabled / 具名插槽）；
//   - ListSelectionBar（列表已选条：计数、清空、动作插槽）；
//   - MetricCard（概览指标卡：delta 的 muted / title 分支）。
// RouteProgressBar 单独一组（要真路由驱动，见下方说明）。
import { h } from 'vue'
import {
  expectNoI18nMisses, findByText, mountWithPlugins, textOf
} from './helpers/mount'
import SectionTitle from '@/shared/ui/SectionTitle.vue'
import TableIcon from '@/shared/ui/TableIcon.vue'
import ListSelectionBar from '@/shared/ui/ListSelectionBar.vue'
import MetricCard from '@/shared/ui/reference/MetricCard.vue'
import { QuestionFilled } from '@/shared/lib/icons'

/** el-tooltip 是重型组件（带 popper），这里换成纯透传桩。 */
const TooltipStub = {
  name: 'ElTooltip',
  inheritAttrs: false,
  setup (_, { slots }) {
    return () => h('div', { class: 'tooltip-stub' }, slots.default ? slots.default() : [])
  }
}

describe('SectionTitle（区块标题）', () => {
  it('level 决定渲染成 h{level}（默认 h2）', async () => {
    const wrapper = await mountWithPlugins(SectionTitle, {
      slots: { default: () => h('span', '基础信息') }
    })

    const title = wrapper.find('h2')
    expect(title.exists()).toBe(true)
    expect(title.classes()).toContain('section-title')
    expect(title.classes()).not.toContain('section-title--vertical')
    expect(textOf(title)).toBe('基础信息')
    expectNoI18nMisses(wrapper)
  })

  it('level=3 渲染成 h3；type=vertical 加竖条类', async () => {
    const wrapper = await mountWithPlugins(SectionTitle, {
      props: { level: 3, type: 'vertical' },
      slots: { default: () => h('span', '高级设置') }
    })

    const title = wrapper.find('h3')
    expect(title.exists()).toBe(true)
    expect(title.classes()).toContain('section-title--vertical')
  })
})

describe('TableIcon（表格行内图标按钮）', () => {
  it('没有 el-icon 插槽时渲染 <i>，点击发 click 事件', async () => {
    const wrapper = await mountWithPlugins(TableIcon, {
      props: { iconClass: 'option-icon' },
      global: { components: { ElTooltip: TooltipStub } }
    })

    const icon = wrapper.find('i.ai-button-icon')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('option-icon')
    expect(icon.classes()).not.toContain('ai-button-icon--disabled')

    await icon.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('disabled 时点击不发 click（行内按钮置灰后必须真的点不动）', async () => {
    const wrapper = await mountWithPlugins(TableIcon, {
      props: { iconClass: 'option-icon', disabled: true },
      global: { components: { ElTooltip: TooltipStub } }
    })

    await wrapper.find('i.ai-button-icon').trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
    expect(wrapper.find('i.ai-button-icon--disabled').exists()).toBe(true)
  })

  it('有 el-icon 插槽时渲染插槽内容，不再渲染 <i>', async () => {
    const wrapper = await mountWithPlugins(TableIcon, {
      props: { iconClass: 'option-icon' },
      slots: { elIcon: () => h('span', { class: 'custom-glyph' }, 'glyph') },
      global: { components: { ElTooltip: TooltipStub } }
    })

    expect(wrapper.find('.custom-glyph').exists()).toBe(true)
    // 命中 el-icon 分支：el-icon 自身渲染的 <i> 带 el-icon 类，fallback 的裸 <i> 不存在
    expect(wrapper.find('i.ai-button-icon:not(.el-icon)').exists()).toBe(false)

    await wrapper.find('.el-icon').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })
})

describe('ListSelectionBar（列表已选条）', () => {
  it('count=0 整条不渲染（没有选择就没有工具条）', async () => {
    const wrapper = await mountWithPlugins(ListSelectionBar, {
      slots: { default: () => h('button', '批量删除') }
    })

    expect(wrapper.find('.list-selection-bar').exists()).toBe(false)
  })

  it('count>0 显示计数与清空按钮，动作插槽渲染', async () => {
    const wrapper = await mountWithPlugins(ListSelectionBar, {
      props: { count: 3 },
      slots: { default: () => h('button', { class: 'batch-action' }, '批量删除') }
    })

    const bar = wrapper.find('.list-selection-bar')
    expect(bar.attributes('role')).toBe('group')
    expect(textOf(bar)).toContain('已选择 3 项')
    expect(wrapper.find('.batch-action').exists()).toBe(true)
    expectNoI18nMisses(wrapper)
  })

  it('点「取消选择」发 clear 事件', async () => {
    const wrapper = await mountWithPlugins(ListSelectionBar, { props: { count: 1 } })

    await findByText(wrapper, '取消选择', 'button').trigger('click')

    expect(wrapper.emitted('clear')).toHaveLength(1)
  })
})

describe('MetricCard（概览指标卡）', () => {
  const icon = QuestionFilled

  it('结构齐全：tone 类、图标、label、value、delta、foot', async () => {
    const wrapper = await mountWithPlugins(MetricCard, {
      props: {
        label: '文档总数', value: 12, delta: '↑ 3', foot: '较上周',
        tone: 'green', icon, deltaTitle: '上周为 9'
      }
    })

    expect(wrapper.find('.metric-icon.green').exists()).toBe(true)
    expect(wrapper.find('.metric-icon svg').exists()).toBe(true)
    expect(textOf(wrapper.find('.metric-label'))).toBe('文档总数')
    expect(textOf(wrapper.find('.metric-value'))).toBe('12')
    expect(textOf(wrapper.find('.metric-delta'))).toBe('↑ 3')
    expect(textOf(wrapper.find('.metric-foot'))).toBe('较上周')
    // deltaTitle 解释为什么有 delta（这里是真的变化），进 title 与 aria
    expect(wrapper.find('.metric-delta').attributes('title')).toBe('上周为 9')
    expect(wrapper.find('.metric-delta').attributes('aria-label')).toBe('上周为 9')
    expect(wrapper.find('.metric-delta.muted').exists()).toBe(false)
  })

  it('delta 为空时不渲染变化块', async () => {
    const wrapper = await mountWithPlugins(MetricCard, {
      props: { label: '文档总数', value: 12, icon }
    })

    expect(wrapper.find('.metric-change').exists()).toBe(false)
  })

  it('muted=true 或 delta 含「→」都算中性占位（无历史趋势）', async () => {
    const muted = await mountWithPlugins(MetricCard, {
      props: { label: 'l', value: 1, delta: '—', muted: true, icon }
    })
    const arrow = await mountWithPlugins(MetricCard, {
      props: { label: 'l', value: 1, delta: '0 → 5', icon }
    })

    expect(muted.find('.metric-delta.muted').exists()).toBe(true)
    expect(arrow.find('.metric-delta.muted').exists()).toBe(true)
  })

  it('deltaTitle 为空时不带 title / aria-label（不误导读屏）', async () => {
    const wrapper = await mountWithPlugins(MetricCard, {
      props: { label: 'l', value: 1, delta: '↑ 1', icon }
    })

    expect(wrapper.find('.metric-delta').attributes('title')).toBeUndefined()
    expect(wrapper.find('.metric-delta').attributes('aria-label')).toBeUndefined()
  })
})
