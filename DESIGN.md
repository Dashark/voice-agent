# 语音智能助手 - 设计文档

> 版本: v1.1 | 更新: 2026-07-03

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [技术选型](#3-技术选型)
4. [状态机设计](#4-状态机设计)
5. [模块设计](#5-模块设计)
6. [部署方案](#6-部署方案)
7. [测试方案](#7-测试方案)
8. [项目结构](#8-项目结构)

---

## 1. 项目概述

### 1.1 需求描述

构建一个在手机上运行的基于 Web 的语音 Agent 应用，实现以下闭环交互：

1. 用户按住麦克风说话
2. 松开后显示用户语音转写的文字
3. 调用 LLM 获取 AI 响应
4. 显示 AI 响应文字
5. 自动语音朗读 AI 响应文字

### 1.2 典型用例

> **用户提问**: "有个自然数，如果它加上1就能被5整除；如果它加上3就能被2整除；如果它加上5就能被3整除，这个自然数最小多少？"
>
> **AI 响应**: "19"
>
> **语音朗读**: 自动读出 "19"

### 1.3 设计目标

| 目标 | 说明 |
|------|------|
| 🚀 零部署可用 | 浏览器打开即用，无需安装 App |
| 📱 移动优先 | 触摸交互优化，PWA 支持添加到桌面 |
| 🔌 模块可替换 | ASR/LLM/TTS 各模块可独立切换 |
| 🌐 离线友好 | 核心 UI 无需网络，仅 ASR/LLM 依赖网络 |

---

## 2. 系统架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        浏览器 (Browser)                              │
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │   UI 层      │    │  状态管理层  │    │  音频层     │             │
│  │  (HTML+CSS)  │◄──▶│ (StateMachine)│◄──▶│ (Audio I/O) │             │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘             │
│         │                  │                   │                    │
│         ▼                  ▼                   ▼                    │
│  ┌─────────────────────────────────────────────────────┐           │
│  │              服务层 (Service Layer)                  │           │
│  │                                                     │           │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │           │
│  │  │  ASR 引擎     │  │  LLM 引擎    │  │  TTS 引擎  │ │           │
│  │  │  ┌────────┐  │  │  ┌────────┐  │  │  ┌──────┐  │ │           │
│  │  │  │WebSpeech│  │  │  │OpenAI  │  │  │  │Web   │  │ │           │
│  │  │  │  ASR    │  │  │  │兼容API │  │  │  │Speech │  │ │           │
│  │  │  ├────────┤  │  │  └────────┘  │  │  │  TTS  │  │ │           │
│  │  │  │  MiMo   │  │  │             │  │  └──────┘  │ │           │
│  │  │  │  ASR    │  │  │             │  │             │ │           │
│  │  │  └────────┘  │  │             │  │             │ │           │
│  │  └──────────────┘  └──────────────┘  └────────────┘ │           │
│  └─────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
          │                      │                      │
          ▼                      ▼                      ▼
    WebSocket/WSS           HTTPS REST            Web Speech API
    (MiMo ASR)              (LLM API)             (浏览器本地)
```

### 2.2 数据流

```
用户按下麦克风
    │
    ▼
┌──────────────────────────────────────────────────┐
│  阶段 1: 语音识别 (ASR)                          │
│                                                  │
│  Web Speech ASR:                                 │
│    麦克风 → 浏览器 SpeechRecognition → 文字      │
│                                                  │
│  小米 MiMo ASR:                                  │
│    麦克风 → MediaRecorder → WebSocket → 文字     │
└──────────────────────┬───────────────────────────┘
                       │ 显示"你说的话"
                       ▼
┌──────────────────────────────────────────────────┐
│  阶段 2: AI 处理 (LLM)                           │
│                                                  │
│  文字 → HTTP POST → OpenAI 兼容 API → 响应文字   │
│                                                  │
│  请求格式:                                       │
│  {                                               │
│    "model": "gpt-4o-mini",                      │
│    "messages": [                                 │
│      {"role": "system", "content": "..."},       │
│      {"role": "user", "content": "问题"}         │
│    ]                                             │
│  }                                               │
└──────────────────────┬───────────────────────────┘
                       │ 显示"AI回复"
                       ▼
┌──────────────────────────────────────────────────┐
│  阶段 3: 语音合成 (TTS)                          │
│                                                  │
│  Web Speech TTS:                                 │
│    SpeechSynthesisUtterance → 扬声器播放          │
│    → 自动选择中文语音                            │
└──────────────────────┬───────────────────────────┘
                       │ 播放完成
                       ▼
                    回到空闲状态
```

---

## 3. 技术选型

### 3.1 技术栈

| 层次 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 前端框架 | 原生 HTML/CSS/JS | ES2020 | 无依赖，零构建 |
| UI 样式 | CSS Custom Properties | CSS3 | 暗色主题，响应式，毛玻璃效果 |
| PWA | Web App Manifest | W3C | 可添加到主屏幕 |
| 语音识别 | Web Speech API / MiMo ASR | W3C / v1 | 可切换（默认 Web Speech） |
| 语言模型 | **小米 MiMo v2.5-pro** (默认) / OpenAI 兼容 API | - | 默认 `mimo-v2.5-pro` |
| 语音合成 | **MiMo TTS** (推荐) / Web Speech API | - | 默认 Web Speech，可选 MiMo TTS |
| 认证方式 | `api-key` 头 / `Authorization: Bearer` | - | 自动适配 MiMo (`sk-`/`tp-`) 和 OpenAI |
| 请求超时 | AbortController | - | LLM 30s / TTS 15s |
| 通信协议 | HTTPS REST / WebSocket WSS | - | LLM / MiMo ASR |

### 3.2 为什么不用框架？

| 考量 | 结论 |
|------|------|
| 移动端加载速度 | 原生 JS 零构建，首屏即用 |
| 包体积 | 无 node_modules，< 20KB 总大小 |
| 部署复杂度 | 无需构建工具链，静态文件直传 |
| 功能需求 | 单页应用，无需路由/状态管理库 |

---

## 4. 状态机设计

### 4.1 状态定义

```
                    ┌────────────────────────────┐
                    │         IDLE               │
                    │    (准备就绪/空闲)           │
                    └───────────┬────────────────┘
                                │ 用户按下麦克风
                                ▼
                    ┌────────────────────────────┐
              ┌────▶│       LISTENING            │
              │     │    (聆听中/录音中)           │
              │     └───────────┬────────────────┘
              │                 │ 用户松开麦克风
              │                 ▼
              │     ┌────────────────────────────┐
              │     │       PROCESSING           │
              │     │    (思考中/LLM调用中)        │
              │     └───────────┬────────────────┘
              │                 │ LLM 返回结果
              │                 ▼
              │     ┌────────────────────────────┐
              │     │        SPEAKING            │
              │     │    (播放中/TTS朗读中)        │
              │     └───────────┬────────────────┘
              │                 │ TTS 播放完成
              └─────────────────┘
```

### 4.2 状态表

| 状态 | UI 表现 | 按钮状态 | 可用操作 | 错误处理 |
|------|---------|----------|----------|----------|
| `idle` | 灰色指示灯，显示"准备就绪" | 正常 | 按下开始录音 | - |
| `listening` | 红色脉冲指示灯，显示"聆听中…"，波形动画 | 红色脉冲，显示"松开结束" | 松开结束录音 | ASR 错误 → 回到 idle，提示错误 |
| `processing` | 黄色脉冲指示灯，显示"思考中…"，打字动画 | 禁用 | 等待完成 | API 错误 → 回到 idle，提示错误 |
| `speaking` | 绿色脉冲指示灯，显示"播放中…" | 禁用（可中断） | 点击可中断播放 | TTS 错误 → 回到 idle |

### 4.3 状态转换代码

```javascript
// app.js: State 常量
const State = {
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
};

// setState() 统一管理所有 UI 变更
function setState(newState) {
  state = newState;
  dom.statusDot.className = 'status-dot ' + newState;
  dom.statusText.textContent = statusMap[newState];
  dom.micBtn.classList.toggle('recording', newState === State.LISTENING);
  dom.micLabel.textContent = newState === State.LISTENING ? '松开结束' : '点击说话';
}
```

---

## 5. 模块设计

### 5.1 ASR 模块（语音识别）

#### 5.1.1 Web Speech API（默认）

| 属性 | 值 |
|------|-----|
| 引擎 | 浏览器内置（Chrome/Safari/Edge） |
| 语言 | `zh-CN` |
| 模式 | `continuous: true` + `interimResults: true` |
| 重连 | `onend` 自动重启，保持持续监听 |
| 优缺点 | ✅ 无需配置，零成本；❌ 仅在 HTTPS 或 localhost 下工作 |

**关键实现** (`app.js:444-513`):
```javascript
class WebSpeechASR {
  start() {
    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    // onresult → 实时显示中间结果
    // onend → 自动重启保持连续
  }
}
```

#### 5.1.2 小米 MiMo ASR（可选）

| 属性 | 值 |
|------|-----|
| 协议 | WebSocket (WSS) |
| 端点 | `wss://asr.mimo.mi.com/v1/asr` |
| 认证 | `app_id` + `token` 查询参数 |
| 音频格式 | WebM Opus (MediaRecorder 默认) |
| 传输 | 每 100ms 发送音频块，结束时发送 `{"type":"end"}` |

**MiMo 文档参考**: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition

**关键实现** (`app.js:396-440`):
```javascript
class MiMoASR {
  async start() {
    const wsUrl = `wss://asr.mimo.mi.com/v1/asr?app_id=${this.appId}&token=${this.token}`;
    this.ws = new WebSocket(wsUrl);
    // onmessage → 解析 JSON 获取识别结果
    // startRecording → MediaRecorder 流式发送音频
  }
}
```

### 5.2 LLM 模块（AI 响应）

| 属性 | 值 |
|------|-----|
| 协议 | HTTPS REST |
| 端点 | 可配置，**默认 `https://api.xiaomimimo.com/v1/chat/completions`** |
| 认证 | `api-key` 头（MiMo 推荐）或 `Authorization: Bearer`（自动适配） |
| 模型 | 可配置，**默认 `mimo-v2.5-pro`**（支持 1M 上下文、深度思考、函数调用） |
| 超时 | 30 秒（AbortController） |
| 上下文 | 保留最近 10 轮对话 |
| 错误恢复 | API 失败时自动回滚对话历史 |

**兼容的 API 提供商**:
| 提供商 | 示例端点 | 示例模型 |
|--------|---------|---------|
| **小米 MiMo（默认）** | `https://api.xiaomimimo.com/v1` | **`mimo-v2.5-pro`** |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://手机IP:11434/v1` | `llama3` |

**认证方式自动适配逻辑**:
```javascript
// app.js - 自动检测 Key 类型
const key = config.llmApiKey.trim();
if (key.startsWith('sk-') || key.startsWith('tp-')) {
  headers['api-key'] = key;       // MiMo 风格
} else {
  headers['Authorization'] = `Bearer ${key}`;  // OpenAI 风格
}
```

**关键实现** (`app.js:348-393`):
```javascript
async function callLLM(userText) {
  const response = await fetch(config.llmEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-10),
        { role: 'user', content: userText },
      ],
    }),
  });
  const reply = data.choices[0].message.content;
  // 显示回复 + 语音朗读
}
```

### 5.3 TTS 模块（语音合成）

| 属性 | 值 |
|------|-----|
| 默认引擎 | Web Speech Synthesis API |
| 可选引擎 | **小米 MiMo TTS** (`mimo-v2.5-tts`) — 更自然的中文语音 |
| 语言 | `zh-CN` |
| 回退策略 | MiMo TTS 失败时自动降级到 Web Speech |
| 语音选择 | Web Speech: 自动选择第一个中文语音 |
| | MiMo TTS: 内置高品质音色（如 Aria、Chloe、Roger） |

#### MiMo TTS 调用方式

MiMo TTS 也是 OpenAI 兼容 API，请求格式：

```bash
POST https://api.xiaomimimo.com/v1/chat/completions
api-key: sk-xxxxx
Content-Type: application/json

{
  "model": "mimo-v2.5-tts",
  "messages": [
    {"role": "user", "content": "请用自然的中文语音朗读"},
    {"role": "assistant", "content": "要朗读的文字内容"}
  ],
  "audio": {
    "format": "wav",
    "voice": "Aria"
  }
}
```

响应中包含 base64 编码的 WAV 音频数据，解码后通过 `Audio` 对象播放。

**关键实现** (`app.js`):
```javascript
async function speakWithMiMo(text) {
  // 调用 MiMo TTS API
  const response = await fetch(ttsEndpoint, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [...],
      audio: { format: 'wav', voice: 'Aria' },
    }),
  });
  const data = await response.json();
  const audioData = data.choices[0].message.audio.data;
  // base64 → Blob → Audio 播放
}
```

**关键实现** (`app.js:309-345`):
```javascript
function speakText(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.0;
  const zhVoice = speechSynth.getVoices().find(v => v.lang.startsWith('zh'));
  if (zhVoice) utterance.voice = zhVoice;
  utterance.onend = () => setState(State.IDLE);
  speechSynth.speak(utterance);
}
```

### 5.4 UI/UX 设计

#### 5.4.1 交互方式

| 方式 | 平台 | 操作 |
|------|------|------|
| 长按 | 移动端 | 触摸并按住 → 说话 → 松开 |
| 点击 | 桌面端 | 按住鼠标 → 说话 → 松开 |
| 空格键 | 桌面端 | 按下空格 → 说话 → 松开空格 |
| 打断 | 通用 | 说话中点击麦克风 → 打断当前 TTS → 重新开始 |

#### 5.4.2 视觉反馈

| 元素 | 用途 |
|------|------|
| 状态指示灯 | 红/黄/绿脉冲指示当前阶段 |
| 波形动画 | 录音时的音频可视化 |
| 实时识别文字 | 说话时中间显示的半透明文字 |
| 打字动画 | AI 思考时的三点跳动 |
| 消息气泡 | 用户/AI 分角色显示对话 |
| Toast 通知 | 错误和成功提示 |

#### 5.4.3 主题设计

```css
/* 暗色主题色彩系统 */
--bg-primary: #0f0f23;     /* 主背景 - 深蓝黑 */
--bg-secondary: #1a1a3e;   /* 次要背景 */
--bg-card: #252550;        /* 卡片背景 */
--accent: #6c63ff;         /* 强调色 - 紫色 */
--recording: #ff1744;      /* 录音状态 - 红色 */
--success: #00c853;        /* 播放状态 - 绿色 */
--warning: #ffc107;        /* 处理状态 - 黄色 */
```

---

## 6. 部署方案

### 6.1 方案对比

| 方案 | 难度 | HTTPS | 公网访问 | 体验 | 推荐场景 |
|------|------|-------|----------|------|----------|
| **A. 直接浏览器打开** | ⭐ 简单 | ❌ | ❌ | ⭐⭐⭐ | 本地测试 |
| **B. Python HTTP 服务器** | ⭐ 简单 | ❌ | ❌ (局域网) | ⭐⭐⭐ | 局域网调试 |
| **C. Vercel 部署** | ⭐⭐ 中等 | ✅ | ✅ | ⭐⭐⭐⭐ | **生产推荐** |
| **D. GitHub Pages** | ⭐⭐ 中等 | ✅ | ✅ | ⭐⭐⭐⭐ | 生产备选 |
| **E. PWA Builder 打包 APK** | ⭐⭐⭐ 较复杂 | ✅ | ✅ | ⭐⭐⭐⭐⭐ | 最佳体验 |

### 6.2 方案 A：直接浏览器打开（本地测试）

**适用场景**: 快速验证功能，仅使用 Web Speech API

```bash
# 手机操作
1. 将 voice-agent/ 文件夹通过微信/QQ 发送到手机
2. 在手机文件管理器找到 index.html
3. 用 Chrome 或 Edge 打开
4. 点击"添加到主屏幕"（可选）
```

**限制**:
- `file://` 协议下部分浏览器不支持麦克风
- 不支持 MiMo ASR（需要 HTTPS）
- 建议使用 Chrome 浏览器

### 6.3 方案 B：Python HTTP 服务器（局域网）

**适用场景**: 开发调试，局域网内多设备测试

```bash
# 步骤 1：在电脑上启动服务
cd f:\code\testhu\voice-agent

# Python 3:
python -m http.server 8080

# 或 Node.js:
npx serve . -p 8080

# 步骤 2：查看电脑 IP（Windows）
ipconfig
# 找到 IPv4 地址，例如 192.168.1.100

# 步骤 3：手机访问
# 手机连同一 WiFi，浏览器打开:
http://192.168.1.100:8080
```

**验证方法**:
- 电脑和手机各打开一个页面，说话测试
- 检查浏览器控制台（Chrome DevTools）有无报错
- 手机端 Chrome 可通过 `chrome://inspect` 远程调试

### 6.4 方案 C：Vercel 部署（推荐）

**适用场景**: 生产环境，需要 HTTPS，随时可用

#### 方法一：CLI 一键部署（推荐）

```bash
# 前提：安装 Node.js (https://nodejs.org)

# 1. 安装 Vercel CLI（首次）
npm install -g vercel

# 2. 部署（在项目目录下）
cd f:\code\testhu\voice-agent
vercel --yes

# 3. 输出示例
# ✅  Ready! https://voice-agent-xxx.vercel.app
```

#### 方法二：网页拖拽部署

1. 访问 https://vercel.com/new
2. 登录（可用 GitHub 账号）
3. 将 `voice-agent/` 文件夹拖入部署区域
4. 等待部署完成，获得链接

#### 方法三：GitHub 导入

1. 在 GitHub 新建仓库，上传 `voice-agent/` 文件夹
2. 访问 https://vercel.com/new
3. 导入该 GitHub 仓库
4. 部署设置保持默认（Framework: Other）
5. 部署完成

### 6.5 方案 D：GitHub Pages

**适用场景**: 已有 GitHub 账号，代码托管

```bash
# 1. 在 GitHub 新建仓库
# 2. 上传 voice-agent 文件夹内容到仓库
# 3. 仓库 Settings → Pages
#    - Source: Deploy from a branch
#    - Branch: main, / (root)
#    - Save
# 4. 等待 1-2 分钟
# 5. 访问 https://<用户名>.github.io/<仓库名>
```

### 6.6 方案 E：PWA Builder 打包 APK

**适用场景**: 需要真·App 体验，离线安装包

```bash
# 前提：已部署到公网（方案 C 或 D）

# 步骤
1. 访问 https://pwabuilder.com
2. 输入已部署的 HTTPS 网址
3. 点击 "Generate Package"
4. 选择 Android → "Download APK"
5. 将 APK 传到手机安装
```

### 6.7 部署检查清单

| 检查项 | 说明 |
|--------|------|
| ✅ HTTPS | MiMo ASR 需要 WSS，LLM API 需要 HTTPS |
| ✅ 麦克风权限 | 浏览器首次使用会弹出权限请求，需允许 |
| ✅ iOS 注意 | Safari 需要开启"麦克风"权限设置 |
| ✅ Android Chrome | 需要在设置中允许"麦克风"权限 |
| ✅ 添加到主屏幕 | iOS: Safari 分享按钮 → 添加到主屏幕；Android: Chrome 菜单 → 添加到主屏幕 |

---

## 7. 测试方案

### 7.1 测试矩阵

| 测试项 | 测试方法 | 预期结果 | 优先级 |
|--------|----------|----------|--------|
| 麦克风权限 | 首次点击录音按钮 | 浏览器弹出权限请求 | P0 |
| 语音识别 (Web Speech) | 说"你好"后松开 | 显示"你好" | P0 |
| 语音识别 (MiMo) | 配置后测试 | 同 Web Speech | P1 |
| 实时识别显示 | 说话时观察 | 文字实时更新 | P0 |
| LLM 调用 | 识别完成后等待 | 显示 AI 回复 | P0 |
| LLM 错误处理 | 配置错误 API Key | 显示错误 Toast | P1 |
| TTS 朗读 | AI 回复后 | 自动朗读回复 | P0 |
| TTS 打断 | 朗读时点击麦克风 | 停止朗读，重新录音 | P1 |
| 对话历史 | 连续对话 3 轮 | AI 记住上下文 | P1 |
| 状态切换 | 观察指示灯 | idle→listening→processing→speaking→idle | P0 |
| 移动端触摸 | 手机触摸按钮 | 正常录音和停止 | P0 |
| 长文本 | 说一段 30 秒的话 | 完整识别 | P2 |
| 网络断开 | 飞行模式测试 | 显示错误提示 | P2 |

### 7.2 测试场景

#### 场景 1：基础对话（冒烟测试）

```
操作: 按住麦克风 → 说"今天天气怎么样？" → 松开
预期:
  ✅ 显示用户文字: "今天天气怎么样？"
  ✅ 显示打字动画
  ✅ 显示 AI 回复文字
  ✅ 自动语音朗读回复
  ✅ 指示灯回到绿色"准备就绪"
```

#### 场景 2：数学题（核心用例）

```
操作: 按住麦克风 → 说出题目 → 松开
题目: "有个自然数，如果它加上1就能被5整除；
       如果它加上3就能被2整除；
       如果它加上5就能被3整除，这个自然数最小多少？"
预期:
  ✅ 正确识别长句
  ✅ AI 回答 "19"
  ✅ 朗读 "19"
```

#### 场景 3：连续对话

```
操作: 对话 3 轮
第1轮: "我叫小明" → AI 回应
第2轮: "我刚才说了我叫什么？"
预期:
  ✅ AI 记住并回答"小明"
```

#### 场景 4：打断播放

```
操作:
1. AI 正在朗读时 → 按住麦克风
预期:
  ✅ 朗读立即停止
  ✅ 进入录音状态
  ✅ 新语音正常识别
```

#### 场景 5：错误处理

```
操作: 设置错误的 API Key → 说话
预期:
  ✅ 显示错误 Toast
  ✅ 回到空闲状态
  ✅ 可以继续下一次对话
```

### 7.3 兼容性测试

| 平台 | 浏览器 | Web Speech ASR | TTS | MiMo ASR |
|------|--------|:--------------:|:---:|:--------:|
| Android | Chrome | ✅ | ✅ | ✅ |
| Android | Edge | ✅ | ✅ | ✅ |
| Android | 微信内置浏览器 | ❌ | ❌ | ❌ |
| iOS | Safari | ✅ | ✅ | ✅ |
| iOS | Chrome (iOS) | ❌ (基于 WebKit) | ✅ | ❌ |
| Windows | Chrome | ✅ | ✅ | ✅ |
| macOS | Safari | ✅ | ✅ | ✅ |

> **注意**: iOS 上的 Chrome/Firefox 使用的是 WebKit 内核，不支持 Web Speech API 的语音识别，建议 iOS 用户使用 Safari。

### 7.4 性能指标

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| 首屏加载 | < 2s | Chrome DevTools Network |
| 页面大小 | < 50KB | 文件总大小 |
| ASR 延迟 | < 1s（说话到显示） | 实际感受 |
| LLM 延迟 | < 3s | API 响应时间 |
| TTS 延迟 | < 0.5s（文字到出声） | 实际感受 |
| 内存占用 | < 100MB | Chrome Task Manager |

### 7.5 调试技巧

```javascript
// 浏览器控制台调试命令

// 检查当前状态
state  // 当前状态值

// 手动切换状态
setState('idle')
setState('listening')
setState('processing')
setState('speaking')

// 查看配置
config

// 重置配置（清除本地存储）
localStorage.removeItem('voice_agent_config')
location.reload()

// 测试 LLM（不通过语音）
callLLM("1+1等于多少？")

// 测试 TTS
speakText("你好，这是测试语音")

// 查看 ASR 支持情况
'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
// → true 表示支持
```

### 7.6 日志收集

应用内置了 console.log 输出关键事件：

```
Voice Agent initialized with config: {asr: "webspeech", llm: "...", model: "gpt-4o-mini"}
ASR error: no-speech          (静默忽略)
LLM API error 401: ...        (认证失败)
TTS error: ...                (语音播放失败)
```

通过 `chrome://inspect`（Android）或 Safari Web Inspector（iOS）可远程查看日志。

---

## 8. 项目结构

```
voice-agent/
├── index.html          # 主页面（HTML 结构 + PWA meta）
├── style.css           # 样式（暗色主题 + 响应式 + 动画）
├── app.js              # 应用逻辑（状态机 + ASR + LLM + TTS）
├── manifest.json       # PWA 清单（添加到主屏幕）
├── DESIGN.md           # 本设计文档
└── README.md           # 快速使用说明
```

### 文件职责

| 文件 | 行数（约） | 核心职责 |
|------|-----------|----------|
| `index.html` | 80 | 页面骨架、配置面板、按钮、meta 标签 |
| `style.css` | 330 | 全站样式、动画、响应式、暗色主题变量 |
| `app.js` | 530 | 状态管理、ASR/MiMo/LLM/TTS 模块、事件绑定 |
| `manifest.json` | 30 | PWA 名称、图标、主题色 |

---

## 附录 A：MiMo ASR 集成说明

### 配置要求

| 配置项 | 获取方式 |
|--------|----------|
| App ID | 在小米开放平台创建应用获取 |
| Token | 在小米开放平台生成 |

### WebSocket 通信流程

```
客户端 → 服务端: 音频数据 (WebM Opus, 每100ms)
客户端 → 服务端: {"type": "end"} (结束标志)
服务端 → 客户端: {"type": "interim", "text": "..."} (中间结果)
服务端 → 客户端: {"type": "result", "text": "..."} (最终结果)
```

### 注意事项

- 需要 HTTPS 页面（WSS 要求）
- 建议在小米开放平台查阅最新文档
- Token 有有效期，需定期刷新

---

## 附录 B：常见问题

**Q: 为什么点了按钮没反应？**
A: 检查浏览器是否允许麦克风权限，Android Chrome 在地址栏左侧可设置。

**Q: 语音识别不准怎么办？**
A: 尝试使用 MiMo ASR（需要配置），或在安静环境、靠近麦克风说话。

**Q: AI 回复太慢？**
A: 检查网络，或换用更快的模型如 `gpt-4o-mini`、`deepseek-chat`。

**Q: 手机上朗读没有声音？**
A: iOS 检查侧面的静音开关，Android 检查媒体音量。
