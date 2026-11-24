// @vitest-environment jsdom
//
// 测的是 `src/shared/lib/utils.ts` 的其余导出（docCountLabel 已有专测）：
//   - highlightText：搜索命中分段（表格里高亮的关键实现，正则元字符要转义）；
//   - formatterSortOrder：表格排序方向 → 后端 orderList[].ascending；
//   - download：浏览器端把二进制响应存成文件（Blob → object URL → <a download>）。
// i18n / DOM 都在导入期被触达，所以按约定 opt-in jsdom。
// `language-option` 先钉住 zh，避免文案随宿主浏览器语言漂移。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

import { docCountLabel, download, formatterSortOrder, highlightText } from '@/shared/lib/utils'

describe('highlightText（搜索命中分段）', () => {
  it('没有搜索词时返回 undefined（调用方直接渲染原文）', () => {
    expect(highlightText('任意文本', '')).toBeUndefined()
    expect(highlightText('任意文本', undefined)).toBeUndefined()
  })

  it('命中与未命中交替出现，matched 标记正确', () => {
    expect(highlightText('知识库检索与知识图谱', '知识')).toEqual([
      { text: '知识', matched: true },
      { text: '库检索与', matched: false },
      { text: '知识', matched: true },
      { text: '图谱', matched: false }
    ])
  })

  it('全文命中 / 全文未命中两个边界', () => {
    expect(highlightText('abc', 'abc')).toEqual([{ text: 'abc', matched: true }])
    expect(highlightText('abc', 'zzz')).toEqual([{ text: 'abc', matched: false }])
  })

  it('大小写不敏感（gi 标志）', () => {
    expect(highlightText('Error and ERROR', 'error')).toEqual([
      { text: 'Error', matched: true },
      { text: ' and ', matched: false },
      { text: 'ERROR', matched: true }
    ])
  })

  it('搜索词里的正则元字符按字面量匹配，不当语法解释', () => {
    // `a(b` 若未转义会抛 SyntaxError / 乱匹配
    expect(highlightText('a(b) and axb', 'a(b')).toEqual([
      { text: 'a(b', matched: true },
      { text: ') and axb', matched: false }
    ])
    expect(highlightText('3 * 4 = 12', '*')).toEqual([
      { text: '3 ', matched: false },
      { text: '*', matched: true },
      { text: ' 4 = 12', matched: false }
    ])
  })

  it('空原文返回空分段数组', () => {
    expect(highlightText('', 'x')).toEqual([])
  })
})

describe('formatterSortOrder（排序方向映射）', () => {
  it('ascending → asc，descending → desc（el-table 的默认方向值）', () => {
    expect(formatterSortOrder('ascending')).toBe('asc')
    expect(formatterSortOrder('descending')).toBe('desc')
  })

  it('未知方向回落到 ascending 的取值（不抛错、不发非法排序）', () => {
    expect(formatterSortOrder(undefined)).toBe('asc')
    expect(formatterSortOrder(null)).toBe('asc')
    expect(formatterSortOrder('whatever')).toBe('asc')
  })

  it('调用方可覆盖两侧取值', () => {
    expect(formatterSortOrder('ascending', 'ASC', 'DESC')).toBe('ASC')
    expect(formatterSortOrder('descending', 'ASC', 'DESC')).toBe('DESC')
    expect(formatterSortOrder('descending', true, false)).toBe(false)
  })
})

describe('docCountLabel（非数值兜底）', () => {
  it('非数值输入按 0 处理，不产生 NaN 文案', () => {
    expect(docCountLabel('abc')).toBe('0 篇文档')
    expect(docCountLabel('')).toBe('0 篇文档')
    expect(docCountLabel('1')).toBe('1 篇文档') // 数字字符串正常计数
  })
})

describe('download（二进制响应存成文件）', () => {
  let clickSpy
  let createObjectURL
  let revokeObjectURL
  let createdAnchors

  beforeEach(() => {
    vi.useFakeTimers()
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    createObjectURL = vi.fn(() => 'blob:mock-url')
    revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    // download() 是「挂上 → 点击 → 立刻摘下」的同步序列，查 DOM 查不到；
    // 在 createElement 处把临时 <a> 截下来断言。
    createdAnchors = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
      const el = originalCreateElement(tag, ...rest)
      if (tag === 'a') {
        createdAnchors.push(el)
      }
      return el
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function lastAnchor () {
    expect(clickSpy).toHaveBeenCalledTimes(1)
    return createdAnchors[createdAnchors.length - 1]
  }

  it('Blob 输入：挂 <a download> 触发点击，1s 后回收 object URL', () => {
    const blob = new Blob(['zip-bytes'], { type: 'application/octet-stream' })

    download(blob, '报表.zip')

    const anchor = lastAnchor()
    expect(anchor.href).toBe('blob:mock-url')
    expect(anchor.download).toBe('报表.zip')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('非 Blob 输入包成 Blob；带 mime 时用该类型重包一层', () => {
    download('text-content', 'a.txt', 'text/csv')

    const anchor = lastAnchor()
    expect(anchor.download).toBe('a.txt')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('text/csv')
  })

  it('空文件名不设 download 属性（交给浏览器按 URL 推断）', () => {
    download(new Blob(['x']), '')

    const anchor = lastAnchor()
    expect(anchor.hasAttribute('download')).toBe(false)
  })

  it('点击后 anchor 从 body 移除（不往 DOM 里堆节点）', () => {
    download(new Blob(['x']), 'f.bin')

    lastAnchor()
    expect(document.body.querySelector('a')).toBeNull()
  })
})
