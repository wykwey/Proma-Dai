#!/usr/bin/env bun
/**
 * 构建 proma CLI 运行时（打包进桌面应用的那一份）。
 *
 * 背景（0.16.12 起）：
 * - 早期实现用 `bun build --compile` 产出「自包含二进制」，但 CLI 本身只是
 *   session list/info/outline/search/export 这几个纯 Node 命令，自包含意味着
 *   每个安装包都要多背一份完整 Bun 运行时：linux-x64 上是 78MB（xz 后 27MB，
 *   占 deb 体积约 18%）。而且它是宿主架构产物，交叉打包时会被塞进其他架构的
 *   包里（0.16.11 的 arm64 包里 CLI 与 amd64 包逐字节相同，且根本跑不起来）。
 *
 * 方案（按平台分流）：
 * - Linux / macOS：esbuild 打出一份纯 JS bundle（几百 KB），再由
 *   `resources/bin/proma` 包装脚本用 Electron 自带的 Node 模式
 *   （ELECTRON_RUN_AS_NODE=1）运行，不再单独打包运行时。
 * - Windows：继续沿用 bun --compile 的 `proma.exe`。原因是 WSL 的 binfmt 只识别
 *   PE 可执行文件，`.cmd`/`.bat` 是文本文件，在 WSL 里 `"$PROMA_CLI" ...` 无法直接
 *   执行（Pi 适配器会把 PROMA_CLI 转成 /mnt/<drive>/... 注入 WSL，见
 *   `adapters/pi-agent-adapter.ts`）。Git Bash 能跑 .cmd，但 WSL 不能，故不冒险。
 *   仍会额外产出 proma.cmd，供从 Linux/macOS 交叉打 Windows 包时兜底。
 *   TODO: 若要一并压缩 Windows 安装包，可在 WSL 侧改为注入 shell function
 *   （export -f proma）而不是路径，这样 .cmd 也能用上。
 *
 * 产物（都在 .gitignore 覆盖的 resources/bin/ 下，构建时生成）：
 *   resources/bin/proma-cli.cjs   CLI bundle（非 Windows）
 *   resources/bin/proma           POSIX sh 包装脚本（非 Windows）
 *   resources/bin/proma.cmd       Windows 包装脚本（兜底/交叉打包）
 *   resources/bin/proma.exe       Windows 自包含二进制（win32 宿主构建）
 *
 * 在 electron app 的 build 链中调用（见 package.json build:cli）。
 */
import { rmSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

// apps/electron/scripts → repo 根
const electronDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronDir, '../..')
const cliEntry = join(repoRoot, 'apps/cli/src/index.ts')
const outDir = join(electronDir, 'resources/bin')
const isWindows = process.platform === 'win32'

function fail(msg: string): never {
  console.error(`${color.red}${color.bold}[build:cli] ${msg}${color.reset}`)
  process.exit(1)
}

if (!existsSync(cliEntry)) {
  fail(`找不到 CLI 入口: ${cliEntry}`)
}

mkdirSync(outDir, { recursive: true })

/**
 * POSIX 包装脚本。
 *
 * 候选顺序覆盖 Electron 各平台的可执行文件布局（相对 resources/bin）：
 * - Linux：<install>/resources/bin/proma         → <install>/proma
 * - macOS：Proma.app/Contents/Resources/bin/proma → Proma.app/Contents/MacOS/Proma
 */
const shWrapper = `#!/bin/sh
# proma CLI 启动包装脚本（由 apps/electron/scripts/build-cli.ts 生成，勿手工修改）
#
# 用宿主 Electron 二进制以 Node 模式运行 CLI bundle，避免为 CLI 单独打包运行时。
set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLE="$DIR/proma-cli.cjs"

if [ ! -f "$BUNDLE" ]; then
  echo "proma: 找不到 CLI bundle: $BUNDLE" >&2
  exit 1
fi

for BIN in "$DIR/../../proma" "$DIR/../../MacOS/Proma" "$DIR/../../Proma"; do
  if [ -x "$BIN" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$BIN" "$BUNDLE" "$@"
  fi
done

echo "proma: 找不到 Proma 应用可执行文件（已尝试 resources 同级目录与 macOS Contents/MacOS）" >&2
exit 1
`

/**
 * Windows 包装脚本。
 *
 * 这里刻意不用 for 块：块内的 %ERRORLEVEL% 在解析期就展开了，取不到真实退出码。
 */
const cmdWrapper = `@echo off
rem proma CLI 启动包装脚本（由 apps/electron/scripts/build-cli.ts 生成，勿手工修改）
setlocal

set "DIR=%~dp0"
set "BUNDLE=%DIR%proma-cli.cjs"
set "EXE=%DIR%..\\..\\Proma.exe"

if not exist "%EXE%" set "EXE=%DIR%..\\..\\proma.exe"

if not exist "%EXE%" (
  echo proma: 找不到 Proma 应用可执行文件 1>&2
  exit /b 1
)

if not exist "%BUNDLE%" (
  echo proma: 找不到 CLI bundle: %BUNDLE% 1>&2
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" "%BUNDLE%" %*
exit /b %ERRORLEVEL%
`

const started = Date.now()
const produced: string[] = []

/** 非 Windows：esbuild bundle + POSIX 包装脚本 */
async function buildBundle(): Promise<void> {
  const bundleOut = join(outDir, 'proma-cli.cjs')
  await build({
    entryPoints: [cliEntry],
    outfile: bundleOut,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Electron 43 内置 Node 22，按 Node 22 语法目标输出即可
    target: 'node22',
    sourcemap: false,
    logLevel: 'warning',
  }).catch((err: unknown) => {
    fail(`esbuild 打包 CLI 失败: ${err instanceof Error ? err.message : String(err)}`)
  })

  const shPath = join(outDir, 'proma')
  writeFileSync(shPath, shWrapper, 'utf-8')
  chmodSync(shPath, 0o755)
  produced.push(`proma-cli.cjs (${(statSync(bundleOut).size / 1024).toFixed(0)}KB)`, 'proma')
}

/** Windows：bun --compile 自包含二进制（WSL 需要真正的 PE 可执行文件） */
function buildWindowsBinary(): void {
  const outFile = join(outDir, 'proma.exe')

  // bun build --compile 在 Windows 上会尝试把自身复制到临时目录，
  // 若 bun.exe 位于过长路径（如 ~/.bun/bin/bun.exe）会报 ENOENT。
  // 解决：复制到短路径（os.tmpdir()）后用 --compile-executable-path 指向副本。
  let tempBunPath: string | undefined
  const compileArgs = ['build', '--compile', '--outfile', outFile, cliEntry]
  try {
    tempBunPath = join(tmpdir(), `bun-temp-${Date.now()}-${process.pid}.exe`)
    copyFileSync(process.execPath, tempBunPath)
    compileArgs.splice(2, 0, '--compile-executable-path', tempBunPath)
    console.log(`${color.dim}[build:cli] Windows 短路径 workaround: ${tempBunPath}${color.reset}`)
  } catch (err) {
    tempBunPath = undefined
    console.warn(`${color.yellow}[build:cli] 无法复制 bun 到临时目录: ${err}，尝试直接编译${color.reset}`)
  }

  try {
    const result = spawnSync('bun', compileArgs, { cwd: join(repoRoot, 'apps/cli'), stdio: 'inherit' })
    if (result.status !== 0) fail(`bun build --compile 失败（exit ${result.status}）`)
    if (!existsSync(outFile)) fail(`编译完成但未产出二进制: ${outFile}`)
  } finally {
    if (tempBunPath) {
      try {
        unlinkSync(tempBunPath)
      } catch {
        console.warn(`${color.yellow}[build:cli] 无法删除临时 bun 副本: ${tempBunPath}${color.reset}`)
      }
    }
  }

  produced.push(`proma.exe (${(statSync(outFile).size / 1024 / 1024).toFixed(0)}MB)`)
}

if (isWindows) {
  buildWindowsBinary()
} else {
  await buildBundle()
  // 交叉打 Windows 包（在 Linux/macOS 上 --win）时，bundle 仍是唯一可选实现
  produced.push('proma.cmd')
}

writeFileSync(join(outDir, 'proma.cmd'), cmdWrapper, 'utf-8')

// 清理可能残留的历史产物，避免误打进安装包
if (!isWindows) {
  for (const legacy of ['proma.exe', 'proma-bun']) {
    const legacyPath = join(outDir, legacy)
    if (existsSync(legacyPath)) {
      rmSync(legacyPath, { force: true })
      console.log(`${color.yellow}[build:cli] 已清理历史二进制 ${legacy}${color.reset}`)
    }
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(
  `${color.green}${color.bold}[build:cli] ✓${color.reset} ${produced.join(' + ')} ${color.dim}(${elapsed}s)${color.reset}`,
)
