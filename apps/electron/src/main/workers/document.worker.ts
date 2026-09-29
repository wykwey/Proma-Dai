/**
 * 文档解析 worker
 *
 * 承载所有「解压 + 解析」类重活：PDF、DOCX/XLSX/PPTX/ODT、旧版 Word/WPS、RTF，
 * 以及 Office → HTML 的结构化预览转换。这些依赖（mammoth / officeparser /
 * word-extractor / adm-zip / @xmldom/xmldom）原先被 esbuild 打进主进程 bundle，
 * 解析时直接占用主进程事件循环；搬进 worker 后主进程只做路径解析与大小校验。
 *
 * 注意：pdfjs-dist 保持 external，运行时从 apps/electron/node_modules 解析，
 * 与主进程的模块解析策略一致。
 */

import { extractTextFromFile } from '../lib/document-extract'
import { convertDocxToHtmlAt, convertOfficeWithFallbackAt } from '../lib/office-convert'
import { serveWorker } from './worker-bootstrap'

interface DocumentPayload {
  op: string
  /** 已解析好的绝对路径 */
  filePath: string
}

serveWorker({
  name: 'document',
  handlers: {
    /** 任意受支持格式 → 纯文本 */
    extractText: (payload) => {
      const { filePath } = payload as DocumentPayload
      return extractTextFromFile(filePath)
    },

    /** DOCX → HTML */
    docxToHtml: async (payload) => {
      const { filePath } = payload as DocumentPayload
      return convertDocxToHtmlAt(filePath)
    },

    /** XLSX / PPTX → 结构化 HTML，失败回退纯文本 */
    officeToHtml: (payload) => {
      const { filePath } = payload as DocumentPayload
      return convertOfficeWithFallbackAt(filePath)
    },
  },
})
