export default {
  test: {
    include: ["src/**/*.test.ts"],
    // CI 上把失败用例写成 check 注释，不登录也能看到是哪条挂了
    reporters: process.env["GITHUB_ACTIONS"] ? ["default", "github-actions"] : ["default"],
  },
};
