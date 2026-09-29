/**
 * 文档扩展名分类（纯常量与判定，无任何重依赖）
 *
 * 单独成文件的原因：主进程需要通过它做「这个附件要不要解析」的廉价判定，
 * 而真正的解析实现（document-extract.ts）带着 mammoth / officeparser /
 * word-extractor / pdf-parse 等约 16MB 依赖，只能待在 worker 侧。
 * 如果判定函数留在 document-extract.ts，主进程一旦引用就会把这些依赖
 * 全部打进 main.cjs。
 */

/** officeparser 支持的格式 */
export const OFFICE_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.pptx',
  '.odt', '.odp', '.ods',
  '.docm', '.dotx', '.dotm',
  '.xlsm', '.xltx', '.xltm',
  '.pptm', '.potx', '.potm', '.ppsx', '.ppsm',
])

/** 旧版 Word/WPS Writer 格式 */
export const LEGACY_WORD_EXTENSIONS = new Set([
  '.doc', '.dot', '.wps', '.wpt',
])

/** WPS 原生表格/演示格式：尽量交给 Office 解析器尝试 */
export const WPS_OFFICE_EXTENSIONS = new Set([
  '.et', '.ett', '.dps', '.dpt',
])

/** RTF 文档 */
export const RICH_TEXT_EXTENSIONS = new Set([
  '.rtf',
])

/** 纯文本格式（直接 UTF-8 读取） */
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.html',
  '.js', '.ts', '.py', '.yaml', '.yml', '.toml',
  '.log', '.ini', '.cfg', '.conf', '.sh', '.bat',
  '.css', '.scss', '.less', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile',
])

/** 所有支持文档解析的扩展名（不含图片） */
export const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  ...OFFICE_EXTENSIONS,
  ...LEGACY_WORD_EXTENSIONS,
  ...WPS_OFFICE_EXTENSIONS,
  ...RICH_TEXT_EXTENSIONS,
  ...TEXT_EXTENSIONS,
])

/**
 * 判断文件扩展名是否支持文本提取
 *
 * @param ext 文件扩展名（含点号，如 '.pdf'）
 */
export function isSupportedDocumentExtension(ext: string): boolean {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * 根据 MIME 类型判断是否为可解析文档（非图片附件）
 *
 * 排除图片类型，其余尝试按扩展名判断。
 */
export function isDocumentAttachment(mediaType: string): boolean {
  return !mediaType.startsWith('image/')
}
