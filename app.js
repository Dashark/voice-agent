/**
 * 语音智能助手 - 主应用逻辑
 *
 * 状态机: idle → listening → processing → speaking → idle
 * ASR: Web Speech API / 小米 MiMo ASR
 * LLM: OpenAI 兼容 API
 * TTS: Web Speech API
 *
 * 设计系统: frontend-design 设计哲学
 *   主题: 声音是温暖的、有机的、对话的
 *   签名元素: 声波光晕麦克风按钮
 */

// ============================================================
// 状态常量
// ============================================================
const State = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
});

// ============================================================
// DOM 快捷引用
// ============================================================
const $ = (s, p = document) => p.querySelector(s);

const dom = {};
function cacheDom() {
  dom.chatContainer = $('#chatContainer');
  dom.micBtn = $('#micBtn');
  dom.micLabel = $('#micLabel');
  dom.micIcon = $('#micIcon');
  dom.statusDot = $('#statusDot');
  dom.statusText = $('#statusText');
  dom.settingsBtn = $('#settingsBtn');
  dom.settingsOverlay = $('#settingsOverlay');
  dom.settingsSave = $('#settingsSave');
  dom.settingsCancel = $('#settingsCancel');
  dom.asrProvider = $('#asrProvider');
  dom.mimoConfig = $('#mimoConfig');
  dom.mimoAppId = $('#mimoAppId');
  dom.mimoToken = $('#mimoToken');
  dom.llmEndpoint = $('#llmEndpoint');
  dom.llmApiKey = $('#llmApiKey');
  dom.llmModel = $('#llmModel');
  dom.ttsProvider = $('#ttsProvider');
  dom.interimText = $('#interimText');
  dom.typingIndicator = $('#typingIndicator');
  dom.waveform = $('#waveform');
  dom.emptyState = $('#emptyState');
  dom.ambientWaves = $('#ambientWaves');
}

// ============================================================
// 配置管理
// ============================================================
const CONFIG_KEY = 'voice_agent_config';

const defaultConfig = {
  asrProvider: 'webspeech',
  mimoAppId: '',
  mimoToken: '',
  llmEndpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'mimo-v2.5-pro',
  ttsProvider: 'webspeech',
  systemPrompt: '你是MiMo，是小米公司研发的AI智能助手。请用中文简洁地回答用户的问题。直接给出答案，不要多余的解释。',
};

let config = { ...defaultConfig };

function loadConfig() {
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) {
      config = { ...defaultConfig, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.warn('Config load failed, using defaults');
  }
}

function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

// ============================================================
// 应用状态
// ============================================================
let state = State.IDLE;
let conversationHistory = [];
let recognition = null;
let speechSynth = window.speechSynthesis;
let currentUtterance = null;
let audioContext = null;
let waveformAnimationId = null;
let mediaStream = null;
let asrInstance = null;
let pendingTranscript = '';

// ============================================================
// 消息渲染
// ============================================================
function hideEmptyState() {
  if (dom.emptyState) {
    dom.emptyState.style.display = 'none';
  }
}

function addMessage(role, text) {
  hideEmptyState();

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? '你说' : 'AI 回复';
  msgDiv.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  msgDiv.appendChild(bubble);

  dom.chatContainer.appendChild(msgDiv);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.chatContainer.scrollTop = dom.chatContainer.scrollHeight;
  });
}

function showInterim(text) {
  dom.interimText.textContent = text || '';
  dom.interimText.classList.toggle('active', !!text);
  if (text) hideEmptyState();
  scrollToBottom();
}

function showTyping(show) {
  dom.typingIndicator.classList.toggle('active', show);
  if (show) hideEmptyState();
  scrollToBottom();
}

// ============================================================
// Toast 通知
// ============================================================
let toastTimer = null;

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  toastTimer = setTimeout(() => toast.remove(), 2800);
}

// ============================================================
// 状态管理
// ============================================================
function setState(newState) {
  state = newState;

  // 状态指示点
  dom.statusDot.className = 'status-dot ' + newState;

  // 状态文字
  const statusMap = {
    [State.IDLE]: '准备就绪',
    [State.LISTENING]: '聆听中…',
    [State.PROCESSING]: '思考中…',
    [State.SPEAKING]: '播放中…',
  };
  dom.statusText.textContent = statusMap[newState] || '准备就绪';

  // 麦克风按钮
  dom.micBtn.classList.toggle('recording', newState === State.LISTENING);
  dom.micLabel.textContent = newState === State.LISTENING ? '松开结束' : '按住说话';

  // 环境声波背景
  dom.ambientWaves?.classList.toggle('active', newState === State.LISTENING || newState === State.SPEAKING);
}

// ============================================================
// TTS 语音合成
// ============================================================
function speakText(text) {
  return new Promise((resolve) => {
    if (!text || !text.trim()) return resolve();

    // 停止当前播放
    if (speechSynth.speaking) {
      speechSynth.cancel();
    }

    setState(State.SPEAKING);

    if (config.ttsProvider === 'mimo') {
      speakWithMiMo(text).then(resolve).catch(() => {
        // MiMo TTS 失败时回退到 Web Speech
        console.warn('MiMo TTS failed, falling back to Web Speech');
        speakWithWebSpeech(text).then(resolve);
      });
    } else {
      speakWithWebSpeech(text).then(resolve);
    }
  });
}

function speakWithWebSpeech(text) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = speechSynth.getVoices();
    const zhVoice = voices.find(v => v.lang.startsWith('zh'));
    if (zhVoice) utterance.voice = zhVoice;

    utterance.onend = () => { setState(State.IDLE); resolve(); };
    utterance.onerror = () => { setState(State.IDLE); resolve(); };

    currentUtterance = utterance;
    speechSynth.speak(utterance);

    if (speechSynth.getVoices().length === 0) {
      speechSynth.onvoiceschanged = () => {
        const v = speechSynth.getVoices().find(v => v.lang.startsWith('zh'));
        if (v) utterance.voice = v;
      };
    }
  });
}

async function speakWithMiMo(text) {
  const key = config.llmApiKey.trim();
  const headers = { 'Content-Type': 'application/json' };
  if (key.startsWith('sk-') || key.startsWith('tp-')) {
    headers['api-key'] = key;
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }

  // 从 llmEndpoint 提取 base URL
  const baseUrl = config.llmEndpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
  const ttsEndpoint = `${baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(ttsEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        messages: [
          { role: 'user', content: '请用自然的中文语音朗读以下内容。' },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: 'Aria' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`TTS API ${response.status}`);
    }

    const data = await response.json();
    const audioData = data.choices?.[0]?.message?.audio?.data;
    if (!audioData) throw new Error('No audio data in response');

    // 解码 base64 音频并播放
    const binaryStr = atob(audioData);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const audioBlob = new Blob([bytes], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      setState(State.IDLE);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      setState(State.IDLE);
    };

    await audio.play();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err; // 让调用方处理回退
  }
}

// ============================================================
// LLM 调用
// ============================================================
async function callLLM(userText) {
  setState(State.PROCESSING);
  showTyping(true);

  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...conversationHistory.slice(-10),
    { role: 'user', content: userText },
  ];

  // 构建请求头 — 同时支持 Authorization: Bearer 和 api-key 两种认证
  const headers = { 'Content-Type': 'application/json' };
  const key = config.llmApiKey.trim();
  if (key.startsWith('sk-') || key.startsWith('tp-')) {
    // MiMo 风格 Key：优先用 api-key 头（MiMo 推荐方式）
    headers['api-key'] = key;
  } else {
    // OpenAI 风格 Bearer token
    headers['Authorization'] = `Bearer ${key}`;
  }

  // 创建 AbortController 用于超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 超时

  try {
    const response = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        temperature: 0.7,
        max_completion_tokens: 2048,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text().catch(() => 'Unknown error');
      throw new Error(`API ${response.status}: ${err.slice(0, 120)}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解你的问题。';

    conversationHistory.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: reply }
    );

    showTyping(false);
    addMessage('assistant', reply);
    await speakText(reply);

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('LLM error:', err);

    // 回滚对话历史（不保留失败的轮次）
    if (conversationHistory.length >= 2 &&
        conversationHistory[conversationHistory.length - 1]?.role === 'assistant') {
      conversationHistory.pop();
      conversationHistory.pop();
    }

    showTyping(false);
    const msg = err.name === 'AbortError'
      ? '请求超时，请检查网络或 API 配置'
      : 'AI 响应失败: ' + err.message;
    showToast(msg, 'error');
    setState(State.IDLE);
  }
}

// ============================================================
// MiMo ASR (WebSocket)
// ============================================================
class MiMoASR {
  constructor(appId, token) {
    this.appId = appId;
    this.token = token;
    this.ws = null;
    this.mediaRecorder = null;
    this.stream = null;
    this.onResult = null;
    this.onInterim = null;
    this.onError = null;
    this.isConnected = false;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error('无法访问麦克风: ' + err.message);
    }

    const wsUrl = `wss://asr.mimo.mi.com/v1/asr?app_id=${this.appId}&token=${this.token}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        this.cleanup();
        reject(new Error('WebSocket 连接失败'));
        return;
      }

      this.ws.onopen = () => {
        this.isConnected = true;
        this.startRecording();
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'result' && data.text) {
            this.onResult?.(data.text);
          } else if (data.type === 'interim' && data.text) {
            this.onInterim?.(data.text);
          }
        } catch { /* binary data, ignore */ }
      };

      this.ws.onerror = () => {
        this.cleanup();
        reject(new Error('WebSocket 连接错误'));
      };

      this.ws.onclose = () => { this.isConnected = false; };

      setTimeout(() => {
        if (!this.isConnected) {
          this.cleanup();
          reject(new Error('WebSocket 连接超时'));
        }
      }, 10000);
    });
  }

  startRecording() {
    const opts = { mimeType: 'audio/webm;codecs=opus' };
    try {
      this.mediaRecorder = new MediaRecorder(this.stream, opts);
    } catch {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(event.data);
      }
    };

    this.mediaRecorder.start(100);
  }

  stop() {
    return new Promise((resolve) => {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = () => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'end' }));
          }
          setTimeout(() => { this.cleanup(); resolve(); }, 500);
        };
        this.mediaRecorder.stop();
      } else {
        this.cleanup();
        resolve();
      }
    });
  }

  cleanup() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.ws?.close();
    this.stream = null;
    this.mediaRecorder = null;
    this.ws = null;
    this.isConnected = false;
  }
}

// ============================================================
// Web Speech ASR
// ============================================================
class WebSpeechASR {
  constructor() {
    this.recognition = null;
    this.onResult = null;
    this.onInterim = null;
    this.onError = null;
    this.isRunning = false;
    this.finalTranscript = '';
    this.restartTimer = null;
  }

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('当前浏览器不支持语音识别，请使用 Chrome 或 Safari');

    this.finalTranscript = '';
    this.recognition = new SR();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          this.finalTranscript += event.results[i][0].transcript;
          this.onResult?.(event.results[i][0].transcript);
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      this.onInterim?.(this.finalTranscript + interim);
    };

    this.recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      this.onError?.(event.error);
    };

    this.recognition.onend = () => {
      if (this.isRunning) {
        this.restartTimer = setTimeout(() => {
          if (this.isRunning) {
            try { this.recognition?.start(); } catch { /* ok */ }
          }
        }, 100);
      }
    };

    this.isRunning = true;
    this.recognition.start();
  }

  stop() {
    this.isRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* ok */ }
      this.recognition = null;
    }
    return this.finalTranscript;
  }
}

// ============================================================
// ASR 工厂
// ============================================================
function createASR() {
  if (config.asrProvider === 'mimo') {
    if (!config.mimoAppId || !config.mimoToken) {
      showToast('请先配置 MiMo ASR 的 App ID 和 Token', 'error');
      return null;
    }
    return new MiMoASR(config.mimoAppId, config.mimoToken);
  }
  return new WebSpeechASR();
}

// ============================================================
// 声波可视化
// ============================================================
function startWaveform() {
  dom.waveform.classList.add('active');
  const bars = dom.waveform.querySelectorAll('.waveform-bar');

  // 尝试使用 AudioContext 做真实可视化
  try {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      mediaStream = stream;
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 64;
      source.connect(analyserNode);
      const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

      function animate() {
        analyserNode.getByteFrequencyData(dataArray);
        const step = Math.max(1, Math.floor(dataArray.length / bars.length));
        bars.forEach((bar, i) => {
          const val = dataArray[i * step] || 0;
          bar.style.height = Math.max(3, (val / 255) * 32) + 'px';
        });
        waveformAnimationId = requestAnimationFrame(animate);
      }
      animate();
    }).catch(() => randomWaveform(bars));
  } catch {
    randomWaveform(bars);
  }
}

function randomWaveform(bars) {
  function rand() {
    bars.forEach(b => { b.style.height = (3 + Math.random() * 29) + 'px'; });
    waveformAnimationId = requestAnimationFrame(rand);
  }
  rand();
}

function stopWaveform() {
  dom.waveform.classList.remove('active');
  if (waveformAnimationId) {
    cancelAnimationFrame(waveformAnimationId);
    waveformAnimationId = null;
  }
  // 重置波形条高度
  dom.waveform.querySelectorAll('.waveform-bar').forEach(b => {
    b.style.height = '3px';
  });
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

// ============================================================
// 录音流程
// ============================================================
async function startListening() {
  if (state === State.SPEAKING) {
    speechSynth.cancel();
  }

  showInterim('');

  const asr = createASR();
  if (!asr) return;

  asrInstance = asr;
  setState(State.LISTENING);
  startWaveform();

  asr.onInterim = (text) => showInterim(text);
  asr.onResult = (text) => { pendingTranscript = text; };
  asr.onError = (err) => {
    console.error('ASR error:', err);
    showToast('语音识别错误', 'error');
    stopListening(true);
  };

  try {
    await asr.start();
  } catch (err) {
    showToast(err.message, 'error');
    setState(State.IDLE);
    stopWaveform();
    asrInstance = null;
  }
}

async function stopListening(cancel = false) {
  if (!asrInstance) return;

  stopWaveform();
  showInterim('');

  let transcript = '';

  try {
    if (asrInstance instanceof WebSpeechASR) {
      transcript = asrInstance.stop();
    } else {
      await asrInstance.stop();
      transcript = pendingTranscript;
    }
  } catch (err) {
    console.error('Stop ASR error:', err);
  }

  asrInstance = null;

  if (cancel || !transcript.trim()) {
    setState(State.IDLE);
    return;
  }

  addMessage('user', transcript.trim());
  showInterim('');
  await callLLM(transcript.trim());
}

// ============================================================
// 交互控制
// ============================================================
// 鼠标
dom.micBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (state === State.IDLE) startListening();
});

dom.micBtn.addEventListener('mouseup', (e) => {
  e.preventDefault();
  if (state === State.LISTENING) stopListening();
});

dom.micBtn.addEventListener('mouseleave', () => {
  if (state === State.LISTENING) stopListening();
});

// 触摸
dom.micBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (state === State.IDLE) startListening();
}, { passive: false });

dom.micBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (state === State.LISTENING) stopListening();
}, { passive: false });

dom.micBtn.addEventListener('touchcancel', () => {
  if (state === State.LISTENING) stopListening();
});

// 空格键
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ' && !e.repeat && state === State.IDLE) {
    e.preventDefault();
    startListening();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && !e.repeat && state === State.LISTENING) {
    e.preventDefault();
    stopListening();
  }
});

// ============================================================
// 设置面板
// ============================================================
dom.settingsBtn.addEventListener('click', () => {
  dom.asrProvider.value = config.asrProvider;
  dom.mimoAppId.value = config.mimoAppId;
  dom.mimoToken.value = config.mimoToken;
  dom.llmEndpoint.value = config.llmEndpoint;
  dom.llmApiKey.value = config.llmApiKey;
  dom.llmModel.value = config.llmModel;
  dom.ttsProvider.value = config.ttsProvider;
  dom.mimoConfig.style.display = config.asrProvider === 'mimo' ? 'block' : 'none';
  dom.settingsOverlay.classList.add('active');
});

dom.asrProvider.addEventListener('change', () => {
  dom.mimoConfig.style.display = dom.asrProvider.value === 'mimo' ? 'block' : 'none';
});

dom.settingsCancel.addEventListener('click', () => {
  dom.settingsOverlay.classList.remove('active');
});

dom.settingsSave.addEventListener('click', () => {
  config.asrProvider = dom.asrProvider.value;
  config.mimoAppId = dom.mimoAppId.value.trim();
  config.mimoToken = dom.mimoToken.value.trim();
  config.llmEndpoint = dom.llmEndpoint.value.trim();
  config.llmApiKey = dom.llmApiKey.value.trim();
  config.llmModel = dom.llmModel.value.trim();
  config.ttsProvider = dom.ttsProvider.value;
  saveConfig();
  dom.settingsOverlay.classList.remove('active');
  showToast('配置已保存', 'success');
});

dom.settingsOverlay.addEventListener('click', (e) => {
  if (e.target === dom.settingsOverlay) {
    dom.settingsOverlay.classList.remove('active');
  }
});

// ============================================================
// 初始化
// ============================================================
function init() {
  cacheDom();
  loadConfig();
  setState(State.IDLE);

  // 预加载语音
  if ('speechSynthesis' in window) {
    speechSynth.getVoices();
    speechSynth.onvoiceschanged = () => speechSynth.getVoices();
  }

  // 检测移动端
  const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
  if (isMobile) {
    dom.micLabel.textContent = '按住说话';
  }

  console.log('Voice Agent ready:', config.asrProvider, config.llmModel);
}

// 启动
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
