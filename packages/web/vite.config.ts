import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 开发时前端独立起服务，API 反代到 `repolens serve`。
    // 端口得和 @repolens/server 的 DEFAULT_PORT 对上；web 不依赖 server，
    // 没法 import 那个常量，所以这里只能写死，改端口时两处一起改。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7173",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: "es",
  },
});
