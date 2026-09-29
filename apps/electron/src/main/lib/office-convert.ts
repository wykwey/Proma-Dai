/**
 * Office / OpenDocument 结构化预览转换（纯逻辑层）
 *
 * 从 file-preview-service.ts 抽出，目的是让 worker 能独立加载：
 * 本文件不得 import Electron、主进程路径解析或临时文件辅助函数。
 * 输入一律是「已解析好的绝对路径」，路径解析、大小校验与临时文件都由
 * file-preview-service 负责。
 */

import { basename, extname, posix as pathPosix } from 'node:path'
import AdmZip from 'adm-zip'
import { DOMParser } from '@xmldom/xmldom'
import type { OfficePreviewResult } from '@proma/shared'

/* 预览上限与 file-preview-service 的既有取值保持一致 */
const MAX_XLSX_SHEETS = 8
const MAX_XLSX_ROWS = 200
const MAX_XLSX_COLUMNS = 40
const MAX_PPTX_SLIDES = 80

// ─── Office Open XML 预览 ───

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml')
}

function getElementsByLocalName(root: Node, localName: string): Element[] {
  const result: Element[] = []

  function walk(node: Node): void {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children.item(i)
      if (child.nodeType === 1) {
        const element = child as Element
        if (element.localName === localName || element.nodeName === localName) {
          result.push(element)
        }
      }
      walk(child)
    }
  }

  walk(root)
  return result
}

function getDirectChildElementsByLocalName(root: Element | Document, localName: string): Element[] {
  const result: Element[] = []
  const children = root.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (child.nodeType !== 1) continue
    const element = child as Element
    if (element.localName === localName || element.nodeName === localName) {
      result.push(element)
    }
  }
  return result
}

function getFirstTextByLocalName(root: Element, localName: string): string {
  return getElementsByLocalName(root, localName)[0]?.textContent ?? ''
}

function readZipText(zip: AdmZip, path: string): string | null {
  const entry = zip.getEntry(path)
  return entry ? entry.getData().toString('utf-8') : null
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, '/')
  if (normalizedTarget.startsWith('/')) return normalizedTarget.slice(1)
  return pathPosix.normalize(pathPosix.join(baseDir, normalizedTarget))
}

function parseRelationships(zip: AdmZip, relsPath: string, baseDir: string): Map<string, string> {
  const relsXml = readZipText(zip, relsPath)
  const rels = new Map<string, string>()
  if (!relsXml) return rels

  const relsDoc = parseXml(relsXml)
  for (const rel of getElementsByLocalName(relsDoc, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (!id || !target) continue
    rels.set(id, normalizeZipTarget(baseDir, target))
  }
  return rels
}

function parseSharedStrings(zip: AdmZip): string[] {
  const sharedXml = readZipText(zip, 'xl/sharedStrings.xml')
  if (!sharedXml) return []

  const doc = parseXml(sharedXml)
  return getElementsByLocalName(doc, 'si').map((si) => (
    getElementsByLocalName(si, 't').map((node) => node.textContent ?? '').join('')
  ))
}

function isDateNumFmtId(numFmtId: number): boolean {
  return (
    (numFmtId >= 14 && numFmtId <= 22) ||
    (numFmtId >= 27 && numFmtId <= 36) ||
    (numFmtId >= 45 && numFmtId <= 47) ||
    (numFmtId >= 50 && numFmtId <= 58)
  )
}

function isDateFormatCode(formatCode: string): boolean {
  const normalized = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*]/g, '')
    .toLowerCase()
  return /[ymdhHsS]/.test(normalized)
}

function parseXlsxDateStyleIndexes(zip: AdmZip): Set<number> {
  const stylesXml = readZipText(zip, 'xl/styles.xml')
  const dateStyleIndexes = new Set<number>()
  if (!stylesXml) return dateStyleIndexes

  const doc = parseXml(stylesXml)
  const customFormats = new Map<number, string>()
  for (const numFmt of getElementsByLocalName(doc, 'numFmt')) {
    const id = Number(numFmt.getAttribute('numFmtId'))
    const code = numFmt.getAttribute('formatCode') ?? ''
    if (Number.isFinite(id) && code) customFormats.set(id, code)
  }

  const cellXfs = getElementsByLocalName(doc, 'cellXfs')[0]
  if (!cellXfs) return dateStyleIndexes

  getDirectChildElementsByLocalName(cellXfs, 'xf').forEach((xf, index) => {
    const numFmtId = Number(xf.getAttribute('numFmtId'))
    if (!Number.isFinite(numFmtId)) return
    const customFormatCode = customFormats.get(numFmtId)
    if (isDateNumFmtId(numFmtId) || (customFormatCode && isDateFormatCode(customFormatCode))) {
      dateStyleIndexes.add(index)
    }
  })

  return dateStyleIndexes
}

function formatExcelSerialDate(rawValue: string): string {
  const serial = Number(rawValue)
  if (!Number.isFinite(serial)) return rawValue

  const millis = Math.round((serial - 25569) * 86400 * 1000)
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return rawValue

  const year = date.getUTCFullYear()
  if (year < 1900 || year > 9999) return rawValue

  const pad = (value: number) => String(value).padStart(2, '0')
  const dateText = `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const hasTime = Math.abs(serial - Math.floor(serial)) > 0.000001
  if (!hasTime) return dateText
  return `${dateText} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function columnIndexFromCellRef(cellRef: string): number {
  const letters = cellRef.match(/[A-Za-z]+/)?.[0]?.toUpperCase()
  if (!letters) return 0
  let index = 0
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return Math.max(0, index - 1)
}

function columnNameFromIndex(index: number): string {
  let value = index + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function getXlsxCellText(cell: Element, sharedStrings: string[], dateStyleIndexes: Set<number>): string {
  const type = cell.getAttribute('t')
  if (type === 'inlineStr') {
    return getElementsByLocalName(cell, 't').map((node) => node.textContent ?? '').join('')
  }

  const value = getFirstTextByLocalName(cell, 'v')
  if (!value) return ''

  if (type === 's') {
    const sharedIndex = Number(value)
    return Number.isInteger(sharedIndex) ? sharedStrings[sharedIndex] ?? '' : ''
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'

  const styleIndex = Number(cell.getAttribute('s'))
  if (!type && Number.isInteger(styleIndex) && dateStyleIndexes.has(styleIndex)) {
    return formatExcelSerialDate(value)
  }

  return value
}

function parseXlsxSheetRows(
  zip: AdmZip,
  sheetPath: string,
  sharedStrings: string[],
  dateStyleIndexes: Set<number>,
): { rows: string[][]; truncatedRows: boolean; truncatedColumns: boolean } {
  const sheetXml = readZipText(zip, sheetPath)
  if (!sheetXml) return { rows: [], truncatedRows: false, truncatedColumns: false }

  const doc = parseXml(sheetXml)
  const rows: string[][] = []
  let truncatedRows = false
  let truncatedColumns = false

  for (const row of getElementsByLocalName(doc, 'row')) {
    if (rows.length >= MAX_XLSX_ROWS) {
      truncatedRows = true
      break
    }

    const values: string[] = []
    for (const cell of getDirectChildElementsByLocalName(row, 'c')) {
      const cellRef = cell.getAttribute('r') ?? ''
      const colIndex = columnIndexFromCellRef(cellRef)
      if (colIndex >= MAX_XLSX_COLUMNS) {
        truncatedColumns = true
        continue
      }
      values[colIndex] = getXlsxCellText(cell, sharedStrings, dateStyleIndexes)
    }

    while (values.length > 0 && !values[values.length - 1]) values.pop()
    if (values.some((value) => value.trim().length > 0)) rows.push(values)
  }

  return { rows, truncatedRows, truncatedColumns }
}

function renderXlsxTable(rows: string[][]): string {
  if (rows.length === 0) {
    return '<div class="office-empty">这个工作表没有可预览的数据</div>'
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1)
  const headerCells = Array.from({ length: columnCount }, (_, index) => (
    `<th>${escapeHtml(columnNameFromIndex(index))}</th>`
  )).join('')
  const bodyRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, index) => (
      `<td>${escapeHtml(row[index] ?? '')}</td>`
    )).join('')
    return `<tr><th class="office-row-heading">${rowIndex + 1}</th>${cells}</tr>`
  }).join('')

  return `<div class="office-table-wrap"><table><thead><tr><th></th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
}

function convertXlsxToHtml(filePath: string, resolvedPath: string): OfficePreviewResult {
  const zip = new AdmZip(resolvedPath)
  const workbookXml = readZipText(zip, 'xl/workbook.xml')
  if (!workbookXml) throw new Error('Invalid XLSX: workbook.xml missing')

  const workbookDoc = parseXml(workbookXml)
  const relationships = parseRelationships(zip, 'xl/_rels/workbook.xml.rels', 'xl')
  const sharedStrings = parseSharedStrings(zip)
  const dateStyleIndexes = parseXlsxDateStyleIndexes(zip)
  const sheets = getElementsByLocalName(workbookDoc, 'sheet')

  let truncatedSheets = false
  let truncatedRows = false
  let truncatedColumns = false
  const textParts: string[] = []
  const htmlParts: string[] = []

  sheets.slice(0, MAX_XLSX_SHEETS).forEach((sheet, sheetIndex) => {
    const name = sheet.getAttribute('name') || `Sheet ${sheetIndex + 1}`
    const relationshipId = sheet.getAttribute('r:id') ?? sheet.getAttribute('id')
    const sheetPath = relationshipId ? relationships.get(relationshipId) : undefined
    if (!sheetPath) return

    const parsed = parseXlsxSheetRows(zip, sheetPath, sharedStrings, dateStyleIndexes)
    truncatedRows ||= parsed.truncatedRows
    truncatedColumns ||= parsed.truncatedColumns
    textParts.push(`[${name}]`)
    textParts.push(...parsed.rows.map((row) => row.join('\t')))
    htmlParts.push(`<section class="office-sheet"><h3>${escapeHtml(name)}</h3>${renderXlsxTable(parsed.rows)}</section>`)
  })

  if (htmlParts.length === 0) {
    throw new Error('Invalid XLSX: no worksheet data resolved')
  }

  truncatedSheets = sheets.length > MAX_XLSX_SHEETS
  const notices = [
    truncatedSheets ? `仅显示前 ${MAX_XLSX_SHEETS} 个工作表` : null,
    truncatedRows ? `每个工作表最多显示 ${MAX_XLSX_ROWS} 行` : null,
    truncatedColumns ? `每行最多显示 ${MAX_XLSX_COLUMNS} 列` : null,
  ].filter(Boolean)
  const noticeHtml = notices.length > 0
    ? `<div class="office-preview-notice">${escapeHtml(notices.join('，'))}</div>`
    : ''
  const title = escapeHtml(basename(filePath))
  const html = `<div class="office-preview office-preview-spreadsheet"><div class="office-preview-title">${title}</div>${noticeHtml}${htmlParts.join('')}</div>`

  return {
    resolvedPath,
    kind: 'spreadsheet',
    html,
    text: textParts.join('\n').trim(),
  }
}

function getPptxSlidePaths(zip: AdmZip): string[] {
  const presentationXml = readZipText(zip, 'ppt/presentation.xml')
  const relationships = parseRelationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt')
  if (presentationXml) {
    const doc = parseXml(presentationXml)
    const slidePaths = getElementsByLocalName(doc, 'sldId')
      .map((slide) => slide.getAttribute('r:id') ?? slide.getAttribute('id'))
      .map((relationshipId) => relationshipId ? relationships.get(relationshipId) : undefined)
      .filter((path): path is string => Boolean(path))
    if (slidePaths.length > 0) return slidePaths
  }

  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/.test(entryName))
    .sort((a, b) => {
      const aIndex = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      const bIndex = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      return aIndex - bIndex
    })
}

function getPptxSlideText(zip: AdmZip, slidePath: string): string[] {
  const slideXml = readZipText(zip, slidePath)
  if (!slideXml) return []

  const doc = parseXml(slideXml)
  return getElementsByLocalName(doc, 'p')
    .map((paragraph) => getElementsByLocalName(paragraph, 't').map((textNode) => textNode.textContent ?? '').join('').trim())
    .filter(Boolean)
}

function convertPptxToHtml(filePath: string, resolvedPath: string): OfficePreviewResult {
  const zip = new AdmZip(resolvedPath)
  const slidePaths = getPptxSlidePaths(zip)
  const visibleSlidePaths = slidePaths.slice(0, MAX_PPTX_SLIDES)
  const textParts: string[] = []
  const slideHtml = visibleSlidePaths.map((slidePath, index) => {
    const lines = getPptxSlideText(zip, slidePath)
    textParts.push(`幻灯片 ${index + 1}`)
    textParts.push(...lines)
    const title = lines[0] || '（无标题）'
    const body = lines.length > 1
      ? `<ul>${lines.slice(1).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      : '<div class="office-empty">这页没有更多可提取文本</div>'
    return `<section class="office-slide"><div class="office-slide-index">幻灯片 ${index + 1}</div><h3>${escapeHtml(title)}</h3>${body}</section>`
  }).join('')

  const noticeHtml = slidePaths.length > MAX_PPTX_SLIDES
    ? `<div class="office-preview-notice">仅显示前 ${MAX_PPTX_SLIDES} 页幻灯片</div>`
    : ''
  const emptyHtml = slideHtml || '<div class="office-empty">这个 PPTX 没有可提取的文本内容</div>'
  const title = escapeHtml(basename(filePath))
  const html = `<div class="office-preview office-preview-presentation"><div class="office-preview-title">${title}</div>${noticeHtml}${emptyHtml}</div>`

  return {
    resolvedPath,
    kind: 'presentation',
    html,
    text: textParts.join('\n').trim(),
  }
}

// ─── worker 入口（只接收已解析的绝对路径） ───

interface MammothModule {
  convertToHtml(input: { path: string }): Promise<{ value: string }>
}

interface OfficeParserModule {
  parseOfficeAsync(file: string | Buffer): Promise<string>
}

/** 结构化预览失败时的纯文本 HTML 兜底（原本在 file-preview-service） */
function renderOfficeTextFallback(filePath: string, text: string, kind: OfficePreviewResult['kind']): string {
  const title = escapeHtml(basename(filePath))
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  const body = paragraphs.length > 0
    ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')
    : '<div class="office-empty">没有可提取的文本内容</div>'
  return `<div class="office-preview office-preview-${kind}"><div class="office-preview-title">${title}</div>${body}</div>`
}

/** DOCX → HTML（mammoth） */
export async function convertDocxToHtmlAt(safePath: string): Promise<{ html: string }> {
  const mammoth = await import('mammoth') as unknown as MammothModule
  const result = await mammoth.convertToHtml({ path: safePath })
  return { html: result.value }
}

/** XLSX / PPTX → 结构化 HTML。其它格式抛错，由调用方决定是否回退纯文本。 */
export async function convertOfficeToHtmlAt(safePath: string): Promise<OfficePreviewResult> {
  const ext = extname(safePath).toLowerCase()
  if (ext === '.xlsx') return convertXlsxToHtml(safePath, safePath)
  if (ext === '.pptx') return convertPptxToHtml(safePath, safePath)
  throw new Error(`不支持结构化预览的格式: ${ext}`)
}

/**
 * 结构化预览 + officeparser 纯文本兜底。
 *
 * 兜底逻辑原本写在 file-preview-service 里，一并搬到 worker：它同样会解压整个 OOXML
 * 包，留在主进程等于把重活又搬了回来。
 */
export async function convertOfficeWithFallbackAt(safePath: string): Promise<OfficePreviewResult | null> {
  try {
    return await convertOfficeToHtmlAt(safePath)
  } catch (err) {
    console.error('[office-convert] 结构化预览失败，回退 officeparser 纯文本:', err)
    try {
      const officeParser = await import('officeparser') as unknown as OfficeParserModule
      const text = await officeParser.parseOfficeAsync(safePath)
      const ext = extname(safePath).toLowerCase()
      const kind: OfficePreviewResult['kind'] = ext === '.pptx' ? 'presentation' : 'spreadsheet'
      return {
        resolvedPath: safePath,
        kind,
        html: renderOfficeTextFallback(safePath, text, kind),
        text,
      }
    } catch (fallbackErr) {
      console.error('[office-convert] officeparser 回退也失败:', fallbackErr)
      return null
    }
  }
}
