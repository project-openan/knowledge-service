// @vitest-environment jsdom
// src/app/App.vue（覆盖率 0%）的三个全局副作用契约：
//   1) 根节点 .saas + RouteProgressBar + router-view；
//   2) 路由切换后清掉残留的 .el-tooltip__popper 浮层（尽力而为：浮层已被组件
//      自己移走时 removeChild 抛错也要吞掉）；
//   3) 弹窗关闭 / 路由切换时结算全局删除确认的 Promise（deletion.open watch +
//      $route.fullPath watch）。
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountWithPlugins, flush } from './helpers/mount'

import App from '@/app/App.vue'
import { deletion, requestDeletion } from '@/shared/composables/deletion'

// 路由进度条与删除弹窗换桩：本 spec 只关心 App 自己的三条副作用
vi.mock('@/shared/ui/RouteProgressBar.vue', () => ({
  default: { name: 'RouteProgressBarStub', template: '<div class="route-progress-stub" />' }
}))
vi.mock('@/shared/ui/DeleteConfirmDialog.vue', () => ({
  default: {
    name: 'DeleteConfirmDialogStub',
    props: ['modelValue'],
    template: '<div v-if="modelValue" class="delete-dialog-stub" />'
  }
}))

describe('App.vue（应用根组件）', () => {
  it('渲染 .saas 根容器、顶部进度条与 router-view 出口', async () => {
    const wrapper = await mountWithPlugins(App, { route: '/' })

    expect(wrapper.find('.saas').exists()).toBe(true)
    expect(wrapper.find('.route-progress-stub').exists()).toBe(true)
    // `/` 下路由表渲染 BlankRoute（render: null），router-view 本身表现为注释占位
    expect(wrapper.findComponent({ name: 'RouteProgressBarStub' }).exists()).toBe(true)
  })

  it('路由切换时移除 body 里残留的 tooltip 浮层；浮层已被移走时静默吞错', async () => {
    const wrapper = await mountWithPlugins(App, { route: '/' })

    // 一个真的挂在 body 上的浮层 + 一个挂在 <html> 直下的浮层
    // （querySelectorAll 能找到、但 body.removeChild 抛 NotFoundError → 走 catch）
    const attached = document.createElement('div')
    attached.className = 'el-tooltip__popper'
    attached.id = 'stale-tooltip'
    document.body.appendChild(attached)
    const orphan = document.createElement('div')
    orphan.className = 'el-tooltip__popper'
    orphan.id = 'orphan-tooltip'
    document.documentElement.appendChild(orphan)

    await wrapper.router.push('/knowledge')
    await flush()
    await nextTick()

    expect(document.getElementById('stale-tooltip')).toBeNull()
    // 游离浮层没被误删（catch 分支吞掉了 removeChild 的异常，清理是尽力而为）
    expect(document.getElementById('orphan-tooltip')).not.toBeNull()
    orphan.remove()
  })

  it('删除确认弹窗被关闭（open→false）时把挂起的 Promise 结算为 false；确认时结算为 true', async () => {
    const wrapper = await mountWithPlugins(App, { route: '/', global: { stubs: { routerView: false } } })

    const pending = requestDeletion({ items: [{ id: 1, name: 'a' }] })
    await nextTick()
    expect(deletion.open).toBe(true)
    expect(wrapper.find('.delete-dialog-stub').exists()).toBe(true)

    // 确认路径：弹窗 @confirm → settleDeletion(true)
    wrapper.findComponent({ name: 'DeleteConfirmDialogStub' }).vm.$emit('confirm')
    await flush()
    await nextTick()
    await expect(pending).resolves.toBe(true)

    // 取消路径：模拟「弹窗被取消 / ESC / 点遮罩」的关闭（open→false watch）
    const cancelled = requestDeletion({ items: [{ id: 3, name: 'c' }] })
    await nextTick()
    deletion.open = false
    await flush()
    await nextTick()

    await expect(cancelled).resolves.toBe(false)
    expect(deletion.open).toBe(false)
  })

  it('路由切换时取消未完成的删除确认（fullPath watch）', async () => {
    const wrapper = await mountWithPlugins(App, { route: '/' })

    const pending = requestDeletion({ items: [{ id: 2, name: 'b' }] })
    await nextTick()
    expect(deletion.open).toBe(true)

    await wrapper.router.push('/graph')
    await flush()
    await nextTick()

    await expect(pending).resolves.toBe(false)
  })
})
