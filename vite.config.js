import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const isGithubActions = process.env.GITHUB_ACTIONS === 'true'
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] || ''

// https://vite.dev/config/
export default defineConfig({
  base: isGithubActions && repoName ? `/${repoName}/` : '/',
  plugins: [react()],
})
