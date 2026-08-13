/**
 * 自动更新状态原子
 *
 * 管理应用更新状态，订阅主进程推送的更新事件。
 * 优雅降级：如果 window.electronAPI.updater 不存在（开源构建），状态保持 idle。
 */

import { atom } from 'jotai'

/** 下载进度 */
export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 更新状态 */
export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  version?: string
  releaseNotes?: string
  progress?: DownloadProgress
  error?: string
}

/** 更新状态 atom（已停用，保留兼容占位） */
export const updateStatusAtom = atom<UpdateStatus>({ status: 'idle' })

/** 是否有可用更新（已停用） */
export const hasUpdateAtom = atom(() => false)

/** updater 是否可用（已停用） */
export const updaterAvailableAtom = atom<boolean>(() => false)

/** 初始化更新状态订阅：已停用。 */
export function initializeUpdater(
  _setStatus: (status: UpdateStatus) => void,
): () => void {
  return () => {}
}

/** 手动检查更新：已停用。 */
export async function checkForUpdates(): Promise<void> {
  return
}
