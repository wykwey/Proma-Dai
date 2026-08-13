/**
 * 自动更新核心模块（已停用）
 *
 * Proma 当前不再内置自动更新逻辑；保留空实现以避免旧代码路径导入时报错。
 */

import { BrowserWindow } from 'electron'
import type { UpdateStatus } from './updater-types'

/** 当前更新状态（始终空闲） */
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用（保留签名兼容旧调用） */
let win: BrowserWindow | null = null

/** 绑定更新器所需的主窗口与 Agent 状态。 */
export function configureUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

/** 手动触发检查更新：已禁用，始终保持空闲状态。 */
export async function checkForUpdates(): Promise<void> {
  currentStatus = { status: 'idle' }
  void win
}

/** 在空闲时安装：已禁用。 */
export function installWhenIdle(): boolean {
  return false
}

/** 取消空闲安装：已禁用。 */
export function cancelIdleInstall(): void {
  // no-op
}

/** 清理更新器资源：已禁用。 */
export function cleanupUpdater(): void {
  // no-op
}

/** 初始化自动更新：已禁用。 */
export function initAutoUpdater(_mainWindow: BrowserWindow): void {
  console.log('[更新] 自动更新已停用')
}
