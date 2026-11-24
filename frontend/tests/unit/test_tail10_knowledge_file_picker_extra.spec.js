// @vitest-environment jsdom
/**
 * KnowledgeFilePicker.vue —— 补齐既有 KnowledgeFilePicker.spec.js 没碰到的分支：
 *
 * - addFiles 的每个拒绝原因：与 existingFiles 同名同大小（入口查重）、空文件、超限、
 *   个数超限（tooMany + batchRejected 聚合）、总量超限（totalTooLarge + batchRejected）；
 * - 错误横幅的关闭按钮；文件行的「移除」与「清空」按钮（含 defineExpose 的 clear）；
 * - 文件类型配色三档（pdf/pptx=orange、xlsx/csv/json=green、其它=blue）；
 * - 拖拽计数（dragenter/dragleave → is-dragging 类）与上限说明（自定义 activeFileLimits、
 *   maxTotalBytes 非整 MB 时 formatFileSize 兜底）。
 */
import { describe, expect, it } from 'vitest'

import { flush, mountWithPlugins } from './helpers/mount'

import KnowledgeFilePicker from '@/features/knowledge-base/components/KnowledgeFilePicker.vue'

function fileOf (name, content = 'x') {
  return new File([content], name, { type: 'text/plain' })
}

async function mountPicker (props = {}) {
  const wrapper = await mountWithPlugins(KnowledgeFilePicker, { props })
  await flush()
  return wrapper
}

/** 在原生 input 上选一批文件。 */
async function choose (wrapper, files) {
  const input = wrapper.find('.kb-upload-input')
  Object.defineProperty(input.element, 'files', { configurable: true, value: files })
  await input.trigger('change')
  await flush()
}

describe('KnowledgeFilePicker：addFiles 拒绝原因', () => {
  it('与 existingFiles 同名同大小的文件直接拒掉（入口查重，不用 fileKey）', async () => {
    const existing = [fileOf('a.txt', 'same')]
    const wrapper = await mountPicker({ existingFiles: existing })

    await choose(wrapper, [fileOf('a.txt', 'same'), fileOf('b.txt')])

    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(1)
    const banner = wrapper.find('.kb-upload-errors')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('a.txt')
    expect(banner.text()).not.toContain('b.txt')
  })

  it('空文件 / 超过该扩展组上限的文件逐个报错', async () => {
    // 自定义上限：txt 组 1 MB，放一个 1.2MB 的文件必超
    const wrapper = await mountPicker({
      activeFileLimits: [{ extensions: ['txt'], maxMB: 1 }]
    })

    await choose(wrapper, [fileOf('empty.txt', ''), fileOf('big.txt', 'x'.repeat(1.2 * 1024 ** 2))])

    const banner = wrapper.find('.kb-upload-errors')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('empty.txt')
    expect(banner.text()).toContain('big.txt')
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(0)
  })

  it('个数超限：整批聚合为一条 tooMany 文案', async () => {
    const wrapper = await mountPicker({ maxFiles: 1 })

    await choose(wrapper, [fileOf('a.txt'), fileOf('b.txt'), fileOf('c.txt')])

    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(1)
    const bannerText = wrapper.find('.kb-upload-errors').text()
    expect(bannerText).toContain('最多添加')
    expect(bannerText).toContain('2')
  })

  it('总量超限：整批聚合为一条 totalTooLarge 文案', async () => {
    const wrapper = await mountPicker({ maxTotalBytes: 3 * 1024 ** 2 })

    await choose(wrapper, [fileOf('a.txt', 'x'.repeat(2 * 1024 ** 2)), fileOf('b.txt', 'x'.repeat(2 * 1024 ** 2))])

    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(1)
    const bannerText = wrapper.find('.kb-upload-errors').text()
    expect(bannerText).toContain('总大小')
    expect(bannerText).toContain('3 MB')
  })

  it('错误横幅可关闭：点 × 清空 uploadErrors', async () => {
    const wrapper = await mountPicker()
    await choose(wrapper, [fileOf('virus.exe')])

    expect(wrapper.find('.kb-upload-errors').exists()).toBe(true)
    await wrapper.find('.kb-errors-heading .icon-button').trigger('click')
    await flush()
    expect(wrapper.find('.kb-upload-errors').exists()).toBe(false)
  })
})

describe('KnowledgeFilePicker：文件行操作', () => {
  it('每行的「移除」按钮只删那一行；「清空」按钮清掉全部（空列表后按钮消失、空态出现）', async () => {
    const wrapper = await mountPicker()
    await choose(wrapper, [fileOf('a.txt'), fileOf('b.pdf'), fileOf('c.json')])
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(3)

    // 移除 b.pdf（第二行的 icon-button）
    await wrapper.findAll('.kb-file-list li')[1].find('.icon-button').trigger('click')
    await flush()
    const names = wrapper.findAll('.kb-file-list li').map(li => li.text())
    expect(names).toHaveLength(2)
    expect(names.join()).toContain('a.txt')
    expect(names.join()).not.toContain('b.pdf')

    // 清空
    const clearButton = wrapper.findAll('button').find(b => b.text().includes('清空'))
    expect(clearButton).toBeTruthy()
    await clearButton.trigger('click')
    await flush()
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(0)
    expect(wrapper.find('.kb-files-empty').exists()).toBe(true)
    expect(wrapper.find('.kb-files-heading .el-button').exists()).toBe(false)
  })

  it('defineExpose 的 clear 也能清空', async () => {
    const wrapper = await mountPicker()
    await choose(wrapper, [fileOf('a.txt')])
    wrapper.vm.clear()
    await flush()
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(0)
  })

  it('文件类型配色三档', async () => {
    const wrapper = await mountPicker()
    await choose(wrapper, [
      fileOf('deck.pptx'), fileOf('sheet.xlsx'), fileOf('plain.txt')
    ])

    const tones = wrapper.findAll('.kb-file-icon').map(node => node.classes())
    expect(tones[0]).toContain('orange')
    expect(tones[1]).toContain('green')
    expect(tones[2]).toContain('blue')
  })
})

describe('KnowledgeFilePicker：拖拽态与上限说明', () => {
  it('dragenter/dragleave 增减 dragDepth（is-dragging 类），drop 归零', async () => {
    const wrapper = await mountPicker()
    const zone = wrapper.find('.kb-dropzone')
    expect(zone.classes()).not.toContain('is-dragging')

    await zone.trigger('dragenter')
    expect(zone.classes()).toContain('is-dragging')
    await zone.trigger('dragenter')
    await zone.trigger('dragleave')
    expect(zone.classes()).toContain('is-dragging')
    await zone.trigger('drop', { dataTransfer: { files: [fileOf('d.txt')] } })
    await flush()
    expect(zone.classes()).not.toContain('is-dragging')
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(1)
  })

  it('上限说明渲染自定义 activeFileLimits；maxTotalBytes 非整 MB 时用 formatFileSize 兜底', async () => {
    const wrapper = await mountPicker({
      activeFileLimits: [
        { extensions: ['txt', 'csv'], maxMB: 5 },
        { extensions: ['pdf'], maxMB: 150 }
      ],
      maxTotalBytes: 650 * 1024 ** 2 + 512 * 1024
    })

    const groups = wrapper.findAll('.kb-limits-popover > div')
    expect(groups).toHaveLength(2)
    expect(groups[0].text()).toContain('TXT / CSV')
    expect(groups[0].text()).toContain('5 MB')
    expect(groups[1].text()).toContain('PDF')

    const summary = wrapper.find('.kb-upload-meta > span')
    // 650.5 MB → formatFileSize 保留一位小数
    expect(summary.text()).toContain('650.5 MB')
  })

  it('自定义标题替换默认文件列表标题', async () => {
    const wrapper = await mountPicker({ title: '新增文件' })
    expect(wrapper.find('.kb-files-heading').text()).toContain('新增文件')
  })

  it('activeFileLimits 传 null / 空数组时回落内置档位', async () => {
    for (const activeFileLimits of [null, []]) {
      const wrapper = await mountPicker({ activeFileLimits })
      expect(wrapper.find('.kb-upload-input').attributes('accept')).toContain('.pdf')
      wrapper.unmount()
    }
  })

  it('drop 事件没有 files 时静默不报错', async () => {
    const wrapper = await mountPicker()
    await wrapper.find('.kb-dropzone').trigger('drop', { dataTransfer: {} })
    await flush()
    expect(wrapper.findAll('.kb-file-list li')).toHaveLength(0)
    expect(wrapper.find('.kb-upload-errors').exists()).toBe(false)
  })
})
