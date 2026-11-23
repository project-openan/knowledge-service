// 测的是 `src/shared/lib/requestCancel.js` 的 `isRequestCanceled`。
//
// 表格每次取数都会 abort 掉上一次未完成的请求，这种「被替换」不能被当成失败
// （否则旧请求的 catch 会把新数据清空、往控制台刷错误）。这里钉住三类取消
// 与「非取消」的判定边界 —— 判据要与 api 拦截器的 `ERR_CANCELED` 一致。
import { isRequestCanceled } from '@/shared/lib/requestCancel'

describe('isRequestCanceled', () => {
  it('axios 取消（error.code = ERR_CANCELED）→ 是取消', () => {
    expect(isRequestCanceled({ code: 'ERR_CANCELED' })).toBe(true)
  })

  it('axios v1 的 CanceledError（按 name 判）→ 是取消', () => {
    expect(isRequestCanceled({ name: 'CanceledError', code: 'ERR_CANCELED' })).toBe(true)
  })

  it('原生 AbortController 的 AbortError → 是取消', () => {
    expect(isRequestCanceled({ name: 'AbortError' })).toBe(true)
  })

  it('真实失败不是取消', () => {
    expect(isRequestCanceled({ code: 'ECONNABORTED', name: 'Error' })).toBe(false)
    expect(isRequestCanceled({ name: 'TypeError' })).toBe(false)
  })

  it('没有 code 也没有 name 的错误对象不是取消', () => {
    expect(isRequestCanceled({})).toBe(false)
    expect(isRequestCanceled({ message: 'boom' })).toBe(false)
  })

  it('falsy 入参（undefined / null / false）直接判否，不抛错', () => {
    // 表格的 catch 里 error 可能就是 undefined（老代码 `catch (e)` 忘了带参等）
    expect(isRequestCanceled(undefined)).toBe(false)
    expect(isRequestCanceled(null)).toBe(false)
    expect(isRequestCanceled(false)).toBe(false)
  })
})
