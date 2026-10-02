import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'static',
    emptyOutDir: false,
    cssCodeSplit: false,
    cssFileName: 'univer-preview',
    target: 'es2020',
    lib: {
      entry: 'frontend/univer-preview.js',
      name: 'UniverPreview',
      formats: ['iife'],
      fileName: () => 'univer-preview.js',
      cssFileName: 'univer-preview',
    },
  },
});
