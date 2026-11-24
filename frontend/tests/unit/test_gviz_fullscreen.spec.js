// @vitest-environment jsdom
/**
 * useGraphFullscreen —— 沉浸画布（窗口内全屏）：状态切换、画布重排、Esc 优先级。
 *
 * Esc 的判定链（resolveFullscreenEscape）由纯函数承载，这里挂真 keydown 事件钉
 * 「监听器确实挂在 document 上 + overlay 侦测」这层胶水：
 * - 有可见抽屉/弹窗（getClientRects 非空）时 Esc 让给抽屉，全屏状态不动；
 * - 全屏 + 浮层开着 → 只收浮层；全屏 + 浮层收着 → 退出全屏。
 */
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'

import { useGraphFullscreen } from '@/features/graph/composables/useGraphFullscreen'

function makeCtx () {
  return {
    graphCanvasRef: ref({ relayoutForViewport: vi.fn() }),
    fullscreenButton: ref({ $el: { focus: vi.fn() } }),
    emit: vi.fn()
  }
}

/** composable 用了 onMounted/onBeforeUnmount，必须包进宿主组件再挂载 */
async function mountHost (ctx) {
  const store = ref(null)
  const Host = defineComponent({
    setup () {
      store.value = useGraphFullscreen(ctx)
      return () => h('div')
    }
  })
  const wrapper = mount(Host)
  await nextTick()
  return { wrapper, fullscreen: store.value }
}

function pressEscape ({ defaultPrevented = false, key = 'Escape' } = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  if (defaultPrevented) {
    event.preventDefault()
  }
  document.dispatchEvent(event)
  return event
}

/** 在 body 里放一个「可见」的 el-drawer（jsdom 下 getClientRects 恒空，这里手动补） */
function mountVisibleOverlay () {
  const el = document.createElement('div')
  el.className = 'el-drawer'
  el.getClientRects = () => [{}]
  document.body.appendChild(el)
  return el
}

describe('useGraphFullscreen', () => {
  it('toggleFullscreen：翻状态 + 发 fullscreen-change + nextTick 后重排画布并聚焦按钮', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)

    fullscreen.toggleFullscreen()
    await nextTick()

    expect(fullscreen.fullscreen).toBe(true)
    expect(ctx.emit).toHaveBeenCalledWith('fullscreen-change', true)
    expect(ctx.graphCanvasRef.value.relayoutForViewport).toHaveBeenCalledTimes(1)
    expect(ctx.fullscreenButton.value.$el.focus).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('toggleFullscreen 同时收起「查询与操作」浮层', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)

    fullscreen.toolsOpen = true
    fullscreen.toggleFullscreen()

    expect(fullscreen.toolsOpen).toBe(false)
    wrapper.unmount()
  })

  it('closeTools 只收浮层', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)

    fullscreen.toolsOpen = true
    fullscreen.closeTools()

    expect(fullscreen.toolsOpen).toBe(false)
    expect(ctx.emit).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('exitFullscreen：全屏中才退出；非全屏时是空操作', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)

    fullscreen.exitFullscreen()
    expect(fullscreen.fullscreen).toBe(false)

    fullscreen.toggleFullscreen()
    fullscreen.exitFullscreen()
    expect(fullscreen.fullscreen).toBe(false)
    wrapper.unmount()
  })

  it('document keydown：非全屏时按 Esc 什么都不做', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)

    pressEscape()

    expect(fullscreen.fullscreen).toBe(false)
    wrapper.unmount()
  })

  it('document keydown：全屏 + 浮层关着 → 退出全屏', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)
    fullscreen.toggleFullscreen()

    pressEscape()

    expect(fullscreen.fullscreen).toBe(false)
    wrapper.unmount()
  })

  it('document keydown：全屏 + 浮层开着 → 只收浮层，不退出全屏', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)
    fullscreen.toggleFullscreen()
    fullscreen.toolsOpen = true

    pressEscape()

    expect(fullscreen.toolsOpen).toBe(false)
    expect(fullscreen.fullscreen).toBe(true)
    wrapper.unmount()
  })

  it('document keydown：有可见抽屉/弹窗时 Esc 让给抽屉，全屏状态不动', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)
    fullscreen.toggleFullscreen()
    const overlay = mountVisibleOverlay()

    pressEscape()

    expect(fullscreen.fullscreen).toBe(true)
    overlay.remove()
    wrapper.unmount()
  })

  it('document keydown：非 Escape 键与 preventDefault 过的事件都被忽略', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)
    fullscreen.toggleFullscreen()

    pressEscape({ key: 'Enter' })
    expect(fullscreen.fullscreen).toBe(true)

    pressEscape({ defaultPrevented: true })
    expect(fullscreen.fullscreen).toBe(true)
    wrapper.unmount()
  })

  it('卸载时移除 keydown 监听（再按 Esc 不再有任何反应）', async () => {
    const ctx = makeCtx()
    const { wrapper, fullscreen } = await mountHost(ctx)
    wrapper.unmount()

    pressEscape()

    expect(fullscreen.fullscreen).toBe(false)
    expect(ctx.emit).not.toHaveBeenCalled()
  })
})
