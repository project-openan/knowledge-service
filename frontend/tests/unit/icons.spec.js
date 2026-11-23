// @vitest-environment jsdom
//
// 测的是 `src/shared/lib/icons.ts`：Element Plus 图标的再导出 + 本地别名
// （HelpTip / Question / EmptyData / SquareMinus / SquarePlus）。
// 三个本地图标是 `makeIcon` 现画的 svg —— 渲染层有没有真画出形状、无障碍属性
// 是否还在，要挂载后断言 DOM 才算数。
import { h } from 'vue'
import { mountWithPlugins } from './helpers/mount'
import { EmptyData, HelpTip, Question, QuestionFilled, SquareMinus, SquarePlus } from '@/shared/lib/icons'

/** 把一个图标组件挂载成最小宿主（图标不需要 i18n / EP / router）。 */
function mountIcon (Icon) {
  return mountWithPlugins({ setup: () => () => h(Icon) }, { router: null })
}

describe('图标别名（再导出）', () => {
  it('HelpTip 与 Question 都是 QuestionFilled 的别名（不重复实现）', () => {
    expect(HelpTip).toBe(QuestionFilled)
    expect(Question).toBe(QuestionFilled)
  })

  it('别名组件能直接渲染出 svg（别挂了不存在的实现）', async () => {
    const wrapper = await mountIcon(HelpTip)

    expect(wrapper.find('svg').exists()).toBe(true)
  })
})

describe('本地现画的图标（makeIcon）', () => {
  it('EmptyData：svg 带无障碍隐藏与 viewBox，内部画出 1 rect + 1 path', async () => {
    const wrapper = await mountIcon(EmptyData)

    const svg = wrapper.find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe('0 0 1024 1024')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('width')).toBe('1em')
    expect(svg.attributes('height')).toBe('1em')
    expect(svg.findAll('rect')).toHaveLength(1)
    expect(svg.findAll('path')).toHaveLength(1)
  })

  it('SquareMinus：方块里只有一条横线（收起）', async () => {
    const wrapper = await mountIcon(SquareMinus)

    const svg = wrapper.find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.findAll('rect')).toHaveLength(1)
    const paths = svg.findAll('path')
    expect(paths).toHaveLength(1)
    // 一条横线：只有水平移动/画线指令
    expect(paths[0].attributes('d')).toBe('M320 512h384')
  })

  it('SquarePlus：方块里有横线加竖线（展开）', async () => {
    const wrapper = await mountIcon(SquarePlus)

    const paths = wrapper.findAll('path')
    expect(paths).toHaveLength(1)
    expect(paths[0].attributes('d')).toBe('M320 512h384M512 320v384')
  })

  it('三个图标的组件名各自可辨（devtools / 递归组件都需要）', async () => {
    for (const [Icon, name] of [
      [EmptyData, 'EmptyData'], [SquareMinus, 'SquareMinus'], [SquarePlus, 'SquarePlus']
    ]) {
      const wrapper = await mountIcon(Icon)
      expect(wrapper.findComponent({ name }).exists()).toBe(true)
    }
  })
})
