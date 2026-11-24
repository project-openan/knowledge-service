// @vitest-environment jsdom
// 图谱「模板包下载 / 导出落盘」传输函数（lib/graphTransfer.js）。
// jsdom 没有 createObjectURL / fetch，这里打桩后断言触发下载的完整链路。
import { vi } from 'vitest'
import {
  localizedTemplateFileName,
  templateZipUrl,
  fetchTemplateZip,
  saveBlobAsFile,
  downloadStaticTemplateZip
} from '@/features/graph/lib/graphTransfer'

describe('localizedTemplateFileName', () => {
  const names = { zh: 'graph-zh.zip', en: 'graph-en.zip' }

  it('zh 取中文包，其余语言（含缺省）回落英文包', () => {
    expect(localizedTemplateFileName('zh', names)).toBe('graph-zh.zip')
    expect(localizedTemplateFileName('en', names)).toBe('graph-en.zip')
    expect(localizedTemplateFileName('fr', names)).toBe('graph-en.zip')
    expect(localizedTemplateFileName(undefined, names)).toBe('graph-en.zip')
  })
})

describe('templateZipUrl', () => {
  // 注意：Vite 会把「模板字符串 + import.meta.url」改写成资源 glob 查表（只认真实存在的包名），
  // 所以这里用仓库里真实打包的模板包文件名断言，不造不存在的文件名。
  it('指向 src/assets/template 下的语言包', () => {
    const url = templateZipUrl('import_graph_template_ZH.zip')
    expect(url).toBeInstanceOf(URL)
    expect(url.pathname.endsWith('import_graph_template_ZH.zip')).toBe(true)
  })
})

describe('fetchTemplateZip', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('2xx 返回 Blob', async () => {
    const blob = new Blob(['zip'])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob })))
    await expect(fetchTemplateZip('http://x/t.zip')).resolves.toBe(blob)
  })

  it('非 2xx 抛错（文案由调用方统一弹）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(fetchTemplateZip('http://x/t.zip')).rejects.toThrow('Failed to fetch template file')
  })
})

describe('saveBlobAsFile', () => {
  it('建隐藏 <a> 触发下载并释放对象 URL', () => {
    const createObjectURL = vi.fn(() => 'blob:mock-id')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const blob = new Blob(['x'])
    saveBlobAsFile(blob, 'export.zip')

    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const link = clickSpy.mock.instances[0]
    expect(link.download).toBe('export.zip')
    expect(link.href).toContain('blob:mock-id')
    // 点击后已从 DOM 摘除
    expect(link.parentNode).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-id')

    clickSpy.mockRestore()
  })
})

describe('downloadStaticTemplateZip', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetch → Blob → 触发浏览器下载，一条链', async () => {
    const blob = new Blob(['zip-bytes'])
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:dl')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const fileName = 'import_graph_template_EN.zip'
    await downloadStaticTemplateZip(fileName)

    expect(String(fetchMock.mock.calls[0][0]).endsWith(fileName)).toBe(true)
    expect(clickSpy.mock.instances[0].download).toBe(fileName)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:dl')

    clickSpy.mockRestore()
  })
})
