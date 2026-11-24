// @vitest-environment jsdom
//
// 补 `src/shared/api/client.js` 既有 api.base.spec.js / api.unauthorized.spec.js
// 没覆盖的分支。两条既有线已经钉住「成功路径」「problem+json 错误路径」；
// 这里补的是剩余分支：
//   - validateStatus 放行 / 200 + problem content-type 这两条**fulfilled 分支**；
//   - blob 失败时 problem+json 要先从 Blob 里读出来（解析失败回落 http_error）；
//   - 401 与未注册会话处理器的兜底排列；
//   - /app/import 的失败前缀、413/414 的专用文案、未知状态码的回落文案；
//   - 请求拦截器的 rejection 分支；ApiError 的 title/cause 兜底形状。
// message 照 api.base.spec.js 的写法换成 spy（被测的是拦截器分支，不是 toast 组件）。
// 文案语言先钉 zh，断言的是真实词条而非 mock。
vi.hoisted(() => {
  window.localStorage.setItem('language-option', JSON.stringify('zh-CN'))
})

const toast = vi.hoisted(() => ({ error: vi.fn(options => ({ close: () => {} })) }))
vi.mock('@/shared/lib/message', () => ({
  default: Object.assign(options => toast.error(options), { error: toast.error })
}))

import axiosInstance, { ApiError } from '@/shared/api/client'
import { setUnauthorizedHandler, notifyUnauthorized, hasUnauthorizedHandler } from '@/shared/api/unauthorized'

/** 恒定 resolve 的 adapter（validateStatus 放行的端点会把 4xx 送进 fulfilled 分支）。 */
function resolvingAdapter ({ status, data, headers = {} }) {
  return async config => ({ status, statusText: String(status), headers, data, config })
}

/** 恒定 throw 的 adapter（axios 原生行为：4xx/5xx 由 adapter 拒绝）。 */
function failingAdapter (status, data, headers = {}) {
  return async config => {
    const error = new Error(`Request failed with status code ${status}`)
    error.response = { status, statusText: String(status), headers, data, config }
    error.config = config
    error.isAxiosError = true
    throw error
  }
}

function problem (status, code, extra = {}) {
  return { type: `urn:openan:problem:${code}`, title: code, status, code, ...extra }
}

async function call (adapter, config = {}) {
  return axiosInstance.request({
    url: '/api/knowledge-service/v1/test',
    method: 'get',
    adapter,
    ...config
  })
}

beforeEach(() => {
  toast.error.mockClear()
})

afterEach(() => {
  setUnauthorizedHandler(null)
})

describe('fulfilled 分支里的失败响应', () => {
  it('validateStatus 放行的 4xx：同样翻译成 ApiError 并弹 toast', async () => {
    const promise = call(resolvingAdapter({
      status: 422,
      data: problem(422, 'validation_failed', { detail: '参数不合法' }),
      headers: { 'content-type': 'application/problem+json' }
    }), { validateStatus: () => true })

    await expect(promise).rejects.toMatchObject({ name: 'ApiError', status: 422, code: 'validation_failed' })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('HTTP 200 但 content-type 是 problem+json：按失败处理', async () => {
    const promise = call(resolvingAdapter({
      status: 200,
      data: problem(200, 'logical_error', { detail: '业务校验失败' }),
      headers: { 'content-type': 'application/problem+json' }
    }), { validateStatus: () => true })

    await expect(promise).rejects.toMatchObject({ status: 200, code: 'logical_error' })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('HTTP 200 + problem content-type + skipErrorMessage：只拒收，不弹 toast', async () => {
    const promise = call(resolvingAdapter({
      status: 200,
      data: problem(200, 'silent_error', { detail: '页面自己提示' }),
      headers: { 'content-type': 'application/problem+json' }
    }), { validateStatus: () => true, skipErrorMessage: true })

    await expect(promise).rejects.toMatchObject({ code: 'silent_error' })
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('blob 失败响应的 problem 解析', () => {
  it('blob 里的 problem+json 能被读出 code 与 detail', async () => {
    const blob = new Blob([JSON.stringify(problem(404, 'kb_not_found', { detail: '知识库不存在' }))],
      { type: 'application/problem+json' })

    await expect(call(failingAdapter(404, blob), { responseType: 'blob' }))
      .rejects.toMatchObject({ code: 'kb_not_found', detail: '知识库不存在' })
  })

  it('blob 内容不是 JSON：回落 http_error 与状态码文案', async () => {
    const blob = new Blob(['<html>gateway error</html>'], { type: 'text/html' })

    await expect(call(failingAdapter(502, blob), { responseType: 'blob' }))
      .rejects.toMatchObject({ code: 'http_error', status: 502, detail: '网关错误，服务器暂时不可用' })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})

describe('错误文案（httpFallbackMessage / notifyError 的分支）', () => {
  it('词条里有对应状态码时用专用文案（404）', async () => {
    await expect(call(failingAdapter(404, null))).rejects.toMatchObject({
      detail: '请求的资源不存在'
    })
    expect(toast.error.mock.calls[0][0].message).toBe('请求的资源不存在')
  })

  it('词条里没有的状态码（418）回落「请求失败，状态码: N」', async () => {
    await expect(call(failingAdapter(418, null))).rejects.toMatchObject({
      detail: '请求失败，状态码: 418'
    })
  })

  it('无响应的网络错误回落「网络异常」文案', async () => {
    await expect(call(async () => { throw new Error('Network Error') }))
      .rejects.toMatchObject({ code: 'network_error', detail: '网络异常，请稍后重试' })
    expect(toast.error.mock.calls[0][0].message).toBe('网络异常，请稍后重试')
  })

  it('413 / 414 统一换成长度超限的用户文案（只换 toast；ApiError 保留原始回落文案）', async () => {
    await expect(call(failingAdapter(413, null))).rejects.toMatchObject({
      detail: '请求内容过大'
    })
    await expect(call(failingAdapter(414, null))).rejects.toMatchObject({
      detail: '请求失败，状态码: 414'
    })
    // 用户看到的提示两条都是专用文案，而不是「状态码: 413/414」
    const messages = toast.error.mock.calls.map(([options]) => options.message)
    expect(messages.filter(text => text === '输入内容过长，请缩短后重试')).toHaveLength(2)
  })

  it('/app/import 的失败 toast 带「导入失败」前缀', async () => {
    await expect(axiosInstance.request({
      url: '/api/knowledge-service/v1/app/import/preview',
      method: 'post',
      adapter: failingAdapter(422, null)
    })).rejects.toBeInstanceOf(ApiError)

    const messages = toast.error.mock.calls.map(([options]) => options.message)
    expect(messages.some(text => text.startsWith('导入失败: '))).toBe(true)
  })
})

describe('401 与会话处理器的组合', () => {
  it('401 且未注册会话处理器：回落通用 toast（极早期请求的兜底）', async () => {
    const promise = call(failingAdapter(401, problem(401, 'unauthorized'),
      { 'content-type': 'application/problem+json' }))

    await expect(promise).rejects.toMatchObject({ status: 401 })
    expect(hasUnauthorizedHandler()).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('401 + blob 响应同样交给会话层处理器', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    const blob = new Blob([JSON.stringify(problem(401, 'unauthorized'))], { type: 'application/problem+json' })

    await expect(call(failingAdapter(401, blob), { responseType: 'blob' }))
      .rejects.toMatchObject({ status: 401 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].code).toBe('unauthorized')
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('请求拦截器的失败分支', () => {
  // axios 请求拦截器按注册逆序执行：后注册的先跑。这里让它抛错，
  // 断言本模块的 rejection 处理器只是**原样透传**（Promise.reject），
  // 错误随后被响应侧归一成 network_error，但原始错误保留在 cause 里。
  it('前序请求拦截器抛错：本模块透传，最终归一为 network_error 且 cause 保留原始错误', async () => {
    const boom = new Error('request interceptor failed')
    const id = axiosInstance.interceptors.request.use(() => { throw boom })

    try {
      const error = await call(resolvingAdapter({ status: 200, data: {} })).catch(e => e)

      expect(error).toBeInstanceOf(ApiError)
      expect(error.code).toBe('network_error')
      expect(error.cause).toBe(boom)
    } finally {
      axiosInstance.interceptors.request.eject(id)
    }
  })
})

describe('ApiError 的兜底形状', () => {
  it('problem 没有 detail 也没有 title 时，message 回落 HTTP 状态码', async () => {
    const rejection = call(failingAdapter(418, { status: 418, code: 'teapot' },
      { 'content-type': 'application/problem+json' }))
    const error = await rejection.catch(e => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toBe('HTTP 418')
    expect(error.title).toBe('')
    expect(error.type).toBe('')
    expect(error.problem).toEqual({ status: 418, code: 'teapot' })
  })

  it('cause 保留原始 axios 错误，便于链路排查', async () => {
    const error = await call(failingAdapter(500, null)).catch(e => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toContain('500')
  })

  it('problem 的 title 在 detail 缺省时充当 message', async () => {
    const error = await call(failingAdapter(409, { status: 409, code: 'conflict', title: '资源冲突' },
      { 'content-type': 'application/problem+json' })).catch(e => e)

    expect(error.message).toBe('资源冲突')
  })

  it('data 为 undefined 的成功响应返回 null（204 之外的空体也归 null）', async () => {
    await expect(call(resolvingAdapter({ status: 200, data: undefined }))).resolves.toBeNull()
  })
})

describe('unauthorized.js（注册点本体）', () => {
  it('setUnauthorizedHandler 换入非函数时视作未注册', () => {
    setUnauthorizedHandler('not-a-function')
    expect(hasUnauthorizedHandler()).toBe(false)
    expect(() => notifyUnauthorized(new ApiError({ status: 401 }))).not.toThrow()
  })

  it('注册的处理器收到原始错误对象', () => {
    const seen = []
    setUnauthorizedHandler(error => seen.push(error))
    const error = new ApiError({ status: 401, code: 'unauthorized' })

    notifyUnauthorized(error)

    expect(seen).toEqual([error])
    setUnauthorizedHandler(null)
    expect(hasUnauthorizedHandler()).toBe(false)
  })
})
