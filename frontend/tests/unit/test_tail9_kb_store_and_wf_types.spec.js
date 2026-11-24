// @vitest-environment jsdom
/**
 * 三块小而未被覆盖的源码：
 * - `features/knowledge-base/store.js`：Vuex 模块（folderInfo / faqCategoryInfo /
 *   kBaseName 三个 mutation，直接以「模块 + 手造 state」驱动）；
 * - `features/workflow/types.ts`：枚举 + 组件主题表。文件里用 CJS `require()`
 *   引 svg 资产，vitest 是 ESM —— 这里用 Node 的 `Module._resolveFilename` 钩子把
 *   `@/assets/*.svg` 映射到真实路径并注册 `.svg` 加载器（只在此测试期间生效）；
 * - `features/workflow/upAndDownItem.vue`：级联下拉项的行内上移/下移/删除
 *   （TableIcon 的 disabled 语义：首行禁上移、末行禁下移）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Module from 'node:module'
import { resolve } from 'node:path'

import { flush, mountWithPlugins } from './helpers/mount'
import kbStore from '@/features/knowledge-base/store.js'
import { workflowState, installLegacyWorkflowStateCompat } from '@/features/workflow/store.js'
import UpAndDownItem from '@/features/workflow/upAndDownItem.vue'
import { EventBus } from '@/shared/events.js'

describe('knowledge-base/store.js（Vuex 模块）', () => {
  function freshState () {
    return {
      folderInfo: {},
      faqCategoryInfo: {},
      kBaseName: ''
    }
  }

  it('updateFolderInfo：整个对象替换写入 state.folderInfo', () => {
    const state = freshState()
    const folder = { id: 'f-1', title: '合同目录' }
    kbStore.mutations.updateFolderInfo(state, folder)
    expect(state.folderInfo).toBe(folder)
  })

  it('updateFaqCategoryInfo：高频问答分类树替换写入', () => {
    const state = freshState()
    const tree = { id: 'faq-1', children: [] }
    kbStore.mutations.updateFaqCategoryInfo(state, tree)
    expect(state.faqCategoryInfo).toBe(tree)
  })

  it('updatekBaseName：知识库名称写入', () => {
    const state = freshState()
    kbStore.mutations.updatekBaseName(state, '手册库')
    expect(state.kBaseName).toBe('手册库')
  })

  it('模块形状：namespaced + state 对象，getters/actions 为空表', () => {
    expect(kbStore.namespaced).toBe(true)
    expect(kbStore.state).toEqual({ folderInfo: {}, faqCategoryInfo: {}, kBaseName: '' })
    expect(kbStore.getters).toEqual({})
    expect(kbStore.actions).toEqual({})
  })
})

describe('workflow/store.js（reactive 单例 + 旧写入路径兼容桥）', () => {
  it('workflowState 单例可读写（编辑态 / 引擎类型 / 新手引导变量）', () => {
    const previous = { ...workflowState }
    try {
      workflowState.isAdvancedFlowEditMode = true
      workflowState.ragWorkflowType = 'SequentialQueryEngine'
      workflowState.flow.userGuideVariables = { city: '杭州' }
      expect(workflowState).toMatchObject({
        isAdvancedFlowEditMode: true,
        ragWorkflowType: 'SequentialQueryEngine'
      })
      expect(workflowState.flow.userGuideVariables).toEqual({ city: '杭州' })
    } finally {
      Object.assign(workflowState, previous)
    }
  })

  it('installLegacyWorkflowStateCompat：rootState.ragWorkflowType 读写转发到同一份数据', () => {
    const rootState = {}
    installLegacyWorkflowStateCompat(rootState)

    const previous = workflowState.ragWorkflowType
    try {
      rootState.ragWorkflowType = 'IterativeQueryEngine'
      expect(workflowState.ragWorkflowType).toBe('IterativeQueryEngine')

      workflowState.ragWorkflowType = 'LoopQueryEngine'
      expect(rootState.ragWorkflowType).toBe('LoopQueryEngine')
    } finally {
      workflowState.ragWorkflowType = previous
    }
  })
})

describe('workflow/types.ts（枚举与组件主题）', () => {
  it('ComponentEnum 四个检索链路组件常量', async () => {
    const { ComponentEnum } = await importTypes()
    expect(ComponentEnum).toEqual({
      PRE_RETRIEVER: 'PRE_RETRIEVER',
      RETRIEVER: 'RETRIEVER',
      POST_RETRIEVER: 'POST_RETRIEVER',
      RESPONSE_SYNTHESIZER: 'RESPONSE_SYNTHESIZER'
    })
  })

  it('ComponentThemes：四个主题各带 theme/icon/iconGray', async () => {
    const { ComponentThemes } = await importTypes()
    expect(Object.keys(ComponentThemes)).toEqual([
      'PRE_RETRIEVER', 'RETRIEVER', 'POST_RETRIEVER', 'RESPONSE_SYNTHESIZER'
    ])
    for (const [name, theme] of Object.entries(ComponentThemes)) {
      expect(theme.theme, `${name}.theme`).toBe(
        { PRE_RETRIEVER: 'purple', RETRIEVER: 'orange', POST_RETRIEVER: 'primary', RESPONSE_SYNTHESIZER: 'green' }[name]
      )
      expect(theme.icon, `${name}.icon`).toBeTruthy()
      expect(theme.iconGray, `${name}.iconGray`).toBeTruthy()
    }
  })

  /** 设置 `.svg` 的 CJS 加载钩子后再 import（见文件头说明）。 */
  async function importTypes () {
    const originalResolve = Module._resolveFilename
    Module._resolveFilename = function (request, parent, ...rest) {
      if (request.startsWith('@/')) {
        return originalResolve.call(this, resolve(process.cwd(), 'src', request.slice(2)), parent, ...rest)
      }
      return originalResolve.call(this, request, parent, ...rest)
    }
    Module._extensions['.svg'] = (mod) => { mod.exports = 'svg-stub' }
    try {
      return await import('@/features/workflow/types.ts')
    } finally {
      Module._resolveFilename = originalResolve
      delete Module._extensions['.svg']
    }
  }
})

describe('workflow/upAndDownItem.vue（级联下拉项）', () => {
  beforeEach(() => {
    // 组件从 main.js 挂的全局实例读 $t（tests 里没有 main.js，手工补一个）
    window.aipVueInstance = { $t: (key) => key }
  })

  afterEach(() => {
    delete window.aipVueInstance
    document.body.innerHTML = ''
  })

  async function mountItem (props = {}) {
    return mountWithPlugins(UpAndDownItem, {
      router: null,
      props: {
        inputVariable: { key: 'chunk', label: '切块', sourceNode: 'node-1' },
        index: 1,
        lastIndex: 2,
        isMode: true,
        ...props
      }
    })
  }

  it('渲染：label 文案与三个操作图标（上移/下移/删除）', async () => {
    const wrapper = await mountItem()
    expect(wrapper.text()).toContain('切块')

    const icons = wrapper.findAll('.ai-table-icon-root')
    expect(icons.length).toBe(3)
    // 首行禁上移、末行禁下移（index=1, lastIndex=2 都不是边界）
    expect(icons[0].find('.ai-button-icon--disabled').exists()).toBe(false)
    expect(icons[1].find('.ai-button-icon--disabled').exists()).toBe(false)
    // isMode=true 时删除图标可见（v-show）
    expect(icons[2].find('.plx-ico-delete-16').isVisible()).toBe(true)
  })

  it('点击上移/下移/删除：向父级转发同名事件', async () => {
    const wrapper = await mountItem()
    const icons = wrapper.findAll('.ai-table-icon-root')

    await icons[0].find('.ai-button-icon').trigger('click')
    await icons[1].find('.ai-button-icon').trigger('click')
    await icons[2].find('.plx-ico-delete-16').trigger('click')

    expect(wrapper.emitted('upHandle')).toHaveLength(1)
    expect(wrapper.emitted('downHandle')).toHaveLength(1)
    expect(wrapper.emitted('deleteHandle')).toHaveLength(1)
  })

  it('边界禁用：首行禁上移、末行禁下移（点了不转发）', async () => {
    const wrapper = await mountItem({ index: 0, lastIndex: 0 })
    const icons = wrapper.findAll('.ai-table-icon-root')

    await icons[0].find('.ai-button-icon').trigger('click')
    expect(wrapper.emitted('upHandle')).toBeUndefined()

    await icons[1].find('.ai-button-icon').trigger('click')
    expect(wrapper.emitted('downHandle')).toBeUndefined()
  })

  it('isMode=false：删除图标隐藏，但点击仍转发（v-show 不移除节点）', async () => {
    const wrapper = await mountItem({ isMode: false })
    const deleteIcon = wrapper.findAll('.ai-table-icon-root')[2].find('.plx-ico-delete-16')
    expect(deleteIcon.isVisible()).toBe(false)

    await deleteIcon.trigger('click')
    expect(wrapper.emitted('deleteHandle')).toHaveLength(1)
  })

  it('省略 props 时用默认值（默认 INPUT 行、非编辑态）', async () => {
    const wrapper = await mountWithPlugins(UpAndDownItem, { router: null })
    expect(wrapper.text()).toContain('INPUT')
    expect(wrapper.findAll('.ai-table-icon-root')[2].find('.plx-ico-delete-16').isVisible()).toBe(false)
  })

  it('EventBus：isEditMode 事件写入组件状态；卸载时解绑不抛错', async () => {
    const wrapper = await mountItem()
    EventBus.emit('isEditMode', true)
    await flush()
    expect(wrapper.vm.isEditMode).toBe(true)

    wrapper.unmount()
    // off 之后再次广播不应再改任何已卸载组件
    expect(() => EventBus.emit('isEditMode', false)).not.toThrow()
  })
})
