// @vitest-environment jsdom
//
// 测的是 `src/shared/lib/cookies.ts`。三个职责：
//   - token 的本地读写（`setCookie` / `getCookie`）——登录态在无 sessionStorage
//     约束的调用点靠它续命；
//   - 事件冒泡兼容层（`stopEventBubble`，W3C / 老 IE 双路径）；
//   - 请求头里的工号编码（`encodeHeaderValue`，把非 ASCII 收进 %XX/%uXXXX）。
import { getCookie, setCookie, stopEventBubble, encodeHeaderValue } from '@/shared/lib/cookies'

describe('setCookie / getCookie', () => {
  afterEach(() => {
    // 清掉本用例写下的 cookie，避免影响后续用例
    document.cookie = 'auth=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'
    document.cookie = 'empty=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'
  })

  it('setCookie 写入、getCookie 读出同一个值（token 读写闭环）', () => {
    setCookie('auth', 'token-abc', 1)

    expect(getCookie('auth')).toBe('token-abc')
  })

  it('getCookie 在多对 cookie 里精确匹配目标键，不串值', () => {
    document.cookie = 'other=1;path=/'
    setCookie('auth', 'x=y', 1)

    expect(getCookie('other')).toBe('1')
    // 值里的 `=` 不能被截断（token 常是 base64 形态）
    expect(getCookie('auth')).toBe('x=y')
    document.cookie = 'other=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'
  })

  it('读不存在的键返回 null（调用方据此判「未登录」）', () => {
    expect(getCookie('nope')).toBeNull()
  })

  it('days 会被换算成 expires（写入的串带过期时间与 path=/）', () => {
    const spy = vi.spyOn(document, 'cookie', 'set')

    setCookie('auth', 't', 7)

    const [written] = spy.mock.calls[0]
    expect(written).toContain('auth=t')
    expect(written).toContain('expires=')
    expect(written.endsWith('path=/')).toBe(true)
    spy.mockRestore()
  })
})

describe('stopEventBubble（W3C / IE 双路径）', () => {
  it('有 stopPropagation 的事件走 W3C 路径', () => {
    const event = new Event('click')
    const spy = vi.spyOn(event, 'stopPropagation')

    stopEventBubble(event)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('没有 stopPropagation 的事件（老 IE 形态）退回 cancelBubble = true', () => {
    const legacy = { cancelBubble: false }

    stopEventBubble(legacy)

    expect(legacy.cancelBubble).toBe(true)
  })
})

describe('encodeHeaderValue（工号进 X-Emp-No 前的编码）', () => {
  it('空串原样返回', () => {
    expect(encodeHeaderValue('')).toBe('')
  })

  it('纯 ASCII 字母与数字不编码（最常见的工号形态）', () => {
    expect(encodeHeaderValue('emp001')).toBe('emp001')
    expect(encodeHeaderValue('A7Z')).toBe('A7Z')
  })

  it('ASCII 特殊字符按字节编码成 %XX', () => {
    expect(encodeHeaderValue('user@example')).toBe('user%40example')
    expect(encodeHeaderValue('a b')).toBe('a%20b')
    expect(encodeHeaderValue('ä')).toBe('%e4') // U+00E4 < 256 → 两位十六进制
  })

  it('非 ASCII 字符编码成 %uXXXX（四位大写十六进制码点）', () => {
    expect(encodeHeaderValue('张')).toBe('%u5f20')
    expect(encodeHeaderValue('三')).toBe('%u4e09')
  })

  it('混合串只编码非字母数字的部分（保留原顺序）', () => {
    expect(encodeHeaderValue('z3张!')).toBe('z3%u5f20%21')
  })
})
