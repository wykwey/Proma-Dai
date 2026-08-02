/**
 * ToolSettings - 内置工具设置页
 *
 * 目前仅保留记忆工具（Chat + Agent 共用）。
 */

import * as React from 'react'
import { MemorySettings } from './MemorySettings'

export function ToolSettings(): React.ReactElement {
  return (
    <div className="space-y-8">
      <MemorySettings />
    </div>
  )
}
