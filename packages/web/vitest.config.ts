// 不复用 vite.config.ts：那里的 React / Tailwind 插件是给 Vite 8 的，
// 而这里的测试只验证纯函数，不需要任何插件。
export default {
  test: {
    include: ["src/**/*.test.ts"],
    // CI 上把失败用例写成 check 注释，不登录也能看到是哪条挂了
    reporters: process.env["GITHUB_ACTIONS"] ? ["default", "github-actions"] : ["default"],
  },
};
