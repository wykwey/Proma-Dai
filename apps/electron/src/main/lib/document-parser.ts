/**
 * 文档解析服务 — 主进程侧入口
 *
 * 真正的解析逻辑与重依赖（mammoth / officeparser / word-extractor / pdf-parse /
 * pdfjs-dist）都在 document-extract.ts，由 document.worker 加载执行。这里只做：
 * - 附件相对路径解析（依赖 Electron 的 config-paths，不能进 worker）
 * - 把绝对路径交给 worker，并在 dist/workers 缺失时降级到进程内执行
 *
 * 对外签名与改造前完全一致，调用方无需改动。
 */

import { resolveAttachmentPath } from './config-paths'
import { createWorkerTask } from './worker-pool'
import type { OfficePreviewResult } from '@proma/shared'

// 廉价判定从 document-extensions 直接再导出：它没有重依赖，不能经 document-extract 中转，
// 否则 esbuild 会把 mammoth / officeparser 等 16MB 依赖打进 main.cjs。
export { isSupportedDocumentExtension, isDocumentAttachment } from './document-extensions'

type DocumentPayload =
  | { op: 'extractText'; filePath: string }
  | { op: 'docxToHtml'; filePath: string }
  | { op: 'officeToHtml'; filePath: string }

/**
 * 打包器不可见的动态 import。
 *
 * 降级实现必须引用 document-extract / office-convert，而这两个模块把
 * mammoth / officeparser / word-extractor / pdf-parse 全带了进来（实测约 16MB）。
 * 如果让 esbuild 静态分析到这条 import，它会把同样的 16MB 再打进 main.cjs，
 * 与 dist/workers/document.worker.cjs 形成重复。这里把 specifier 变量化，
 * 打包器就无法在构建期解析它，产物里只保留一条运行期 require。
 *
 * 运行期只有「未打包环境」（bun 直接跑 TS 源码 / 单测）才会走到这里；
 * 打包后的应用里 dist/workers 一定存在（electron-builder 的 files 包含 dist/**），
 * 因此永远走不到这条分支。
 */
function importOpaque(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>
}

/**
 * 降级实现：直接在进程内跑同一份纯逻辑。
 * 语义与 worker 侧一致，只是会占用主进程事件循环（等价于改造前的行为）。
 */
async function runInProcess(payload: DocumentPayload): Promise<unknown> {
  switch (payload.op) {
    case 'extractText': {
      const mod = await importOpaque('./document-extract')
      return (mod.extractTextFromFile as (filePath: string) => Promise<string>)(payload.filePath)
    }
    case 'docxToHtml': {
      const mod = await importOpaque('./office-convert')
      return (mod.convertDocxToHtmlAt as (filePath: string) => Promise<{ html: string }>)(payload.filePath)
    }
    case 'officeToHtml': {
      const mod = await importOpaque('./office-convert')
      return (mod.convertOfficeWithFallbackAt as (filePath: string) => Promise<OfficePreviewResult | null>)(payload.filePath)
    }
  }
}

const documentWorker = createWorkerTask<DocumentPayload, unknown>({
  name: 'document',
  fallback: runInProcess,
  // 文档解析单次可达秒级，给一个宽松但存在的上限，避免 worker 卡死时永久挂起
  timeoutMs: 5 * 60 * 1000,
})

/**
 * 从文件中提取纯文本内容
 *
 * @param filePath 文件的完整路径
 * @returns 提取的纯文本内容
 * @throws 不支持的格式或解析失败时抛出错误
 */
export async function extractTextFromFile(filePath: string): Promise<string> {
  return await documentWorker.run({ op: 'extractText', filePath }) as string
}

/**
 * 从附件相对路径提取文本（IPC 层使用）
 *
 * 将附件的 localPath（如 {conversationId}/{uuid}.ext）解析为完整路径后提取文本。
 */
export async function extractTextFromAttachment(localPath: string): Promise<string> {
  const fullPath = resolveAttachmentPath(localPath)
  return extractTextFromFile(fullPath)
}

/** DOCX → HTML（供内联预览使用，转换在 worker 内完成） */
export async function convertDocxToHtmlAtWorker(filePath: string): Promise<{ html: string }> {
  return await documentWorker.run({ op: 'docxToHtml', filePath }) as { html: string }
}

/** XLSX / PPTX → 结构化预览 HTML（含 officeparser 纯文本兜底） */
export async function convertOfficeToHtmlAtWorker(filePath: string): Promise<OfficePreviewResult | null> {
  return await documentWorker.run({ op: 'officeToHtml', filePath }) as OfficePreviewResult | null
}

/** 应用退出时释放 worker 线程 */
export function disposeDocumentWorker(): void {
  documentWorker.dispose()
}
