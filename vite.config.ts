import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "src/manifest.json",
      watchFilePaths: ["src/**/*.ts", "src/**/*.html", "src/**/*.css"],
      disableAutoLaunch: true, // Disable auto-launch to prevent runner.exit() errors
      skipManifestValidation: true,
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
    minify: true, // Enable minification for smaller bundles
    rollupOptions: {
      output: {
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    hmr: {
      port: 5174,
    },
  },
  optimizeDeps: {
    exclude: ["firebase"],
  },
});
