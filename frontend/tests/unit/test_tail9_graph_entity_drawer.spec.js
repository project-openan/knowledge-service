// @vitest-environment jsdom
/**
 * GraphEntityDrawer.vue —— 画布上的「编辑实体」抽屉（开态渲染 + 表单交互 + 保存两路）。
 *
 * el-drawer 在 helpers 里是占位件（不渲染 header/footer），这里换成透传替身：
 * header/默认/footer 插槽都真渲染，footer 的三个按钮才能点到。下拉仍用替身
 * （本抽屉里唯一一个 el-select 是什么都没有的场景），其余 EP 表单件用真件。
 *
 * 覆盖：草稿构造（模板类型优先）、名称/描述编辑、属性四类控件（文本/数字/布尔/JSON）、
 * JSON 格式化成功与失败、属性搜索（>5 条才出现）、保存校验失败的两类分支
 * （名称必填 + 属性错误码 json/jsonType/number/integer 各分支）、成功保存的事件载荷、
 * dirty 门控（定位/加关系按钮禁用）、关系列表选择、关闭与 saving 防抖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const copyMock = vi.hoisted(() => ({ copyTextWithToast: vi.fn(async () => true) }))
vi.mock('@/shared/lib/copy-with-toast', () => ({ copyTextWithToast: (...args) => copyMock.copyTextWithToast(...args) }))

import { flush, mountWithPlugins } from './helpers/mount'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index'
import { ElInput } from 'element-plus/es/components/input/index'
import { ElSwitch } from 'element-plus/es/components/switch/index'
import { ElButton } from 'element-plus/es/components/button/index'
import { h } from 'vue'
import GraphEntityDrawer from '@/features/graph/components/GraphEntityDrawer.vue'

/** el-drawer 透传件：header/默认/footer 全渲染，class 落到根节点。 */
const DrawerShell = {
  name: 'ElDrawer',
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  setup (props, { slots }) {
    return () => props.modelValue
      ? h('div', { class: 'drawer-shell' }, [
        h('div', { class: 'drawer-shell-header' }, slots.header?.()),
        h('div', { class: 'drawer-shell-body' }, slots.default?.()),
        h('div', { class: 'drawer-shell-footer' }, slots.footer?.())
      ])
      : null
  }
}

/** 模板属性表：决定每个属性控件的类型（INTEGER / BOOLEAN / EMBEDDED / STRING）。 */
const PROPERTY_DEFS = {
  age: { type: 'INTEGER' },
  active: { type: 'BOOLEAN' },
  tags: { type: 'EMBEDDED' },
  note: { type: 'STRING' },
  addr: { type: 'STRING' },
  zip: { type: 'STRING' }
}

/** 6 个属性（>5 触发搜索框）+ name/description 两个独立编辑字段。 */
const ENTITY = {
  entity_id: 'e-hz-1',
  entity_name: '杭州',
  entity_type: 'City',
  properties: {
    name: '杭州',
    description: '浙江省会',
    age: 3,
    active: true,
    tags: ['西湖', '龙井'],
    note: '备注文本',
    addr: '天目山路',
    zip: '310000'
  }
}

const RELATIONS = [
  { id: 'r-1', direction: '出 →', label: 'KNOWS', peer: { entity_id: 'e-sh-1', name: '上海' } }
]

async function mountDrawer (props = {}) {
  return mountWithPlugins(GraphEntityDrawer, {
    router: null,
    props: {
      modelValue: true,
      entity: ENTITY,
      entityType: { name: 'City', tone: 'purple' },
      propertyDefs: PROPERTY_DEFS,
      relations: RELATIONS,
      saving: false,
      ...props
    },
    global: {
      components: { ElDrawer: DrawerShell, ElForm, ElFormItem, ElInput, ElSwitch, ElButton },
      stubs: { transition: false, 'transition-group': false }
    }
  })
}

function footerButtons (wrapper) {
  return wrapper.find('.drawer-shell-footer').findAll('button.el-button')
}

beforeEach(() => {
  copyMock.copyTextWithToast.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // jsdom 没实现 scrollIntoView（保存失败分支会调）
  Element.prototype.scrollIntoView = vi.fn()
})

describe('开态渲染', () => {
  it('头部：标题 / 实体名 / 类型标签；基础信息里 id 与类型只读', async () => {
    const wrapper = await mountDrawer()
    const header = wrapper.find('.drawer-shell-header')
    expect(header.text()).toContain('编辑实体')
    expect(header.text()).toContain('杭州')
    expect(header.text()).toContain('City')
    expect(wrapper.find('.ge-readonly code').text()).toBe('e-hz-1')
    expect(wrapper.text()).toContain('来源')
  })

  it('名称/描述两个输入框按 hasName/hasDescription 启用', async () => {
    const wrapper = await mountDrawer()
    const inputs = wrapper.findAll('.ge-basics .el-input__inner, .ge-basics .el-textarea__inner')
    expect(inputs[0].element.value).toBe('杭州')
    expect(inputs[0].element.disabled).toBe(false)
    expect(inputs[1].element.value).toBe('浙江省会')
  })

  it('属性控件按模板类型渲染：布尔→开关、JSON→多行、其它→输入框', async () => {
    const wrapper = await mountDrawer()
    expect(wrapper.findAll('.ge-property')).toHaveLength(6)
    expect(wrapper.findAll('.el-switch')).toHaveLength(1)
    expect(wrapper.findAll('.ge-property .el-textarea__inner')).toHaveLength(1)
    expect(wrapper.text()).toContain('tags')
    expect(wrapper.findAll('.ge-property .el-textarea__inner')[0].element.value).toContain('西湖')
  })

  it('实体为空 / 抽屉关闭时不渲染表单主体', async () => {
    const closed = await mountDrawer({ modelValue: false })
    expect(closed.find('.ge-form').exists()).toBe(false)

    const noEntity = await mountDrawer({ entity: null })
    expect(noEntity.find('.ge-form').exists()).toBe(false)
  })

  it('无属性实体：空态文案「此实体暂无属性信息」', async () => {
    const wrapper = await mountDrawer({ entity: { entity_id: 'e-x', entity_name: '空' } })
    expect(wrapper.text()).toContain('此实体暂无属性信息')
  })
})

describe('属性交互', () => {
  it('改名称 → dirty 置位：定位/加关系按钮禁用，保存可点', async () => {
    const wrapper = await mountDrawer()
    const nameInput = wrapper.find('.ge-basics .el-input__inner')
    await nameInput.setValue('杭州·改')

    const footer = footerButtons(wrapper)
    expect(footer[0].element.disabled).toBe(true) // 定位
    expect(footer[2].element.disabled).toBe(false) // 保存可点
    expect(wrapper.find('.ge-add-relation').element.disabled).toBe(true)
  })

  it('布尔属性点击开关写回草稿；文本属性输入写回', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('.el-switch').trigger('click')
    // active 原值 true → 点击后 false；再次点击回到 true（对应 aria 两种状态）
    const inputs = wrapper.findAll('.ge-property .el-input__inner')
    await inputs.find(i => i.element.value === '备注文本').setValue('新备注')

    // 直接点保存：成功路径
    await footerButtons(wrapper)[2].trigger('click')
    await flush()
    const payload = wrapper.emitted('save')[0][0]
    expect(payload.properties.active).toBe(false)
    expect(payload.properties.note).toBe('新备注')
    expect(payload.name).toBe('杭州')
  })

  it('JSON 格式化：非法 JSON 报错并出错误汇总；合法 JSON 折叠美化', async () => {
    const wrapper = await mountDrawer()
    const jsonInput = wrapper.findAll('.ge-property .el-textarea__inner')
      .find(i => i.element.value.includes('西湖'))

    await jsonInput.setValue('not-json')
    await wrapper.findAll('.ge-text-action')[0].trigger('click')
    expect(wrapper.text()).toContain('JSON 格式不正确')
    expect(wrapper.text()).toContain('1 个属性需要修正')

    await jsonInput.setValue('{"a":1}')
    await wrapper.findAll('.ge-text-action')[0].trigger('click')
    expect(wrapper.findAll('.ge-text-action')[0].text()).toBeTruthy()
    expect(wrapper.find('.ge-error-summary').exists()).toBe(false)
  })

  it('复制实体 id 与复制属性值都走 copyTextWithToast', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('.ge-identity .icon-button.copy').trigger('click')
    await wrapper.find('.ge-json-actions .icon-button.copy').trigger('click')
    expect(copyMock.copyTextWithToast).toHaveBeenCalledTimes(2)
    expect(copyMock.copyTextWithToast).toHaveBeenCalledWith('e-hz-1')
  })

  it('属性搜索（>5 条才出现）：命中过滤、无命中给空态', async () => {
    const wrapper = await mountDrawer()
    const search = wrapper.find('.ge-property-search .el-input__inner')
    await search.setValue('zip')
    expect(wrapper.findAll('.ge-property')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('没有匹配的属性')

    await search.setValue('不存在')
    expect(wrapper.text()).toContain('没有匹配的属性')
  })
})

describe('保存校验', () => {
  it('名称为空：nameError 落在名称输入框（请输入实体名称）且不 emit', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('.ge-basics .el-input__inner').setValue('')
    await footerButtons(wrapper)[2].trigger('click')
    await flush()

    expect(wrapper.emitted('save')).toBeUndefined()
    // 名称错误挂在 el-form-item 的 error prop 上（EP 只有 validateState=error 才渲染行内文案）
    const nameItem = wrapper.findAllComponents(ElFormItem)[0]
    expect(nameItem.props('error')).toBe('请输入实体名称')
    expect(wrapper.find('.ge-error-summary').exists()).toBe(false)
  })

  it('数字属性非法（INTEGER 填 3.5 → integer）：属性节展开并聚焦第一个错误项', async () => {
    const wrapper = await mountDrawer()
    const ageInput = wrapper.findAll('.ge-property .el-input__inner').find(i => i.element.value === '3')
    await ageInput.setValue('3.5')
    await footerButtons(wrapper)[2].trigger('click')
    await flush()

    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.text()).toContain('请输入整数')
    expect(wrapper.find('.ge-error-summary').exists()).toBe(true)
  })

  it('number / jsonType 错误码各自翻译（number 填 abc；JSON 填 123）', async () => {
    const wrapper = await mountDrawer()
    const inputs = wrapper.findAll('.ge-property .el-input__inner')
    await inputs.find(i => i.element.value === '3').setValue('abc')
    const jsonTextarea = wrapper.findAll('.ge-property .el-textarea__inner')
      .find(i => i.element.value.includes('西湖'))
    await jsonTextarea.setValue('123')
    await footerButtons(wrapper)[2].trigger('click')
    await flush()

    const messages = wrapper.findAll('.ge-field-message').map(n => n.text())
    expect(messages).toContain('请输入有效数字')
    expect(messages).toContain('请输入 JSON 对象、数组或 null')
  })

  it('保存成功：emit save 且载荷带解析后的类型值', async () => {
    const wrapper = await mountDrawer()
    await footerButtons(wrapper)[2].trigger('click')
    await flush()

    const payload = wrapper.emitted('save')[0][0]
    expect(payload).toEqual({
      name: '杭州',
      description: '浙江省会',
      properties: {
        age: 3,
        active: true,
        tags: ['西湖', '龙井'],
        note: '备注文本',
        addr: '天目山路',
        zip: '310000',
        name: '杭州',
        description: '浙江省会'
      }
    })
  })
})

describe('关系与 footer 行为', () => {
  it('点击关系行 emit select(peer)；加关系按钮 emit add-relation；定位按钮 emit locate', async () => {
    const wrapper = await mountDrawer()

    await wrapper.find('.ge-relation').trigger('click')
    expect(wrapper.emitted('select')[0][0]).toEqual({ entity_id: 'e-sh-1', name: '上海' })

    await wrapper.find('.ge-add-relation').trigger('click')
    expect(wrapper.emitted('add-relation')).toHaveLength(1)

    await footerButtons(wrapper)[0].trigger('click')
    expect(wrapper.emitted('locate')).toHaveLength(1)
  })

  it('取消按钮 emit update:modelValue=false；saving 时取消禁用、保存 loading', async () => {
    const savingWrapper = await mountDrawer({ saving: true })
    expect(footerButtons(savingWrapper)[1].element.disabled).toBe(true)
    expect(footerButtons(savingWrapper)[2].classes()).toContain('is-loading')
    // saving 时 save() 与取消都直接返回
    await footerButtons(savingWrapper)[2].trigger('click')
    expect(savingWrapper.emitted('save')).toBeUndefined()
    expect(savingWrapper.emitted('update:modelValue')).toBeUndefined()

    const wrapper = await mountDrawer({ saving: false })
    await footerButtons(wrapper)[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')[0][0]).toBe(false)
  })

  it('打开状态与实体变化都会重建草稿（切实体回到原始值）', async () => {
    const wrapper = await mountDrawer()
    await wrapper.find('.ge-basics .el-input__inner').setValue('改名')
    await wrapper.setProps({ entity: { ...ENTITY, entity_id: 'e-bj-1', entity_name: '北京', properties: { name: '北京' } } })
    await flush()
    expect(wrapper.find('.ge-basics .el-input__inner').element.value).toBe('北京')
    expect(wrapper.text()).toContain('此实体暂无属性信息')
  })
})
