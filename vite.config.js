import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const htmlPlugin = (env) => {
  return {
    name: 'html-transform',
    transformIndexHtml: (html) => {
      return html.replace(/__VITE_FIREBASE_([A-Z_]+)__/g, (match, p1) => {
        return env[`VITE_FIREBASE_${p1}`] || ''
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), htmlPlugin(env)],
  }
})
