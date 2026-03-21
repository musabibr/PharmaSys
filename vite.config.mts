import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer-react'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    target: 'chrome120',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-tabs', '@radix-ui/react-popover', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tooltip', '@radix-ui/react-switch', '@radix-ui/react-scroll-area'],
          'vendor-charts': ['recharts'],
          'vendor-i18n': ['i18next', 'react-i18next'],
          'vendor-pdf': ['pdfjs-dist'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer-react'),
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
