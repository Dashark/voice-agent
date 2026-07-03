# 🎙️ 语音智能助手

一个基于 Web 的语音 AI Agent 应用，支持 **语音输入 → AI 响应 → 语音朗读** 的完整闭环。

## 🚀 快速开始

### 本地测试
直接用浏览器打开 `index.html`，**按住麦克风按钮 → 说话 → 松开**。

### 部署到公网（推荐，支持 HTTPS）

```bash
# 一键部署到 Vercel（需要 Node.js）
npx vercel --yes
```

## ✨ 特性

- **语音识别**: Web Speech API（默认）/ 小米 MiMo ASR（可选）
- **AI 响应**: OpenAI 兼容 API（支持 GPT、DeepSeek、通义千问等）
- **语音朗读**: 浏览器原生 TTS，自动中文语音
- **PWA 支持**: 可添加到手机主屏幕，全屏运行
- **暗色主题**: 移动端优化 UI

## 📁 项目结构

```
voice-agent/
├── index.html      # 主页面
├── style.css       # 样式
├── app.js          # 核心逻辑（状态机 + ASR + LLM + TTS）
├── manifest.json   # PWA 配置
├── DESIGN.md       # 完整设计文档（含部署和测试方案）
└── README.md       # 本文件
```

## ⚙️ 配置

点击右上角 ⚙️ 图标，可配置：
- **ASR 提供商**: Web Speech / 小米 MiMo
- **LLM**: API 地址、Key、模型
- **TTS**: 朗读引擎

## 📖 详细文档

完整的设计方案、部署步骤、测试方法见 [DESIGN.md](DESIGN.md)。
