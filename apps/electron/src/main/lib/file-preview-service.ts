/**
 * 文件预览服务 — 内联预览支持
 *
 * 提供文件路径解析、PDF 预览 HTML 生成、DOCX 转 HTML 等功能，
 * 供 PreviewPanel 内联面板使用。
 */

import { basename, join, dirname, extname, resolve } from 'node:path'
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, unlinkSync, promises as fsPromises } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { OfficePreviewResult } from '@proma/shared'
// Office / DOCX 转换搬到 worker（office-convert.ts），这里只保留路径解析与临时文件
import { convertDocxToHtmlAtWorker, convertOfficeToHtmlAtWorker } from './document-parser'

const require = createRequire(__filename)
const PDFJS_PACKAGE = 'pdfjs-dist'

/** 文件大小限制：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024

// ─── 临时文件 ───

function getPreviewTmpDir(): string {
  const dir = join(tmpdir(), 'proma-preview')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function writeTempHtml(html: string): string {
  const tmpDir = getPreviewTmpDir()
  const contentHash = createHash('md5').update(html).digest('hex').slice(0, 16)
  const tmpFile = join(tmpDir, `preview-${contentHash}.html`)
  if (!existsSync(tmpFile)) {
    writeFileSync(tmpFile, html, 'utf-8')
  }
  return tmpFile
}

/** 清理所有临时预览文件 */
export function cleanPreviewTmpDir(): number {
  const dir = join(tmpdir(), 'proma-preview')
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    for (const f of readdirSync(dir)) {
      try { unlinkSync(join(dir, f)); count++ } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count
}

// ─── 路径解析 ───

/**
 * 在目录中递归搜索指定文件名
 */
function searchFileInDir(dir: string, targetName: string, maxDepth = 8): string | null {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache', 'target'])
  let scanned = 0
  const MAX_SCANNED = 500

  function walk(current: string, depth: number): string | null {
    if (depth > maxDepth || scanned > MAX_SCANNED) return null
    try {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name === targetName) {
          return join(current, entry.name)
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          scanned++
          const found = walk(join(current, entry.name), depth + 1)
          if (found) return found
        }
      }
    } catch { /* permission denied etc */ }
    return null
  }

  return walk(dir, 0)
}

/**
 * 解析待预览的文件路径
 * - 绝对路径：直接 resolve，不存在时 fallback 搜索
 * - 相对路径：依次尝试 basePaths，返回第一个存在的；都不存在则 fallback 搜索
 */
export function resolveTargetPath(filePath: string, basePaths?: string[]): string {
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    const direct = resolve(filePath)
    if (existsSync(direct)) return direct
    const name = basename(direct)
    if (basePaths) {
      for (const base of basePaths) {
        if (!base) continue
        const found = searchFileInDir(base, name)
        if (found) return found
      }
    }
    const awIdx = filePath.indexOf('agent-workspaces')
    if (awIdx !== -1) {
      const wsRoot = filePath.slice(0, awIdx + 'agent-workspaces'.length)
      if (existsSync(wsRoot)) {
        const found = searchFileInDir(wsRoot, name)
        if (found) return found
      }
    }
    return direct
  }
  if (basePaths && basePaths.length > 0) {
    const firstSegment = filePath.split('/')[0]
    if (firstSegment) {
      for (const base of basePaths) {
        if (!base) continue
        if (basename(base) === firstSegment) {
          const candidate = resolve(dirname(base), filePath)
          if (existsSync(candidate)) return candidate
        }
      }
    }
    for (const base of basePaths) {
      if (!base) continue
      const candidate = resolve(base, filePath)
      if (existsSync(candidate)) return candidate
    }
    const home = homedir()
    const homeCandidate = resolve(home, filePath)
    if (existsSync(homeCandidate)) return homeCandidate
    const rootCandidate = resolve('/', filePath)
    if (existsSync(rootCandidate)) return rootCandidate
    const name = basename(filePath)
    for (const base of basePaths) {
      if (!base) continue
      const found = searchFileInDir(base, name)
      if (found) return found
    }
    return resolve(basePaths[0]!, filePath)
  }
  const homeCandidate = resolve(homedir(), filePath)
  if (existsSync(homeCandidate)) return homeCandidate
  const rootCandidate = resolve('/', filePath)
  if (existsSync(rootCandidate)) return rootCandidate
  return resolve(filePath)
}


// ─── 导出：内联预览 API ───

/**
 * 解析文件路径并读取内容（供内联文本/代码预览使用）
 *
 * 用异步 fs 读：预览上限 50MB，同步读会把主进程事件循环卡住整个读取时长。
 */
export async function resolveAndReadFile(filePath: string, basePaths?: string[]): Promise<{ resolvedPath: string; content: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null
    const content = await fsPromises.readFile(safePath, 'utf-8')
    return { resolvedPath: safePath, content }
  } catch {
    return null
  }
}

/** 仅解析文件路径（不读取内容），供图片等用 proma-file:// 协议加载的场景使用 */
export function resolveFilePath(filePath: string, basePaths?: string[]): string | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  return existsSync(safePath) ? safePath : null
}

/** 为内联 PDF 预览生成临时 HTML 文件（使用 proma-file:// 加载 PDF，无体积膨胀） */
export async function preparePdfPreview(filePath: string, basePaths?: string[]): Promise<{ resolvedPath: string; tmpHtmlUrl: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  const st = statSync(safePath)
  if (st.size > MAX_FILE_SIZE) return null

  let fileUrl: string
  let pdfScriptUrl: string
  let pdfWorkerUrl: string
  let standardFontDataUrl: string
  let registerFilePath: (path: string) => string
  try {
    const { registerPromaDirectoryPath, registerPromaFilePath } = await import('./local-file-protocol')
    registerFilePath = registerPromaFilePath
    fileUrl = registerPromaFilePath(safePath)
    pdfScriptUrl = registerPromaFilePath(require.resolve(`${PDFJS_PACKAGE}/build/pdf.min.mjs`))
    pdfWorkerUrl = registerPromaFilePath(require.resolve(`${PDFJS_PACKAGE}/build/pdf.worker.min.mjs`))
    const pdfPackageDir = dirname(require.resolve(`${PDFJS_PACKAGE}/package.json`))
    standardFontDataUrl = `${registerPromaDirectoryPath(join(pdfPackageDir, 'standard_fonts'))}/`
  } catch (err) {
    console.error('[file-preview] preparePdfPreview asset resolution failed:', err)
    return null
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: auto; padding: 16px; }
  #c { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: fit-content; min-width: 100%; }
  #c canvas { box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin: 0 auto; display: block; }
  .loading { color: #888; font: 12px/1.5 system-ui; padding: 40px; text-align: center; width: 100%; }
  .error { color: #f87171; font: 12px/1.5 system-ui; padding: 20px; text-align: center; width: 100%; }
  .page-info { color: #888; font: 11px/1.5 system-ui; text-align: center; padding: 4px; width: 100%; }
</style>
</head><body>
  <div class="loading" id="c">正在加载 PDF...</div>
  <script type="module">
    const container = document.getElementById('c');
    const fileUrl = ${JSON.stringify(fileUrl)};
    const pdfScriptUrl = ${JSON.stringify(pdfScriptUrl)};
    const pdfWorkerUrl = ${JSON.stringify(pdfWorkerUrl)};
    const standardFontDataUrl = ${JSON.stringify(standardFontDataUrl)};
    const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    let stepIdx = 2;
    let pdfDoc = null;

    function notifyZoom() {
      window.parent.postMessage({ type: 'pdf-zoom-changed', zoom: Math.round(STEPS[stepIdx] * 100) }, '*');
    }

    async function renderAll() {
      if (!pdfDoc) return;
      container.innerHTML = '';
      const userScale = STEPS[stepIdx];
      const dpr = window.devicePixelRatio || 1;
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: userScale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = (vp.width / dpr) + 'px';
        canvas.style.height = (vp.height / dpr) + 'px';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        container.appendChild(canvas);
      }
      const info = document.createElement('div');
      info.className = 'page-info';
      info.textContent = '共 ' + pdfDoc.numPages + ' 页';
      container.appendChild(info);
      notifyZoom();
    }

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'pdf-zoom') {
        if (e.data.direction === 'in' && stepIdx < STEPS.length - 1) { stepIdx++; renderAll(); }
        if (e.data.direction === 'out' && stepIdx > 0) { stepIdx--; renderAll(); }
      }
    });

    try {
      const pdfjsLib = await import(pdfScriptUrl);
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      pdfDoc = await pdfjsLib.getDocument({
        url: fileUrl,
        standardFontDataUrl,
      }).promise;
      await renderAll();
    } catch (err) {
      container.innerHTML = '<div class="error">PDF 加载失败: ' + err.message + '<\\/div>';
    }
  <\/script>
<\/body><\/html>`
  const tmpHtmlPath = writeTempHtml(html)
  const tmpHtmlUrl = registerFilePath(tmpHtmlPath)
  return { resolvedPath: safePath, tmpHtmlUrl }
}

/** 将 DOCX 文件转换为 HTML（供内联预览使用） */
export async function convertDocxToHtml(filePath: string, basePaths?: string[]): Promise<{ resolvedPath: string; html: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null
    // 转换（mammoth 解压 + 解析）在 worker 内执行，避免占用主进程事件循环
    const { html } = await convertDocxToHtmlAtWorker(safePath)
    return { resolvedPath: safePath, html }
  } catch (err) {
    console.error('[file-preview] convertDocxToHtml failed:', err)
    return null
  }
}

/** 将 XLSX/PPTX 转成可内联展示的 HTML 预览 */
export async function convertOfficeToHtml(filePath: string, basePaths?: string[]): Promise<OfficePreviewResult | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null

  const ext = extname(safePath).toLowerCase()
  // 只有这两种格式有结构化预览；其余格式保持原有行为（直接返回 null，不做文本兜底）
  if (ext !== '.xlsx' && ext !== '.pptx') return null

  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null
    return await convertOfficeToHtmlAtWorker(safePath)
  } catch (err) {
    console.error('[file-preview] convertOfficeToHtml failed:', err)
    return null
  }
}
