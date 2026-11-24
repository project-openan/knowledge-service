// 知识库目录 / 文档 api（features/knowledge-base/api/directory.js）的契约单测。
// mock 掉 shared/api/client，钉住方法 / 路径 / 参数组装。
// ⚠️ vi.mock 工厂会被提升：桩对象必须在工厂内联创建，再 import 回来断言。
import { vi, beforeEach } from 'vitest'

vi.mock('@/shared/api/client', () => ({
  default: Object.assign(
    vi.fn(),
    { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
  )
}))

import client from '@/shared/api/client'
const axios = client

import {
  getDescendantsDirectoryList,
  createDirectory,
  updateDirectory,
  deleteDirectory,
  moveDocuments,
  deleteFile,
  downloadFileOut,
  getAllFilesPageApi
} from '@/features/knowledge-base/api/directory'

beforeEach(() => {
  axios.get.mockReset().mockResolvedValue([])
  axios.post.mockReset().mockResolvedValue({})
  axios.patch.mockReset().mockResolvedValue({})
  axios.delete.mockReset().mockResolvedValue({})
  axios.mockReset().mockResolvedValue({})
})

describe('getDescendantsDirectoryList', () => {
  it('GET /knowledge-bases/{kb}/directories，固定 type=folder&sort=true，其余参数透传', async () => {
    await getDescendantsDirectoryList({ kbaseId: 'kb-1', category: 2 })
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/directories')).toBe(true)
    expect(config.params).toEqual({ type: 'folder', sort: true, category: 2 })
  })

  it('params 缺省时只带固定参数；config 可透传', async () => {
    await getDescendantsDirectoryList(undefined, { skipErrorHandler: true })
    expect(axios.get.mock.calls[0][1].params).toEqual({ type: 'folder', sort: true })
    expect(axios.get.mock.calls[0][1].skipErrorHandler).toBe(true)
  })
})

describe('createDirectory', () => {
  it('POST 带 parentId 与数据体合并', async () => {
    await createDirectory({ kbaseId: 'kb-1', parentId: 'dir-9' }, { title: 'New' })
    const [url, body] = axios.post.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/directories')).toBe(true)
    expect(body).toEqual({ parentId: 'dir-9', title: 'New' })
  })

  it('无数据体时只带 parentId', async () => {
    await createDirectory({ kbaseId: 'kb-2', parentId: 'root' })
    expect(axios.post.mock.calls[0][1]).toEqual({ parentId: 'root' })
  })
})

describe('目录与文档的增删改', () => {
  it('updateDirectory PATCH /directories/{id}', async () => {
    await updateDirectory('kb-1', 'dir-3', { title: 'renamed' })
    const [url, body] = axios.patch.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/directories/dir-3')).toBe(true)
    expect(body).toEqual({ title: 'renamed' })
  })

  it('deleteDirectory DELETE /directories/{id}', async () => {
    await deleteDirectory('kb-1', 'dir-3')
    expect(axios.delete.mock.calls[0][0].endsWith('/knowledge-bases/kb-1/directories/dir-3')).toBe(true)
  })

  it('moveDocuments PATCH /documents 带 ids+parentId', async () => {
    await moveDocuments('kb-1', ['f1', 'f2'], 'dir-5')
    const [url, body] = axios.patch.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb-1/documents')).toBe(true)
    expect(body).toEqual({ ids: ['f1', 'f2'], parentId: 'dir-5' })
  })

  it('deleteFile DELETE /documents/{id}', async () => {
    await deleteFile('kb-1', 'f7')
    expect(axios.delete.mock.calls[0][0].endsWith('/knowledge-bases/kb-1/documents/f7')).toBe(true)
  })
})

describe('downloadFileOut', () => {
  it('走 axios 函数调用：GET blob 响应', async () => {
    await downloadFileOut({ kbaseId: 'kb-1', fileId: 'f-1' })
    const config = axios.mock.calls[0][0]
    expect(config.url.endsWith('/knowledge-bases/kb-1/documents/f-1/content')).toBe(true)
    expect(config.method).toBe('get')
    expect(config.responseType).toBe('blob')
  })

  it('params 缺省也安全拼 URL', async () => {
    await downloadFileOut(undefined)
    expect(axios.mock.calls[0][0].url.endsWith('/knowledge-bases/undefined/documents/undefined/content')).toBe(true)
  })
})

describe('getAllFilesPageApi', () => {
  it('默认 page=1 size=50 空关键字；kbId 走 encodeURIComponent', async () => {
    await getAllFilesPageApi('kb/1')
    const [url, config] = axios.get.mock.calls[0]
    expect(url.endsWith('/knowledge-bases/kb%2F1/documents')).toBe(true)
    expect(config.params).toEqual({ page: 1, size: 50, keyword: '' })
  })

  it('分页参数可覆盖，config 透传', async () => {
    await getAllFilesPageApi('kb-1', { currentPage: 3, pageSize: 99, keyword: '合同' }, { signal: 'sig' })
    const [, config] = axios.get.mock.calls[0]
    expect(config.params).toEqual({ page: 3, size: 99, keyword: '合同' })
    expect(config.signal).toBe('sig')
  })
})
