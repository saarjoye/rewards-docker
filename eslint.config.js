import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typeCheckedConfigs = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.{ts,tsx}']
}))

export default defineConfig(
  globalIgnores(['dist/**', 'coverage/**', 'data/**', 'sessions/**', 'logs/**', 'backups/**']),
  eslint.configs.recommended,
  ...typeCheckedConfigs,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
)
