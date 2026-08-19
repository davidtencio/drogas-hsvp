import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Si falta el .env, cada placeholder se sustituia por '' y el build publicaba un
// index.html sin configuracion: initializeApp reventaba y la app quedaba en
// blanco, sin error visible en el build. Preferimos abortar aqui.
const htmlPlugin = (env) => {
  return {
    name: 'html-transform',
    transformIndexHtml: (html) => {
      const missing = []
      const result = html.replace(/__VITE_FIREBASE_([A-Z_]+)__/g, (match, p1) => {
        const key = `VITE_FIREBASE_${p1}`
        if (!env[key]) missing.push(key)
        return env[key] || ''
      })
      if (missing.length > 0) {
        throw new Error(
          `Faltan variables de Firebase: ${missing.join(', ')}. ` +
            'Sin ellas la app se publica sin configuracion y queda en blanco. ' +
            'Copie .env.example a .env y complete los valores.',
        )
      }
      return result
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react(), tailwindcss(), htmlPlugin(env)],
  }
})
