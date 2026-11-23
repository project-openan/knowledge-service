/**
 * 图谱「静态模板包下载 / 导出包落盘」的共享传输函数。
 *
 * GraphList.vue（图谱知识库列表）与 GraphTemplateList.vue（图谱模版列表）
 * 原来各自实现了一份 fetch 模板包 + 建隐藏 <a> 触发下载的代码，两份只在
 * 「文件名」上有差别 —— 这里把它们收敛成一份，文件名（语言后缀的包名）
 * 由调用方传入，本模块不感知是「图谱包」还是「模版包」。
 *
 * 注意：`new URL(..., import.meta.url)` 的相对路径以**本文件**为基准，
 * lib/ 在 features/graph/ 下再深一层，所以到 src/assets/template 要回退
 * 三层（原来写在两个 .vue 里时是两层）。
 */

/** 按当前语言挑模板包文件名：两页的包名不同，ZH/EN 名字由调用方给。 */
export function localizedTemplateFileName (locale, names) {
  return names[locale === 'zh' ? 'zh' : 'en']
}

/** 静态模板包地址（assets/template 目录，按语言选择 ZH/EN 包）。 */
export function templateZipUrl (fileName) {
  return new URL(`../../../assets/template/${fileName}`, import.meta.url)
}

/** fetch 静态资源为 Blob；非 2xx 抛错（失败文案由调用方统一弹）。 */
export async function fetchTemplateZip (templateUrl) {
  const response = await fetch(templateUrl)
  if (!response.ok) {
    throw new Error('Failed to fetch template file')
  }
  return await response.blob()
}

/** 通用「Blob 触发浏览器下载」：模板包下载与图谱/模版导出落盘共用这一份。 */
export function saveBlobAsFile (blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  // 将链接添加到 DOM，触发点击，然后移除
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // 释放 URL 对象
  URL.revokeObjectURL(url)
}

/** 静态模板包下载：fetch 模板包 → Blob → 触发浏览器下载。 */
export async function downloadStaticTemplateZip (fileName) {
  const blob = await fetchTemplateZip(templateZipUrl(fileName))
  saveBlobAsFile(blob, fileName)
}
