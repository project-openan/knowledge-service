// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/RouteProgressBar.vue` + `src/shared/lib/route-progress.js`。
//
// 进度条只在「导航仍在进行」时出现：懒加载 chunk 下载期间（beforeEach 已过、
// afterEach 未到）超过 120ms 才亮。所以这里用**慢守卫**把导航真实拖住，
// 让 120ms 的 SHOW_DELAY 真的走到；再验证导航结束后的最小停留与消失。
// （route-progress 是模块级单例状态，两条用例共用同一份 module state。）
import { createRouter, createMemoryHistory } from 'vue-router'
import { mountWithPlugins } from './helpers/mount'
import RouteProgressBar from '@/shared/ui/RouteProgressBar.vue'
import { installRouteProgress } from '@/shared/lib/route-progress'

const Blank = { render: () => null }
const slowRoutes = [
  { path: '/', component: Blank },
  {
    path: '/slow-documents',
    component: Blank,
    // 模拟懒加载 chunk 的下载耗时：导航在这 300ms 里停在 beforeEach 之后
    beforeEnter: () => new Promise(resolve => setTimeout(resolve, 300))
  },
  { path: '/broken', component: () => Promise.reject(new Error('chunk load fail')) },
  { path: '/:pathMatch(.*)*', component: Blank }
]

function makeRouter () {
  const router = createRouter({ history: createMemoryHistory(), routes: slowRoutes })
  installRouteProgress(router)
  return router
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('RouteProgressBar（路由加载进度条）', () => {
  it('导航超过 120ms 未完成 → 显示进度条；结束后（含最小停留）消失', async () => {
    const router = makeRouter()
    const wrapper = await mountWithPlugins(RouteProgressBar, { router: null })

    expect(wrapper.find('.route-progress').exists()).toBe(false)

    // 不 await：push 要等导航**完成**才 resolve，而进度条要在导航**进行中**检查
    const navigation = router.push('/slow-documents')

    // 导航已在 300ms 守卫上挂起，SHOW_DELAY(120) + 余量后必须可见
    await wait(220)
    const bar = wrapper.find('.route-progress')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('role')).toBe('progressbar')
    expect(bar.attributes('aria-label')).toBe('页面加载中')
    expect(bar.find('.route-progress__bar').exists()).toBe(true)

    await navigation

    // 守卫放行 → afterEach 结算 → MIN_VISIBLE(320) 内至少停留，之后消失
    await wait(420)
    expect(wrapper.find('.route-progress').exists()).toBe(false)
    wrapper.unmount()
  })

  it('懒加载 chunk 失败（onError）：结算导航，进度条不会永久挂着', async () => {
    const router = makeRouter()
    const wrapper = await mountWithPlugins(RouteProgressBar, { router: null })

    await expect(router.push('/broken')).rejects.toThrow('chunk load fail')

    // onError 带着同一个 to 结算；导航失败远快于 SHOW_DELAY，条从未亮起
    expect(wrapper.find('.route-progress').exists()).toBe(false)
    wrapper.unmount()
  })
})
