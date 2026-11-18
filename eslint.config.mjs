import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  ...tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended,files:['apps/web/**/*.{ts,tsx}'] },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }
);
