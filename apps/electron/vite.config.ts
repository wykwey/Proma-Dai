import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  worker: {
    // 渲染进程的 shiki worker 用 `new Worker(new URL(...), { type: 'module' })` 创建，
    // 且内部通过动态 import 按需加载语言包（会产生多个 chunk）。
    // Vite 默认的 iife 格式不支持 code-splitting，必须用 ES module 格式。
    format: 'es',

    // ⚠️ 已知并已接受的代价（2026-09-29 决策）：
    // 主入口（经 @pierre/diffs 静态依赖）和 shiki worker 分属两个独立的 Rollup build，
    // 不共享 chunk，因此 shiki 的语言包会被复制一份 —— dist/renderer/assets 约多出
    // 297 组重名语言 chunk、重复量约 12.9MB。
    //
    // 这些都是懒加载分片（不影响启动与首屏），换来的收益是「代码块支持任意语言高亮，
    // 且 tokenize 不再占用渲染主线程」。
    //
    // 不要为了让体积下降而删掉 worker 里的 bundledLanguages 引用（那样只剩预加载的 18 种
    // 语言，冷门语言代码块会退化成纯文本），除非产品明确接受这个功能回退。
    // 若将来确实要优化，正确方向是让 @pierre/diffs 也走 worker 通道，而不是砍语言支持。
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // Chromium can resolve localhost to IPv4 while Vite binds only ::1 on macOS.
    // Use the same explicit IPv4 loopback address as Electron's dev windows.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
  },
})
