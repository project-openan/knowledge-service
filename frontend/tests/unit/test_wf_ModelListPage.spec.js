// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { h } from 'vue'
import { flush, mountWithPlugins } from './helpers/mount'

// 模型管理页：三类页签的「首次挂载不重复取数、切回来才刷新」契约。
// ModelTable 是子组件，stub 掉并把 refreshTableData 挂到共享表上记录调用。
const state = vi.hoisted(() => ({ refreshers: {} }))

vi.mock('@/features/model/ModelTable.vue', () => ({
  default: {
    name: 'ModelTableStub',
    props: { kind: { type: String, default: '' } },
    emits: ['change-kind'],
    setup (props, { expose }) {
      const refreshTableData = vi.fn(() => {
        state.refreshers[props.kind] = (state.refreshers[props.kind] || 0) + 1
      })
      expose({ refreshTableData })
      return () => h('div', { class: 'model-table-stub', 'data-kind': props.kind })
    }
  }
}))

import ModelListPage from '@/pages/model/ModelListPage.vue'

async function mountPage () {
  const wrapper = await mountWithPlugins(ModelListPage, { route: '/models' })
  await flush()
  return wrapper
}

function stubsOf (wrapper) {
  return wrapper.findAll('.model-table-stub').map(node => node.attributes('data-kind'))
}

beforeEach(() => {
  state.refreshers = {}
})

describe('ModelListPage：三类模型页签', () => {
  it('页签是 lazy 的：首屏只挂载 llm 一张表，且不手动刷新（onMounted 自己取数）', async () => {
    const wrapper = await mountPage()
    expect(stubsOf(wrapper)).toEqual(['llm'])
    // 首次挂载：页面不再叠一次 refresh，否则与 ModelTable.onMounted 变成两条相同请求
    expect(state.refreshers.llm).toBeUndefined()
  })

  it('首次切到 embedding：只挂载不手动刷新（避免与 onMounted 叠请求）', async () => {
    const wrapper = await mountPage()
    await wrapper.findAll('.el-tabs__item')[1].trigger('click')
    await flush()
    await flush()

    expect(stubsOf(wrapper)).toContain('embedding')
    expect(state.refreshers.embedding).toBeUndefined()
  })

  it('切回来（已访问过的页签）才手动刷新', async () => {
    const wrapper = await mountPage()
    const tabs = wrapper.findAll('.el-tabs__item')
    await tabs[1].trigger('click') // embedding：首次
    await flush()
    await tabs[0].trigger('click') // 回到 llm：已访问 → 手动刷新
    await flush()
    await flush()
    expect(state.refreshers.llm).toBe(1)
    expect(state.refreshers.embedding).toBeUndefined()
  })

  it('switchKind：弹窗里改了类型 → 跟着切页签并刷新', async () => {
    const wrapper = await mountPage()
    const table = wrapper.findComponent({ name: 'ModelTableStub' })
    table.vm.$emit('change-kind', 'embedding')
    await flush()
    await flush()

    expect(stubsOf(wrapper)).toContain('embedding')
    // embedding 首次被访问：不手动刷新；再切回 llm（已访问）→ 刷新一次
    expect(state.refreshers.embedding).toBeUndefined()
    table.vm.$emit('change-kind', 'llm')
    await flush()
    await flush()
    expect(state.refreshers.llm).toBe(1)
  })
})
