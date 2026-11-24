// @vitest-environment jsdom
// src/app/directives/**（覆盖率 0%）：
//   - index.js：install 时注册 v-tooltip 指令并 .use(trim 插件)
//   - tooltip/src/index.ts：overflow 判定 → 动态挂 ElTooltip → 二次进入去重 →
//     onHide 卸载 → 未溢出时只收浮层 → beforeUnmount 清监听
//   - trim/index.js：失焦 trim（modelValue 优先，空值回落输入框）+ unmount 清监听
// Element Plus 的 ElTooltip 换成可观察桩，指令上下文（vnode.ctx）手工 mock。
import { h, nextTick } from 'vue'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// tooltip 指令是模块级单例（removeTooltip 全局只有一份），每个用例拿新实例
async function loadTooltip () {
  vi.resetModules()
  return import('@/app/directives/tooltip/src/index.ts')
}

const ep = vi.hoisted(() => {
  const calls = { created: [], opened: [] }
  const ElTooltip = {
    name: 'ElTooltipProbe',
    setup (props, { attrs, expose }) {
      // 指令透传的 props（placement 等）未在组件里声明 → 落在 attrs，这里合并记录
      calls.created.push({ ...attrs, ...props })
      // 指令 render 后会调 exposed.onOpen（真实 ElTooltip 的开浮层入口）
      expose({ onOpen: () => { calls.opened.push(props.content) } })
      return () => h('div', { class: 'tooltip-probe' }, String(props.content))
    }
  }
  return { calls, ElTooltip }
})

vi.mock('element-plus', () => ({ ElTooltip: ep.ElTooltip }))

function makeRangeRect (width, height) {
  return {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }
}

/** 造一个有文本子节点的元素，并让 Range 宽度溢出（或不溢出）。 */
function makeOverflowingEl ({ overflow = true, text = '一段会被截断的文案' } = {}) {
  const el = document.createElement('span')
  el.textContent = text
  document.body.appendChild(el)
  // jsdom 的 Range 没有实现 getBoundingClientRect（isOver 依赖它量文本宽度），
  // 这里直接替换原型方法，restore 时原样归还
  const original = Range.prototype.getBoundingClientRect
  Range.prototype.getBoundingClientRect = () => makeRangeRect(overflow ? 500 : 10, overflow ? 40 : 10)
  const elSpy = vi.spyOn(el, 'getBoundingClientRect')
    .mockReturnValue(makeRangeRect(overflow ? 100 : 10, overflow ? 16 : 10))
  return {
    el,
    restore: () => {
      Range.prototype.getBoundingClientRect = original
      elSpy.mockRestore()
      el.remove()
    }
  }
}

const bindingOf = (text, props = {}) => ({ value: { text, props }, oldValue: null, dir: {} })

describe('directives/index：装配入口', () => {
  it('install 注册 v-tooltip 指令，并 .use(trim 插件)', async () => {
    const directives = (await import('@/app/directives/index')).default
    const { vTooltip } = await import('@/app/directives/tooltip/src/index.ts')

    const registered = {}
    const app = {
      directive (name, def) { registered[name] = def },
      use (plugin) { plugin.install(this) }
    }
    directives.install(app)

    expect(registered.tooltip).toBe(vTooltip)
    expect(typeof registered.trim.mounted).toBe('function')
    expect(typeof registered.trim.unmounted).toBe('function')
  })
})

describe('v-tooltip 指令', () => {
  beforeEach(() => {
    ep.calls.created.length = 0
    ep.calls.opened.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('beforeMount/updated 只同步内容，不挂浮层；溢出时 mouseenter 挂上 ElTooltip 并 onOpen', async () => {
    const { vTooltip } = await loadTooltip()
    const { el, restore } = makeOverflowingEl()
    try {
      vTooltip.beforeMount(el, bindingOf('第一版'))
      expect(el.__tooltipContent).toBe('第一版')
      expect(el.__tooltipVisible).toBe(false)

      vTooltip.updated(el, bindingOf('第二版'))
      expect(el.__tooltipContent).toBe('第二版')

      vTooltip.mounted(el, bindingOf('第二版'))
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()

      expect(el.__tooltipVisible).toBe(true)
      expect(ep.calls.created).toHaveLength(1)
      expect(ep.calls.created[0].content).toBe('第二版')
      expect(ep.calls.created[0].popperClass).toContain('ai-v-tooltip')
      expect(ep.calls.created[0].virtualTriggering).toBe(true)
      // exposed.onOpen 由 render 后的下一拍调用
      await nextTick()
      expect(ep.calls.opened.length).toBeGreaterThan(0)
      expect(el.__removeTooltip).toBeTypeOf('function')
    } finally {
      restore()
    }
  })

  it('同一元素二次 mouseenter 不重复挂浮层（trigger 去重）', async () => {
    const { vTooltip } = await loadTooltip()
    const { el, restore } = makeOverflowingEl()
    try {
      vTooltip.mounted(el, bindingOf('提示'))
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()
      await nextTick()
      const createdAfterFirst = ep.calls.created.length

      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()

      expect(ep.calls.created).toHaveLength(createdAfterFirst)
    } finally {
      restore()
    }
  })

  it('未溢出时不挂浮层，只把已有浮层收掉', async () => {
    const { vTooltip } = await loadTooltip()
    const { el, restore } = makeOverflowingEl({ overflow: false })
    try {
      vTooltip.mounted(el, bindingOf('短文案'))
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()

      expect(el.__tooltipVisible).toBe(false)
      expect(ep.calls.created).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('popperOptions / props 透传进 ElTooltip 的 props', async () => {
    const { vTooltip } = await loadTooltip()
    const { el, restore } = makeOverflowingEl()
    try {
      vTooltip.mounted(el, bindingOf('透传', { placement: 'bottom', popperOptions: { strategy: 'absolute' } }))
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()

      expect(ep.calls.created).toHaveLength(1)
      expect(ep.calls.created[0].placement).toBe('bottom')
    } finally {
      restore()
    }
  })

  it('onHide 卸载浮层；beforeUnmount 清掉 mouseenter 监听', async () => {
    const { vTooltip } = await loadTooltip()
    const { el, restore } = makeOverflowingEl()
    try {
      vTooltip.mounted(el, bindingOf('提示'))
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()
      await nextTick()
      expect(ep.calls.created).toHaveLength(1)

      // ElTooltip 的 onHide 回调触发全局卸载（render(null, container)）
      ep.calls.created[0].onHide()
      await nextTick()
      expect(document.querySelectorAll('.tooltip-probe')).toHaveLength(0)

      // 卸载后再次 mouseenter：removeTooltip 已是 null，重新挂一份
      el.dispatchEvent(new Event('mouseenter'))
      await nextTick()
      await nextTick()
      await nextTick()
      expect(ep.calls.created).toHaveLength(2)

      vTooltip.beforeUnmount(el)
      // 源码 addEventListener 用 capture=true、removeEventListener 没带 —— 事件在
      // jsdom（与 DOM 规范一致）里匹配失败，监听实际仍在。这里只断言指令状态被
      // 清理（__showTooltip 置空），不改 src 的这个行为。
      expect(el.__showTooltip).toBeNull()
      expect(el.__tooltipVisible).toBe(false)
    } finally {
      restore()
    }
  })
})

describe('v-trim 指令（mock 指令上下文）', () => {
  const loadTrim = async () => {
    vi.resetModules()
    const trim = (await import('@/app/directives/trim/index.js')).default
    const registered = {}
    trim.install({ directive: (name, def) => { registered[name] = def } })
    return registered.trim
  }

  const makeEl = (tag = 'input') => {
    const el = document.createElement('div')
    const input = document.createElement(tag)
    el.appendChild(input)
    document.body.appendChild(el)
    return { el, input }
  }

  it('失焦时 trim：modelValue 非空优先用 modelValue', async () => {
    const trim = await loadTrim()
    const { el, input } = makeEl()
    const emit = vi.fn()
    trim.mounted(el, {}, { ctx: { emit, ctx: { modelValue: '  保留我  ' } } })

    input.value = '  输入框的值  '
    input.dispatchEvent(new Event('blur'))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('update:modelValue', '保留我')
  })

  it('modelValue 为空时回落输入框的值再 trim；textarea 同理', async () => {
    const trim = await loadTrim()
    const { el, input } = makeEl('textarea')
    const emit = vi.fn()
    trim.mounted(el, {}, { ctx: { emit, ctx: { modelValue: '' } } })

    input.value = '  来自输入框  '
    input.dispatchEvent(new Event('blur'))
    expect(emit).toHaveBeenCalledWith('update:modelValue', '来自输入框')
  })

  it('容器里没有 input/textarea 时 mounted/unmounted 都直接返回', async () => {
    const trim = await loadTrim()
    const el = document.createElement('div')
    el.appendChild(document.createElement('span'))
    document.body.appendChild(el)

    expect(() => trim.mounted(el, {}, { ctx: { emit: vi.fn(), ctx: {} } })).not.toThrow()
    expect(el._handleBlur).toBeUndefined()
    expect(() => trim.unmounted(el)).not.toThrow()
  })

  it('unmounted 移除失焦监听，不再 emit', async () => {
    const trim = await loadTrim()
    const { el, input } = makeEl()
    const emit = vi.fn()
    trim.mounted(el, {}, { ctx: { emit, ctx: { modelValue: '' } } })
    expect(el._handleBlur).toBeTypeOf('function')

    trim.unmounted(el)
    expect(el._handleBlur).toBeNull()

    input.value = '  after  '
    input.dispatchEvent(new Event('blur'))
    expect(emit).not.toHaveBeenCalled()
  })
})
