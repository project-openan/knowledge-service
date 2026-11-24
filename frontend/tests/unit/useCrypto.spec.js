// 测的是 `src/shared/composables/useCrypto.js`：请求签名（HMAC-SHA256）的组装层。
//
// 它把三件事拼成一个请求头：Nonce（去掉连字符的 uuid v4）、Timestamp（秒）与
// Signature（`Crypto.AES.encrypt(nonce:YYYYMMDDHHmm, secret)` 的十六进制 HMAC）。
// 签名内容里含**本地时间**的 `YYYYMMDDHHmm`（见 `crypto.js` 的 `format`），
// 所以这里用 fake timers 把时间钉死，再用 `node:crypto` 独立算一遍期望值做对照
// ——期望值不是抄实现，而是用另一条实现路径（OpenSSL）推出来的。
//
// `useCrypto → crypto.js → message.js → element-plus`：跑在 node 环境，
// 照 `crypto.insecure-context.spec.js` 的写法把 ElMessage 换成 spy。

vi.mock('element-plus', () => {
  const base = vi.fn()
  return {
    ElMessage: Object.assign(base, {
      success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), closeAll: vi.fn()
    })
  }
})

import { createHmac } from 'node:crypto'
import { ElMessage } from 'element-plus'
import { useCrypto } from '@/shared/composables/useCrypto'

/** 与 `Crypto.AES.format` 同一逻辑的独立复刻（本地时间的 YYYYMMDDHHmm）。 */
function localStamp (date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
}

describe('useCrypto', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 16, 17, 30, 0)) // 本地时间 2026-10-16 17:30
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('getConfig（唯一对外出口）', () => {
    it('headers 只包 Signature/Timestamp/Nonce 三个字段', async () => {
      const { getConfig } = useCrypto('secret-key')

      const config = await getConfig()

      expect(Object.keys(config)).toEqual(['headers'])
      expect(Object.keys(config.headers).sort()).toEqual(
        ['Nonce', 'Signature', 'Timestamp'].sort()
      )
    })

    it('Nonce 是去掉连字符的 uuid v4（32 位小写十六进制）', async () => {
      const { getConfig } = useCrypto('secret-key')

      const { headers } = await getConfig()

      // uuid v4 去掉 4 个连字符后剩 32 位；且 v4 的版本位固定为 4
      expect(headers.Nonce).toMatch(/^[0-9a-f]{32}$/)
      expect(headers.Nonce[12]).toBe('4')
    })

    it('Signature = HMAC-SHA256(`${Nonce}:${YYYYMMDDHHmm}`, secret) 的十六进制串', async () => {
      const { getConfig } = useCrypto('secret-key')

      const { headers } = await getConfig()

      const expected = createHmac('sha256', 'secret-key')
        .update(`${headers.Nonce}:${localStamp(new Date())}`)
        .digest('hex')
      expect(headers.Signature).toBe(expected)
      expect(headers.Signature).toMatch(/^[0-9a-f]{64}$/)
    })

    it('Timestamp 是秒级时间戳（不是毫秒）', async () => {
      const { getConfig } = useCrypto('secret-key')

      const { headers } = await getConfig()

      expect(headers.Timestamp).toBe(Math.floor(new Date(2026, 9, 16, 17, 30, 0).getTime() / 1000))
    })

    it('两次调用 Nonce 必须不同（防重放的前提）', async () => {
      const { getConfig } = useCrypto('secret-key')

      const first = await getConfig()
      const second = await getConfig()

      expect(first.headers.Nonce).not.toBe(second.headers.Nonce)
    })
  })

  describe('密钥缺失（doSignature 的兜底分支）', () => {
    // 现状钉子：`doSignature` 先给用户一条错误提示，然后继续走签名 —— 而空密钥
    // 在 WebCrypto 的 `importKey` 处抛 `DataError: Zero-length key is not supported`，
    // getConfig 因此整条 reject（不是返回空签名）。也就是说**空密钥的安全上下文里
    // 调用方拿不到 headers**，必须自己 catch。这里钉住这一行为，防止有人误以为
    // 「提示过就等于降级成功」。
    it('空 secret：先给用户错误提示，getConfig 整条 reject（WebCrypto 拒绝零长度密钥）', async () => {
      const { getConfig } = useCrypto('')

      await expect(getConfig()).rejects.toThrow()
      expect(ElMessage.error).toHaveBeenCalledTimes(1)
    })
  })
})
