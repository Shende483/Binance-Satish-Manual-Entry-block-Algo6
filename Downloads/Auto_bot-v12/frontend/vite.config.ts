

// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
    plugins: [
      react({
        babel: {
          compact: false // Disable compact mode to avoid deoptimization warning
        }
      }),
      visualizer({
        filename: './dist/stats.html',
        open: true, // Opens bundle visualization after build
        gzipSize: true, // Show gzipped sizes
      }),
    ],
    server: {
      host:`${env.VITE_HOST}`,
      port: parseInt(env.VITE_PORT),
      proxy: {
        '/api': {
          target: env.VITE_API_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      },
      cors: {
        origin: env.VITE_FRONTEND_URL
      }
    },
    build: {
      minify: 'esbuild', // Use esbuild for better minification
      sourcemap: mode === 'production' ? false : true, // Disable sourcemaps in production
      chunkSizeWarningLimit: 2000, // Increase to suppress warning temporarily
    },
  };
});
