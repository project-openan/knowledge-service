// @vitest-environment jsdom
//
// 收尾补漏：`src/shared/lib` 里已有专测的模块，把各自剩下的边界分支收掉：
//   - language.js：localStorage 缺失 / 存了非法 JSON / 同语言不重载；
//   - theme.ts：localStorage 抛异常（隐私模式）时回落默认主题；
//   - clipboard.js：非安全上下文（isSecureContext=false 但 clipboard 对象在）走
//     execCommand；execCommand 自身抛错时报告失败；
//   - reportError.js：context 只有 label / 只有 key 的取值顺序；
//   - StatusText.vue：带 icon 时不画圆点、size=small、prefix 插槽优先；
//   - CaptchaInput.vue：defineExpose 的 `captcha` getter。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

import {
  EN_US, LANGUAGE_STORAGE_KEY, ZH_CN,
  isChineseLanguage, normalizeLanguage, readEffectiveLanguage, switchLanguage
} from '@/shared/lib/language'
import { DEFAULT_THEME, readStoredTheme } from '@/shared/lib/theme'
import copyText from '@/shared/lib/clipboard'
import reportError from '@/shared/lib/reportError'
import { mountWithPlugins, textOf } from './helpers/mount'
import StatusText from '@/shared/ui/StatusText.vue'
import CaptchaInput from '@/shared/ui/CaptchaInput.vue'
import { h } from 'vue'

describe('language.js（语言读取与切换的边界）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify('zh-CN'))
  })

  it('localStorage 不可用（typeof undefined）时直接回落 zh-CN，不抛错', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readEffectiveLanguage()).toBe(ZH_CN)
  })

  it('存了非法 JSON（裸 en）时按「没设过」处理，回落浏览器语言', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en') // 不是合法 JSON 字符串

    expect(readEffectiveLanguage()).toBe('en-US')
  })

  it('localStorage 与浏览器语言都拿不到时兜底 zh-CN', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('navigator', { language: '' })

    expect(readEffectiveLanguage()).toBe(ZH_CN)
  })

  it('zh-TW 等其余中文变体也算中文界面', () => {
    expect(isChineseLanguage('zh-TW')).toBe(true)
    expect(isChineseLanguage('en-GB')).toBe(false)
  })

  it('normalizeLanguage 只认 zh-CN，其余一律归一到 en-US', () => {
    expect(normalizeLanguage('zh-CN')).toBe(ZH_CN)
    expect(normalizeLanguage('zh-TW')).toBe(EN_US)
    expect(normalizeLanguage(undefined)).toBe(EN_US)
  })

  it('切到当前语言：返回 false 且不写 localStorage（无需重载）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})

    expect(switchLanguage('zh-CN')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('切到另一语言：写入新值并触发整页重载（jsdom 会打一条 reload 未实现的日志，属预期）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})

    try {
      expect(switchLanguage('en-US')).toBe(true)
      expect(spy).toHaveBeenCalledWith(LANGUAGE_STORAGE_KEY, JSON.stringify('en-US'))
    } finally {
      spy.mockRestore()
    }
  })
})

describe('theme.ts（localStorage 抛异常的兜底）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('读 localStorage 抛异常（隐私模式）时回落默认主题，不抛错', () => {
    vi.stubGlobal('localStorage', {
      getItem () { throw new Error('SecurityError') }
    })

    expect(readStoredTheme()).toBe(DEFAULT_THEME)
  })
})

describe('clipboard.js（回落链路的剩余分支）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubNavigator (clipboard) {
    vi.stubGlobal('navigator', { clipboard })
  }

  it('非安全上下文（clipboard 对象存在但 isSecureContext=false）：直接走 execCommand', async () => {
    // jsdom 的 window.isSecureContext 就是 false —— 正好是「HTTP 部署」形态。
    // jsdom 没有 document.execCommand，直接赋一个桩（照既有 clipboard.spec.js 的写法）。
    const writeText = vi.fn()
    stubNavigator({ writeText })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
    delete document.execCommand
  })

  it('execCommand 自身抛错：报告失败并清理 textarea，不把异常抛给调用方', async () => {
    stubNavigator(undefined)
    document.execCommand = () => {
      throw new Error('execCommand blocked')
    }

    await expect(copyText('hello')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
    delete document.execCommand
  })
})

describe('reportError.js（context 取值顺序）', () => {
  // spy 在本 describe 内自建自清理 —— 上面的 clipboard 用例不能共享它
  //（restoreAllMocks 会把跨用例的 spy 一并还原，导致这里静默归零）。
  let consoleError

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('context 只有 label：控制台用 label，文案回落默认 key', () => {
    reportError(new Error('boom'), { label: 'GraphCanvas init' })

    expect(consoleError).toHaveBeenCalledWith('GraphCanvas init', expect.any(Error))
  })

  it('context 只有 key：控制台与 i18n 都用它', () => {
    reportError(new Error('boom'), { key: 'public.loadFailed' })

    expect(consoleError).toHaveBeenCalledWith('public.loadFailed', expect.any(Error))
  })
})

describe('StatusText.vue（图标与插槽形态）', () => {
  const glyph = { render: () => h('i', { class: 'glyph' }) }

  it('带 icon 时不画语义圆点（图标本身就是视觉标记）', async () => {
    const wrapper = await mountWithPlugins(StatusText, {
      props: { type: 'info', icon: glyph },
      slots: { default: () => '运行中' }
    })

    expect(wrapper.find('.glyph').exists()).toBe(true)
    expect(wrapper.find('.status-text__dot').exists()).toBe(false)
    expect(textOf(wrapper)).toBe('运行中')
  })

  it('语义 type 画对应色圆点；size=small 加紧凑类', async () => {
    const wrapper = await mountWithPlugins(StatusText, {
      props: { type: 'success', size: 'small' },
      slots: { default: () => '已启用' }
    })

    const dot = wrapper.find('.status-text__dot')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('style')).toContain('var(--el-color-success)')
    expect(wrapper.find('.status-text--small').exists()).toBe(true)
    expect(wrapper.find('.status-text__icon').exists()).toBe(false)
  })

  it('custom type 不带色：不干预颜色也不画点（跟随父级）', async () => {
    const wrapper = await mountWithPlugins(StatusText, {
      props: { type: 'custom' },
      slots: { default: () => '中性文本' }
    })

    expect(wrapper.attributes('style')).toBeUndefined()
    expect(wrapper.find('.status-text__dot').exists()).toBe(false)
  })

  it('#prefix 插槽优先于内置圆点/图标', async () => {
    const wrapper = await mountWithPlugins(StatusText, {
      props: { type: 'error' },
      slots: {
        prefix: () => h('b', { class: 'prefix-mark' }),
        default: () => '失败'
      }
    })

    expect(wrapper.find('.prefix-mark').exists()).toBe(true)
    expect(wrapper.find('.status-text__dot').exists()).toBe(false)
    expect(textOf(wrapper)).toBe('失败')
  })
})

describe('CaptchaInput.vue（defineExpose 的 captcha getter）', () => {
  it('captcha getter 返回当前显示码（与 validate 比对的是同一个值）', async () => {
    const wrapper = await mountWithPlugins(CaptchaInput, {
      props: { customRandomCaptcha: '42' }
    })

    expect(wrapper.vm.captcha).toBe('42')
    expect(wrapper.vm.validate()).toBe(false) // 尚未输入
    await wrapper.find('input').setValue('42')
    // 根组件没有父级 v-model，手动把输入回灌成 props（真实调用方由 v-model 完成）
    await wrapper.setProps({ modelValue: '42' })
    expect(wrapper.vm.validate()).toBe(true)
  })
})
