// @vitest-environment jsdom
/**
 * CreateKnowledgeGraphTemplateDialog.vue —— 「新建图谱模版」弹窗。
 *
 * 组件经 `getCurrentInstance().proxy` 读 $t / $router / $message，测试里把
 * `$t` 注入成真词条（zh）翻译函数（与 mount helper 的「不 mock 词条」口径一致）。
 * el-dialog 用透传替身（含 footer 与右上角关闭叉走 before-close）；
 * el-form 用真件 —— 名称/描述的自定义 validator 走 async-validator 真实链路。
 *
 * 覆盖：openDialog/closeHandle 的表单重置与默认名生成、名称校验三分支
 * （必填/长度/非法字符）、描述校验三分支（必填/长度/全空格）、提交成功链
 * （close → 路由跳转 graph-template 并带 query）、校验失败不动、loading 状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { createTestI18n, flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElButton } from 'element-plus/es/components/button/index'
import trim from '@/app/directives/trim/index.js'
import CreateKnowledgeGraphTemplateDialog from '@/features/graph/CreateKnowledgeGraphTemplateDialog.vue'

const i18n = createTestI18n()
const t = i18n.global.t

/** el-dialog 透传件：标题/默认插槽/footer 全渲染；关闭叉触发 before-close。 */
const DialogPassthrough = {
  name: 'ElDialog',
  props: ['modelValue', 'title', 'width', 'beforeClose', 'closeOnClickModal'],
  emits: ['update:modelValue'],
  setup (props, { slots, emit }) {
    const closeX = () => props.beforeClose?.(() => emit('update:modelValue', false))
    return () => h('div', { class: 'test-dialog' }, [
      h('div', { class: 'test-dialog__title' }, props.title),
      h('button', { class: 'test-dialog__close', onClick: closeX }, '×'),
      props.modelValue ? (slots.default ? slots.default() : null) : null,
      props.modelValue && slots.footer ? slots.footer() : null
    ])
  }
}

const GLOBAL = {
  components: { ElDialog: DialogPassthrough, ElForm, ElFormItem, ElInput, ElButton },
  directives: { trim },
  stubs: { transition: false, 'transition-group': false },
  config: {
    globalProperties: {
      $globalZh: true,
      $t: (key, params) => t(key, params),
      $message: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() })
    }
  }
}

async function mountDialog () {
  // 组件经 proxy.$router 跳转，默认装 memory router（DEFAULT_ROUTES 里有 graph-template）
  return mountWithPlugins(CreateKnowledgeGraphTemplateDialog, { global: GLOBAL, route: '/graph' })
}

async function open (wrapper) {
  wrapper.vm.openDialog()
  await flush()
  await flush()
}

const dialogBody = wrapper => wrapper.find('.test-dialog')
const nameInput = wrapper => dialogBody(wrapper).find('input[maxlength="99"]')
const descTextarea = wrapper => dialogBody(wrapper).find('textarea')
const primaryButton = wrapper => dialogBody(wrapper).findAll('button.el-button')
  .find(b => b.text().includes(t('modules.kb.create')))
const formItem = (wrapper, prop) => wrapper.findAllComponents(ElFormItem)
  .find(item => item.props('prop') === prop)

/** 真实 EP 表单校验：blur/change 触发后有延迟，flush 两次拿最终状态。 */
async function validated (wrapper) {
  await flush()
  await flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  await flush()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('开合与默认值', () => {
  it('初始关闭：不渲染表单；openDialog 后表单出现且带默认名（用户名_时间戳）', async () => {
    const wrapper = await mountDialog()
    expect(dialogBody(wrapper).find('form').exists()).toBe(false)

    await open(wrapper)
    const name = nameInput(wrapper)
    expect(name.element.value).toMatch(/^user_\d{13}$/)
    expect(descTextarea(wrapper).element.value).toBe('')
  })

  it('openDialog 重置 loading 与表单；closeHandle 回默认值', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('自定义模版')
    wrapper.vm.closeHandle()
    await flush()
    expect(dialogBody(wrapper).find('form').exists()).toBe(false)

    await open(wrapper)
    expect(nameInput(wrapper).element.value).toMatch(/^user_\d{13}$/)
  })
})

describe('名称校验（validator + pattern）', () => {
  it('空名称：必填提示', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    const item = formItem(wrapper, 'name')
    expect(item.vm.validateState).toBe('error')
    expect(item.vm.validateMessage).toBe(t('modules.kb.inputKnowledgeGraphTemplateName'))
    // 校验失败不跳转
    expect(wrapper.router.currentRoute.value.name).not.toBe('graph-template')
  })

  it('非法字符（名称含 - 与 .）：pattern 拦截', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('TEST-regress.tpl')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'name').vm.validateMessage).toBe(t('modules.kb.templateNameCharsError'))
    expect(wrapper.router.currentRoute.value.name).not.toBe('graph-template')
  })

  it('合法名称：校验通过（无错误信息）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('影视模版_2026')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'name').vm.validateState).not.toBe('error')
  })
})

describe('描述校验', () => {
  it('空描述：必填提示', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('合法名称')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'description').vm.validateMessage).toBe(t('modules.kb.inputKnowledgeGraphTemplateDescription'))
  })

  it('全空格描述：空白校验分支', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('合法名称')
    await descTextarea(wrapper).setValue('    ')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'description').vm.validateMessage).toBe(t('modules.kb.descCannotBeWhitespace'))
  })

  it('合法描述：通过且成功提交（路由跳转 + 弹窗关闭）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('合同模版')
    await descTextarea(wrapper).setValue('用于合同抽取')
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(wrapper.router.currentRoute.value.name).toBe('graph-template')
    expect(wrapper.router.currentRoute.value.params).toEqual({ templateId: 'new' })
    expect(wrapper.router.currentRoute.value.query).toEqual({
      templateName: '合同模版',
      templateDescription: '用于合同抽取'
    })
    // closeHandle 在跳转前已把弹窗关掉
    expect(dialogBody(wrapper).find('form').exists()).toBe(false)
  })
})

describe('关闭链路', () => {
  it('取消按钮直接关闭并重置表单', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('将被丢弃的名字')
    const cancel = dialogBody(wrapper).findAll('button.el-button')
      .find(b => b.text().includes(t('public.cancel')))
    await cancel.trigger('click')
    await flush()

    expect(dialogBody(wrapper).find('form').exists()).toBe(false)
    await open(wrapper)
    expect(nameInput(wrapper).element.value).toMatch(/^user_\d{13}$/)
  })

  it('右上角关闭叉走 before-close：先重置再放行', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await wrapper.find('.test-dialog__close').trigger('click')
    await flush()
    // 放行后 dialog 的 v-model 为 false（表单区卸载）
    expect(dialogBody(wrapper).find('form').exists()).toBe(false)
  })
})

describe('补充分支', () => {
  it('名称超过 99 字：长度分支（maxlength 属性不拦程序赋值）', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('名'.repeat(100))
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'name').vm.validateMessage).toBe(t('modules.kb.templateNameLengthError'))
  })

  it('描述超过 1000 字：长度分支带插值', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('合法名称')
    await descTextarea(wrapper).setValue('述'.repeat(1001))
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(formItem(wrapper, 'description').vm.validateMessage).toBe(
      t('modules.kb.descLengthInvalid', { length: 1001 })
    )
  })

  it('路由跳转失败：错误提示拼接 error.message，loading 复位', async () => {
    const wrapper = await mountDialog()
    await open(wrapper)
    await nameInput(wrapper).setValue('合法名称')
    await descTextarea(wrapper).setValue('描述')
    // 组件里 push 未 await：只有同步抛错才会进 catch（防御分支）
    const pushSpy = vi.spyOn(wrapper.router, 'push').mockImplementation(() => {
      throw new Error('boom')
    })
    await primaryButton(wrapper).trigger('click')
    await validated(wrapper)

    expect(GLOBAL.config.globalProperties.$message.error).toHaveBeenCalledWith(
      `${t('public.createFail')}boom`
    )
    expect(pushSpy).toHaveBeenCalled()
    // closeHandle 已把弹窗关掉（footer 卸载），loading 由 finally 复位
    expect(dialogBody(wrapper).find('form').exists()).toBe(false)
  })
})
