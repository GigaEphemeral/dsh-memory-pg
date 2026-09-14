import { defineConfig } from 'tsdown'

/** Module-table externals the web shell shares (official PLATFORM_MODULES list subset we use). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig([
  // Host half：lib/index.js（ESM node Cordis 插件入口）。类型由 tsc 产出。
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    clean: false,
    dts: false,
    // @deepseek-ai 与 pg 由 profile 闭包提供，不打进 bundle。
    deps: { neverBundle: [/^@deepseek-ai\//, /^pg$/] },
  },
  // Client half：lib/client.js（浏览器 CJS，经 __ModuleLoader__.load 注册）。
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    // 模块表条目走 external（react / slots）；其余依赖内联进 bundle。
    deps: { neverBundle: [/^react(\/|$)/, /^@deepseek-ai\//] },
    noExternal: (id: string) => (/^react(\/|$)/.test(id) || id.startsWith('@deepseek-ai/') ? undefined : true),
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@GigaEphemeral/dsh-memory-pg", factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
])
