import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
    plugins: [vue()],
    // Set base to repo name for GitHub Pages deployment
    // When running locally (npm run dev), VITE_BASE_URL is not set → '/'
    base: process.env.VITE_BASE_URL ?? '/',
})
