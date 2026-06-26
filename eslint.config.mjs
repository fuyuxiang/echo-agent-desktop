import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

/**
 * ESLint 扁平配置
 * - TypeScript 推荐规则 + React Hooks 规则
 * - 与 Prettier 协作(关闭格式类规则,格式交给 Prettier)
 */
export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', 'release', '**/*.d.ts'] },
  js.configs.recommended,
  {
    // Node 环境脚本(plop/图标生成等)
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        URL: 'readonly'
      }
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 仅渲染层组件需要,生成器模板默认符合
      'react-refresh/only-export-components': 'off',
      // 允许显式 any 时给出警告而非报错(基建层偶尔需要)
      '@typescript-eslint/no-explicit-any': 'warn',
      // 允许下划线开头的未使用变量(占位参数)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  prettier
)
