// @vitest-environment jsdom
// reportError 的契约：console 留痕 + 用户可见 toast，一次到位；
// 文案必须来自 i18n key（zh/en 同键，结构对比测试另行守卫）。
import { vi } from 'vitest'

const { messageError, t, consoleError } = vi.hoisted(() => ({
  messageError: vi.fn(),
  t: vi.fn(key => `[${key}]`),
  consoleError: vi.fn()
}))

vi.mock('@/shared/lib/message', () => ({ default: { error: messageError } }))
vi.mock('@/app/i18n/i18n.js', () => ({ $t: t }))

import { reportError } from '@/shared/lib/reportError'

describe('reportError', () => {
  beforeEach(() => {
    messageError.mockReset()
    t.mockClear()
    consoleError.mockReset()
    vi.spyOn(console, 'error').mockImplementation(consoleError)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('带 message 的错误：console 留痕 + toast 拼接具体原因', () => {
    reportError(new Error('boom'), 'modules.kb.exportJsonFailed')

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0][0]).toBe('modules.kb.exportJsonFailed')
    expect(t).toHaveBeenCalledWith('modules.kb.exportJsonFailed')
    expect(messageError).toHaveBeenCalledTimes(1)
    expect(messageError).toHaveBeenCalledWith('[modules.kb.exportJsonFailed]: boom')
  })

  it('无 message 的错误：只弹 i18n 文案，不拼冒号', () => {
    reportError({ status: 500 }, 'public.loadFailed')

    expect(messageError).toHaveBeenCalledWith('[public.loadFailed]')
  })

  it('不传 context：回落 public.operationFailed', () => {
    reportError(new Error('x'))

    expect(t).toHaveBeenCalledWith('public.operationFailed')
    expect(messageError).toHaveBeenCalledWith('[public.operationFailed]: x')
  })

  it('context 为对象时：key 走 i18n，label 只进控制台', () => {
    reportError(new Error('y'), { key: 'public.loadFailed', label: 'GraphCanvas init' })

    expect(consoleError.mock.calls[0][0]).toBe('GraphCanvas init')
    expect(messageError).toHaveBeenCalledWith('[public.loadFailed]: y')
  })

  it('ApiError 形状（有 detail 无 message）：detail 作为原因拼接', () => {
    reportError({ detail: '网络异常' }, 'modules.kb.loadTemplateFailed')

    expect(messageError).toHaveBeenCalledWith('[modules.kb.loadTemplateFailed]: 网络异常')
  })
})
