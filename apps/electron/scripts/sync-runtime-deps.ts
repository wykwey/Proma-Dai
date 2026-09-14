#!/usr/bin/env bun
/**
 * 同步 Electron 打包时需要保留为 external 的主进程运行时依赖。
 *
 * Bun workspace 会把依赖 hoist 到仓库根 node_modules；electron-builder 的 files
 * 规则以 apps/electron 为 appDir，因此打包前需要把 external 依赖闭包复制到
 * apps/electron/node_modules，保证 packaged app 中 Node 模块解析可用。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** 平台约束字段，语义与 npm 一致：数组为白名单，'!' 前缀项为黑名单。 */
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

export type TargetLibc = 'glibc' | 'musl'

/** 目标平台：交叉打包时用于剔除不属于该平台的原生依赖；默认取宿主平台。 */
export interface TargetPlatform {
  platform: string
  arch: string
  libc: TargetLibc
}

interface RuntimeDependency {
  name: string
  optional: boolean
}

interface SyncContext {
  sourceNodeModules: string
  targetNodeModules: string
  copiedPackages: Map<string, string>
  topLevelPackageSources: Map<string, string>
  skippedOptionalPackages: string[]
  /** 因 os/cpu/libc 与目标平台不符而跳过的包（如 Debian 上永远用不到的 musl Skia）。 */
  skippedPlatformPackages: string[]
  target: TargetPlatform
}

export interface SyncRuntimeDepsOptions {
  sourceNodeModules?: string
  targetNodeModules?: string
  externalRuntimePackages?: readonly string[]
  /** 是否在同步前清空目标 node_modules；打包需要 true，开发启动使用 false 避免破坏本地调试内容。 */
  cleanTarget?: boolean
  /** 目标平台，缺省取宿主平台。 */
  target?: Partial<TargetPlatform>
}

export interface SyncRuntimeDepsResult {
  copiedPackageCount: number
  copiedPackages: string[]
  skippedOptionalPackages: string[]
  skippedPlatformPackages: string[]
}

export const EXTERNAL_RUNTIME_PACKAGES: readonly string[] = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'pdfjs-dist',
]

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')
const bunVirtualNodeModules = join(repoNodeModules, '.bun', 'node_modules')
const defaultSourceNodeModules = existsSync(bunVirtualNodeModules) ? bunVirtualNodeModules : repoNodeModules
const defaultTargetNodeModules = join(appDir, 'node_modules')

// ============================================
// 目标平台解析与过滤
// ============================================

/** 检测宿主 libc：libc 字段只对 linux 有意义，非 linux 一律按 glibc 处理。 */
function detectHostLibc(): TargetLibc {
  if (process.platform !== 'linux') return 'glibc'
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
  } catch {
    return 'glibc'
  }
}

export function resolveTargetPlatform(override: Partial<TargetPlatform> = {}): TargetPlatform {
  const platform = override.platform ?? process.platform
  return {
    platform,
    arch: override.arch ?? process.arch,
    libc: override.libc ?? (platform === 'linux' ? detectHostLibc() : 'glibc'),
  }
}

/** 按 npm 语义判定单个约束字段：黑名单优先，无白名单项时视为放行。 */
function matchesConstraint(values: readonly string[], actual: string): boolean {
  if (values.length === 0) return true
  const allowed = values.filter((value) => !value.startsWith('!'))
  const denied = values.filter((value) => value.startsWith('!')).map((value) => value.slice(1))
  if (denied.includes(actual)) return false
  if (allowed.length === 0) return true
  return allowed.includes(actual)
}

/**
 * 判断依赖包是否适配目标平台。
 *
 * @napi-rs/canvas、@mariozechner/clipboard 这类包会把所有平台的二进制挂在
 * optionalDependencies 上（含 musl / darwin / win32 变体），不过滤就会把
 * 用不到的原生库一并打进安装包：linux-x64 包里同时存在 gnu 与 musl 两份
 * Skia（33MB + 30MB），xz 压缩后仍然白占 ~18MB。
 */
export function matchesTargetPlatform(manifest: PackageManifest, target: TargetPlatform): boolean {
  if (!matchesConstraint(manifest.os ?? [], target.platform)) return false
  if (!matchesConstraint(manifest.cpu ?? [], target.arch)) return false
  if (!matchesConstraint(manifest.libc ?? [], target.libc)) return false
  return true
}

/**
 * 交叉架构打包护栏。
 *
 * 宿主与目标架构不一致时，源码树里的原生依赖必然是宿主架构，硬打包会产出
 * 「杂交包」：Electron 本体（electron-builder 会下载对应架构）是目标架构，
 * 但原生 addon 仍是宿主架构。v0.16.11 的 linux-arm64 包就是这样：里面的
 * canvas Skia 与 CLI 二进制 sha1 与 amd64 包逐字节相同，既白占 ~17MB，
 * 运行时也根本加载不了。正确做法是在同架构机器（CI 的 linux-arm64 job）上打包。
 */
function warnIfCrossArch(target: TargetPlatform, strict: boolean): void {
  if (target.platform === process.platform && target.arch === process.arch) return
  const detail =
    `目标 ${target.platform}-${target.arch} 与宿主 ${process.platform}-${process.arch} 不一致，` +
    '原生依赖只能取自宿主 node_modules，产物会是「杂交包」（参见本文件 warnIfCrossArch 注释）'
  if (strict) {
    throw new Error(`[runtime-deps] 拒绝交叉架构打包：${detail}`)
  }
  console.warn(`[runtime-deps] ⚠ ${detail}；如确需交叉打包请显式传 --arch，并在同架构机器上重打包`)
}

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/')
    const scope = parts[0]
    const name = parts[1]
    if (!scope || !name) throw new Error(`非法 scoped package 名称: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function resolvePackageFromNodeModules(nodeModulesDir: string, packageName: string): string | undefined {
  const packageDir = getPackageDir(nodeModulesDir, packageName)
  if (existsSync(join(packageDir, 'package.json'))) {
    return realpathSync(packageDir)
  }
  return undefined
}

function resolvePackageUpwards(startDir: string, packageName: string): string | undefined {
  let currentDir = resolve(startDir)

  while (true) {
    const resolvedPackageDir = resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName)
    if (resolvedPackageDir) return resolvedPackageDir

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

function resolvePackageSourceDir(ctx: SyncContext, packageName: string, resolveFromDir?: string): string | undefined {
  if (resolveFromDir) {
    const parentResolvedDir = resolvePackageUpwards(resolveFromDir, packageName)
    if (parentResolvedDir) return parentResolvedDir
  }

  for (const nodeModulesDir of [ctx.sourceNodeModules, bunVirtualNodeModules, repoNodeModules]) {
    const resolvedPackageDir = resolvePackageFromNodeModules(nodeModulesDir, packageName)
    if (resolvedPackageDir) return resolvedPackageDir
  }

  return undefined
}

function readPackageManifest(sourceDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as PackageManifest
}

function listRuntimeDependencies(manifest: PackageManifest): RuntimeDependency[] {
  const dependencies = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false }))
  const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true }))
  return [...dependencies, ...optionalDependencies]
}

function copyPackage(
  ctx: SyncContext,
  packageName: string,
  optional = false,
  resolveFromDir?: string,
  targetNodeModules = ctx.targetNodeModules,
  sourceAncestors = new Set<string>(),
): void {
  const sourceDir = resolvePackageSourceDir(ctx, packageName, resolveFromDir)
  if (!sourceDir) {
    if (optional) {
      ctx.skippedOptionalPackages.push(packageName)
      return
    }
    throw new Error(`缺少运行时依赖: ${packageName} (${getPackageDir(ctx.sourceNodeModules, packageName)})`)
  }
  const manifest = readPackageManifest(sourceDir)

  // 平台过滤：只保留与目标平台匹配的原生依赖变体
  if (!matchesTargetPlatform(manifest, ctx.target)) {
    ctx.skippedPlatformPackages.push(packageName)
    return
  }

  const isTopLevel = targetNodeModules === ctx.targetNodeModules

  const targetDir = getPackageDir(targetNodeModules, packageName)
  const targetKey = resolve(targetDir)
  const existingSourceDir = ctx.copiedPackages.get(targetKey)
  if (existingSourceDir) {
    if (existingSourceDir === sourceDir) return
    throw new Error(`运行时依赖版本冲突: ${packageName} 已复制自 ${existingSourceDir}，又解析到 ${sourceDir}`)
  }

  ctx.copiedPackages.set(targetKey, sourceDir)
  if (isTopLevel) ctx.topLevelPackageSources.set(packageName, sourceDir)

  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
  })

  const nextAncestors = new Set(sourceAncestors)
  nextAncestors.add(sourceDir)
  for (const dependency of listRuntimeDependencies(manifest)) {
    copyDependency(ctx, dependency, sourceDir, targetDir, nextAncestors)
  }
}

function copyDependency(
  ctx: SyncContext,
  dependency: RuntimeDependency,
  parentSourceDir: string,
  parentTargetDir: string,
  sourceAncestors: Set<string>,
): void {
  const sourceDir = resolvePackageSourceDir(ctx, dependency.name, parentSourceDir)
  if (!sourceDir) {
    if (dependency.optional) {
      ctx.skippedOptionalPackages.push(dependency.name)
      return
    }
    throw new Error(`缺少运行时依赖: ${dependency.name} (${parentSourceDir})`)
  }

  if (sourceAncestors.has(sourceDir)) return

  const topLevelSourceDir = ctx.topLevelPackageSources.get(dependency.name)
  if (!topLevelSourceDir || topLevelSourceDir === sourceDir) {
    copyPackage(ctx, dependency.name, dependency.optional, parentSourceDir, ctx.targetNodeModules, sourceAncestors)
    return
  }

  copyPackage(
    ctx,
    dependency.name,
    dependency.optional,
    parentSourceDir,
    join(parentTargetDir, 'node_modules'),
    sourceAncestors,
  )
}

function assertNoAbsoluteSymlinks(dir: string): void {
  if (!existsSync(dir)) return
  const stack = [dir]
  const offenders: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        if (target.startsWith('/')) offenders.push(fullPath)
        continue
      }
      if (stat.isDirectory()) stack.push(fullPath)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`检测到绝对 symlink，会导致打包后模块解析失效: ${offenders.slice(0, 10).join(', ')}`)
  }
}

function prepareTargetNodeModules(sourceNodeModules: string, targetNodeModules: string): void {
  const source = resolve(sourceNodeModules)
  const target = resolve(targetNodeModules)
  if (source === target) {
    throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免误删源依赖')
  }
  if (basename(target) !== 'node_modules') {
    throw new Error(`拒绝清理非 node_modules 目录: ${target}`)
  }

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
}

export function syncRuntimeDeps(options: SyncRuntimeDepsOptions = {}): SyncRuntimeDepsResult {
  const ctx: SyncContext = {
    sourceNodeModules: options.sourceNodeModules ?? defaultSourceNodeModules,
    targetNodeModules: options.targetNodeModules ?? defaultTargetNodeModules,
    copiedPackages: new Map<string, string>(),
    topLevelPackageSources: new Map<string, string>(),
    skippedOptionalPackages: [],
    skippedPlatformPackages: [],
    target: resolveTargetPlatform(options.target),
  }
  const externalRuntimePackages = options.externalRuntimePackages ?? EXTERNAL_RUNTIME_PACKAGES

  if (options.cleanTarget ?? true) {
    prepareTargetNodeModules(ctx.sourceNodeModules, ctx.targetNodeModules)
  } else {
    const source = resolve(ctx.sourceNodeModules)
    const target = resolve(ctx.targetNodeModules)
    if (source === target) {
      throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免覆盖源依赖')
    }
    if (basename(target) !== 'node_modules') {
      throw new Error(`拒绝同步到非 node_modules 目录: ${target}`)
    }
    mkdirSync(target, { recursive: true })
  }

  for (const packageName of externalRuntimePackages) {
    copyPackage(ctx, packageName)
  }

  assertNoAbsoluteSymlinks(ctx.targetNodeModules)

  return {
    copiedPackageCount: ctx.copiedPackages.size,
    copiedPackages: [...ctx.copiedPackages.keys()],
    skippedOptionalPackages: [...ctx.skippedOptionalPackages],
    skippedPlatformPackages: [...ctx.skippedPlatformPackages],
  }
}

interface CliArgs {
  cleanTarget: boolean
  strictArch: boolean
  target: Partial<TargetPlatform>
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const target: Partial<TargetPlatform> = {}
  for (const arg of argv) {
    const [key, value] = arg.split('=')
    if (!value) continue
    if (key === '--platform') target.platform = value
    else if (key === '--arch') target.arch = value
    else if (key === '--libc' && (value === 'glibc' || value === 'musl')) target.libc = value
  }
  return {
    cleanTarget: !argv.includes('--no-clean'),
    strictArch: argv.includes('--strict-arch'),
    target,
  }
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2))
  const target = resolveTargetPlatform(args.target)
  warnIfCrossArch(target, args.strictArch)

  const result = syncRuntimeDeps({ cleanTarget: args.cleanTarget, target })
  const parts = [`已同步 ${result.copiedPackageCount} 个主进程运行时依赖`]
  if (result.skippedOptionalPackages.length > 0) {
    parts.push(`跳过未安装 optional 依赖 ${result.skippedOptionalPackages.length} 个`)
  }
  if (result.skippedPlatformPackages.length > 0) {
    const preview = result.skippedPlatformPackages.slice(0, 3).join(', ')
    const suffix = result.skippedPlatformPackages.length > 3 ? ' 等' : ''
    parts.push(
      `跳过不适配 ${target.platform}-${target.arch}/${target.libc} 的包 ${result.skippedPlatformPackages.length} 个（${preview}${suffix}）`,
    )
  }
  console.log(`[runtime-deps] ${parts.join('，')}`)
}

if (import.meta.main) {
  main()
}
