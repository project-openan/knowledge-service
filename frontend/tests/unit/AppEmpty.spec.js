// @vitest-environment jsdom
//
// 测的是 `src/shared/ui/AppEmpty.vue`：全站统一的 空态 / 加载态 / 错误态。
// 三个约定要钉住：
//   - 错误态是 `role="alert"` 且必带重试入口（取数失败的唯一兜底交互）；
//   - 加载态是 `aria-busy="true"` + 旋转图标（表格内局部刷新不重复出现）；
//   - 文案取自公共词条（拼错键名会直接把键名渲染成文本，用例立刻红）。
import { h } from 'vue'
import { expectNoI18nMisses, findByText, mountWithPlugins, textOf } from './helpers/mount'
import AppEmpty from '@/shared/ui/AppEmpty.vue'

// AppEmpty 的默认文案走 script 里的全局 `$t`（i18n.js，按 localStorage/浏览器语言
// 定语言），不走脚手架注入的 zh 插件实例 —— 这里把宿主语言钉成中文，断言才稳定。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

describe('AppEmpty 空态', () => {
  it('默认（无标题/描述）显示「暂无数据」，role=status，空盒图标', async () => {
    const wrapper = await mountWithPlugins(AppEmpty)

    expect(wrapper.classes()).toContain('app-empty--empty')
    expect(textOf(wrapper.find('.app-empty__title'))).toBe('暂无数据')
    expect(wrapper.find('.app-empty__description').exists()).toBe(false)
    expect(wrapper.find('.app-empty__icon').exists()).toBe(true)
    expect(wrapper.find('.app-empty__spinner').exists()).toBe(false)
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-busy')).toBe('false')
    expectNoI18nMisses(wrapper)
  })

  it('只给 description 时不显示标题（空态标题让位给描述）', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { description: '还没有上传任何文档' } })

    expect(wrapper.find('.app-empty__title').exists()).toBe(false)
    expect(textOf(wrapper.find('.app-empty__description'))).toBe('还没有上传任何文档')
  })

  it('compact 模式加紧凑类（表格内空态用）', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { compact: true } })

    expect(wrapper.classes()).toContain('app-empty--compact')
  })
})

describe('AppEmpty 加载态', () => {
  it('旋转图标 + 「加载中...」 + aria-busy=true', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { state: 'loading' } })

    expect(wrapper.classes()).toContain('app-empty--loading')
    expect(wrapper.find('.app-empty__spinner.is-loading').exists()).toBe(true)
    expect(textOf(wrapper.find('.app-empty__title'))).toBe('加载中...')
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.attributes('role')).toBe('status')
    expectNoI18nMisses(wrapper)
  })
})

describe('AppEmpty 错误态', () => {
  it('错误图标 + 默认文案 + 重试按钮，role=alert', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { state: 'error' } })

    expect(wrapper.classes()).toContain('app-empty--error')
    expect(wrapper.find('.app-empty__icon--error').exists()).toBe(true)
    expect(textOf(wrapper.find('.app-empty__title'))).toBe('加载失败')
    expect(textOf(wrapper.find('.app-empty__description'))).toBe('数据获取失败，请稍后重试')
    expect(wrapper.attributes('role')).toBe('alert')
    expect(findByText(wrapper, '重试', 'button')).not.toBeNull()
    expectNoI18nMisses(wrapper)
  })

  it('点重试发 retry 事件（页面拿它重新取数）', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { state: 'error' } })

    await findByText(wrapper, '重试', 'button').trigger('click')

    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('retryText 覆盖默认按钮文案；非错误态不出现重试按钮', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, { props: { state: 'error', retryText: '再拉一次' } })
    expect(findByText(wrapper, '再拉一次', 'button')).not.toBeNull()

    const empty = await mountWithPlugins(AppEmpty, { props: { state: 'loading' } })
    expect(empty.find('button').exists()).toBe(false)
  })

  it('title/description props 覆盖默认错误文案', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, {
      props: { state: 'error', title: '图谱加载失败', description: '请检查网络后重试' }
    })

    expect(textOf(wrapper.find('.app-empty__title'))).toBe('图谱加载失败')
    expect(textOf(wrapper.find('.app-empty__description'))).toBe('请检查网络后重试')
  })
})

describe('AppEmpty 插槽', () => {
  it('title / description 具名插槽覆盖默认文案', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, {
      props: { state: 'error' },
      slots: {
        title: () => h('span', '插槽标题'),
        description: () => h('span', '插槽描述')
      }
    })

    expect(textOf(wrapper.find('.app-empty__title'))).toBe('插槽标题')
    expect(textOf(wrapper.find('.app-empty__description'))).toBe('插槽描述')
  })

  it('默认插槽渲染进操作区（自定义动作与重试并列）', async () => {
    const wrapper = await mountWithPlugins(AppEmpty, {
      props: { state: 'error' },
      slots: { default: () => h('button', { class: 'custom-action' }, '去新建') }
    })

    expect(wrapper.find('.custom-action').exists()).toBe(true)
    // 插槽存在不该挤掉重试入口
    expect(findByText(wrapper, '重试', 'button')).not.toBeNull()
  })
})
