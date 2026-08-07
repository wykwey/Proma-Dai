/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_THEME_MODE } from '../../types'
import type { AppSettings } from '../../types'

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      builtinMcpDisabledIds: [],
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const settings = JSON.parse(raw) as Partial<AppSettings>
    return {
      ...settings,
      themeMode: settings.themeMode || DEFAULT_THEME_MODE,
      onboardingCompleted: settings.onboardingCompleted ?? false,
      environmentCheckSkipped: settings.environmentCheckSkipped ?? false,
      notificationsEnabled: settings.notificationsEnabled ?? true,
      longTextPasteAsAttachmentEnabled: settings.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: settings.richTextRenderingEnabled ?? false,
      builtinMcpDisabledIds: settings.builtinMcpDisabledIds ?? [],
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      builtinMcpDisabledIds: [],
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
    }
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = {
    ...current,
    ...updates,
  }
  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
