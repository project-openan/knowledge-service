// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/reference/TablePagination.vue`。
// 组件自己是「哑」的：真实 page/size 由父级持有，翻页/改每页条数/跳页都以
// update:page / update:size / change 事件回报。el-pagination / el-select /
// el-input-number 是重型组件，用会发事件的桩替换，专测事件的**夹取与守卫**：
//   - 翻页值必须夹在 [1, pageCount]，与当前页相同则不发事件；
//   - 跳页输入非数字时静默忽略（用户敲一半就触发 change 是常态）；
//   - 改每页条数要同时回到第 1 页。
import { h } from 'vue'
import { expectNoI18nMisses, mountWithPlugins, textOf } from './helpers/mount'
import TablePagination from '@/shared/ui/reference/TablePagination.vue'

/** el-pagination 桩：三个按钮分别发出 0 / 2 / 99 的 current-change。 */
const PaginationStub = {
  props: { currentPage: Number, pageSize: Number, total: Number },
  setup (props, { emit }) {
    return () => h('div', { class: 'pagination-stub' }, [
      h('button', { class: 'go-zero', onClick: () => emit('current-change', 0) }, '0'),
      h('button', { class: 'go-two', onClick: () => emit('current-change', 2) }, '2'),
      h('button', { class: 'go-beyond', onClick: () => emit('current-change', 99) }, '99')
    ])
  }
}

/** el-select 桩：一个按钮把每页条数改成 20。 */
const SelectStub = {
  props: { modelValue: Number },
  setup (_, { emit }) {
    return () => h('button', { class: 'size-20', onClick: () => emit('update:model-value', 20) }, '20')
  }
}

/** el-input-number 桩：两个按钮分别提交 '7' 与 'abc'。 */
const InputNumberStub = {
  props: { modelValue: Number },
  setup (_, { emit }) {
    return () => h('div', [
      h('button', { class: 'jump-7', onClick: () => emit('change', '7') }, '7'),
      h('button', { class: 'jump-bad', onClick: () => emit('change', 'abc') }, 'abc')
    ])
  }
}

async function mountPagination (props = {}) {
  return mountWithPlugins(TablePagination, {
    props: { total: 25, page: 2, size: 10, ...props },
    global: {
      components: {
        ElPagination: PaginationStub,
        ElSelect: SelectStub,
        ElOption: { props: ['value', 'label'], setup: () => () => null },
        ElInputNumber: InputNumberStub
      }
    }
  })
}

describe('TablePagination 渲染', () => {
  it('总数文案 + 每页条数 + 跳页三件套（jumper=true）', async () => {
    const wrapper = await mountPagination({ jumper: true })

    const text = textOf(wrapper.find('.table-pagination'))
    expect(text).toContain('共 25 条')
    expect(text).toContain('前往')
    expect(text).toContain('页')
    expectNoI18nMisses(wrapper)
  })

  it('jumper=false 不渲染跳页区', async () => {
    const wrapper = await mountPagination()

    const text = textOf(wrapper.find('.table-pagination'))
    expect(text).toContain('共 25 条')
    expect(text).not.toContain('前往')
  })
})

describe('TablePagination 翻页（goPage 的夹取与守卫）', () => {
  it('合法页码：update:page 与 change 带出新页码', async () => {
    const wrapper = await mountPagination({ page: 1 })

    await wrapper.find('button.go-two').trigger('click')

    expect(wrapper.emitted('update:page')).toEqual([[2]])
    expect(wrapper.emitted('change')).toEqual([{ page: 2, size: 10 }].map(x => [x]))
  })

  it('超出总页数被夹到最后一页（total=25, size=10 → 第 3 页）', async () => {
    const wrapper = await mountPagination()

    await wrapper.find('button.go-beyond').trigger('click')

    expect(wrapper.emitted('update:page')).toEqual([[3]])
    expect(wrapper.emitted('change')).toEqual([{ page: 3, size: 10 }].map(x => [x]))
  })

  it('夹到与当前页相同的值不发事件（page=2 时点 0 → 夹成 1？不，0 会被夹成 1）', async () => {
    // page=2，0 → max(1, 0)=1 → 发 update:page 1
    const wrapper = await mountPagination()
    await wrapper.find('button.go-zero').trigger('click')
    expect(wrapper.emitted('update:page')).toEqual([[1]])
  })

  it('与当前页相同时不发事件（page=1 时点 0 → 夹成 1 → 静默）', async () => {
    const wrapper = await mountPagination({ page: 1 })

    await wrapper.find('button.go-zero').trigger('click')

    expect(wrapper.emitted('update:page')).toBeUndefined()
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('非数字页码不发事件（跳页输入敲一半就触发 change）', async () => {
    const wrapper = await mountPagination({ jumper: true })

    await wrapper.find('button.jump-bad').trigger('click')

    expect(wrapper.emitted('update:page')).toBeUndefined()
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('跳页数字字符串会被 parseInt，超出总页数同样被夹住（7 → 最后一页 3）', async () => {
    const wrapper = await mountPagination({ jumper: true })

    await wrapper.find('button.jump-7').trigger('click')

    expect(wrapper.emitted('update:page')).toEqual([[3]])
  })
})

describe('TablePagination 改每页条数', () => {
  it('update:size、回到第 1 页、change 三个事件一起发', async () => {
    const wrapper = await mountPagination({ jumper: true })

    await wrapper.find('button.size-20').trigger('click')

    expect(wrapper.emitted('update:size')).toEqual([[20]])
    expect(wrapper.emitted('update:page')).toEqual([[1]])
    expect(wrapper.emitted('change')).toEqual([{ page: 1, size: 20 }].map(x => [x]))
  })
})
