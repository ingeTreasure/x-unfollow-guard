# 参与开发

欢迎通过 Issue 报告问题，或提交 Pull Request。请在问题描述中提供扩展版本、Chrome 版本、所在页面及复现步骤；请勿粘贴 OpenAPI Key、浏览器凭证或私人账号名单。

## 本地开发

1. 克隆仓库，在 `chrome://extensions` 打开开发者模式并加载仓库根目录。
2. 修改代码后重新加载扩展，再刷新 X 标签页。
3. 使用 Node.js 22 或更高版本运行 `npm test` 和 `npm run check`。运行时不依赖 npm 包，无需安装依赖即可执行这两个命令。
4. 界面隔离预览：`python3 tests/preview.py`，打开 `http://127.0.0.1:8766/preview`。
5. 生成安装包：`python3 scripts/package.py`。测试、设计稿和开发配置不会进入安装包。

`tests/chrome-mock.js` 只用于隔离预览，不可引入扩展生产入口。改动 `content/pacing.js` 时，请保留有限等待、可停止、列表向前推进和保护名单校验等约束。

图标源文件为 `icons/logo.svg`。需要重新导出 PNG 时，先安装开发工具 `npm install --no-save sharp`，再运行 `node scripts/build-icons.cjs`。

## 原生弹窗排版回归

可选浏览器检查使用 Playwright 1.62.1：先运行 `npm install --ignore-scripts` 和 `npx playwright install chromium`，再运行 `npm run test:popup`。核心 `npm test` 与 `npm run check` 仍无需安装依赖。

该检查在隔离临时浏览器配置中打开真正的工具栏弹窗，检查尺寸、内容滚动、固定页签/底栏、历史分页与确认框；较小视口在扩展标签页中补测。它不读取用户 Chrome 配置，不访问真实 X 账号或向 Binance 发帖。默认使用带界面的 Chromium；支持新无头模式的环境可设置 `EXTENSION_HEADLESS=1`。

## 验证边界

单元测试不等同于真实 X 页面或 Binance 实发验收。请明确说明实际完成的验证，不要在他人账号上执行自动取关或发布内容，不要把随机等待描述成能保证避免平台限制。

贡献代码按仓库的 MIT 许可证分发。
