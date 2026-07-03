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
  asrProvider: 'mimo',
  llmEndpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'mimo-v2.5-pro',
  ttsProvider: 'mimo',
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
    [State.PROCESSING]: '处理中…',
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
  if (!key) {
    showTyping(false);
    showToast('请先在设置中配置 API Key', 'error');
    setState(State.IDLE);
    return;
  }
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
// MiMo ASR (HTTP API — PCM → WAV → base64)
// ============================================================
class MiMoASR {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.stream = null;
    this.audioContext = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.onResult = null;
    this.onInterim = null;
    this.onError = null;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error('无法访问麦克风: ' + err.message);
    }

    this.chunks = [];

    // 用 MediaRecorder 录制，尝试 mp3 格式（MiMo 支持 wav/mp3，不支持 webm）
    const mimeTypes = ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/wave'];
    let opts = {};
    for (const mt of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mt)) {
        opts = { mimeType: mt };
        break;
      }
    }

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, opts);
    } catch {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.mediaRecorder.start(100);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.cleanup();
        resolve('');
        return;
      }

      this.mediaRecorder.onstop = async () => {
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;

        const blob = new Blob(this.chunks);
        this.chunks = [];

        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);

          // 检测实际格式
          const isWav = blob.type.includes('wav') || blob.type.includes('wave');
          const isMp3 = blob.type.includes('mp3') || blob.type.includes('mpeg');

          let base64;
          let mimeType;

          if (isWav) {
            // WAV 格式直接传
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            base64 = btoa(binary);
            mimeType = 'audio/wav';
          } else if (isMp3) {
            // MP3 格式直接传
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            base64 = btoa(binary);
            mimeType = 'audio/mpeg';
          } else {
            // webm/opus → 转成 WAV（AudioContext decode + encode）
            mimeType = 'audio/wav';
            base64 = await convertWebmToWavBase64(buffer);
          }

          const dataUrl = `data:${mimeType};base64,${base64}`;

          // 调用 MiMo ASR API
          const headers = { 'Content-Type': 'application/json' };
          if (this.apiKey.startsWith('sk-') || this.apiKey.startsWith('tp-')) {
            headers['api-key'] = this.apiKey;
          } else {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          const response = await fetch(config.llmEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: 'mimo-v2.5-asr',
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'input_audio',
                      input_audio: { data: dataUrl },
                    },
                  ],
                },
              ],
              asr_options: { language: 'zh' },
            }),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`ASR ${response.status}: ${errText.slice(0, 100)}`);
          }

          const data = await response.json();
          const text = data.choices?.[0]?.message?.content || '';
          this.onResult?.(text);
          resolve(text);
        } catch (err) {
          this.onError?.(err.message);
          resolve('');
        }

        this.mediaRecorder = null;
      };

      this.mediaRecorder.stop();
    });
  }

  cleanup() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }
}

// webm → WAV 转换（用 AudioContext 解码后重编码）
async function convertWebmToWavBase64(webmBuffer) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await ctx.decodeAudioData(webmBuffer.slice(0));
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch));
    }

    // 编码为 WAV
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = length * numChannels * bitsPerSample / 8;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wavBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(wavBuffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        const val = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, val, true);
        offset += 2;
      }
    }

    const wavBytes = new Uint8Array(wavBuffer);
    let binary = '';
    for (let i = 0; i < wavBytes.length; i++) {
      binary += String.fromCharCode(wavBytes[i]);
    }
    return btoa(binary);
  } catch {
    // 如果转换失败，返回空字符串
    return '';
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
    if (!config.llmApiKey.trim()) {
      showToast('使用 MiMo ASR 需要先配置 API Key', 'error');
      return null;
    }
    return new MiMoASR(config.llmApiKey.trim());
  }
  // Web Speech API 不需要 Key，浏览器原生支持
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
// 文本修正节点 — 修复 ASR 同音错别字和不通顺
// ============================================================
async function correctTranscript(text) {
  if (!text || text.length < 2) return text;

  const headers = { 'Content-Type': 'application/json' };
  const key = config.llmApiKey.trim();
  if (key.startsWith('sk-') || key.startsWith('tp-')) {
    headers['api-key'] = key;
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          {
            role: 'system',
            content: '你是语音识别文本修正助手。你的任务：1. 修正同音错别字 2. 补充缺失的标点 3. 让句子通顺 4. **绝对不要改变原意** 5. **只输出修正后的文本，不要任何解释**',
          },
          { role: 'user', content: text },
        ],
        max_completion_tokens: 512,
        temperature: 0.1,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return text;

    const data = await response.json();
    const corrected = data.choices?.[0]?.message?.content?.trim();
    return corrected || text;
  } catch {
    clearTimeout(timeoutId);
    return text; // 修正失败就用原文
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
      // MiMoASR.stop() 返回识别结果文字
      transcript = await asrInstance.stop();
    }
  } catch (err) {
    console.error('Stop ASR error:', err);
  }

  asrInstance = null;

  if (cancel || !transcript.trim()) {
    setState(State.IDLE);
    return;
  }

  const finalText = transcript.trim();

  // 🔧 文本修正节点 — 修正 ASR 同音错别字
  setState(State.PROCESSING);
  dom.statusText.textContent = '修正中…';
  const corrected = await correctTranscript(finalText);

  // 显示修正后的用户文字
  addMessage('user', corrected);
  showInterim('');
  await callLLM(corrected);
}

// ============================================================
// 绑定事件
// ============================================================
function bindEvents() {
  // 麦克风 - 鼠标
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

  // 麦克风 - 触摸
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

  // 设置按钮
  dom.settingsBtn.addEventListener('click', () => {
    dom.asrProvider.value = config.asrProvider;
    dom.llmEndpoint.value = config.llmEndpoint;
    dom.llmApiKey.value = config.llmApiKey;
    dom.llmModel.value = config.llmModel;
    dom.ttsProvider.value = config.ttsProvider;
    dom.settingsOverlay.classList.add('active');
  });

  // 设置面板按钮
  dom.settingsCancel.addEventListener('click', () => {
    dom.settingsOverlay.classList.remove('active');
  });
  dom.settingsSave.addEventListener('click', () => {
    config.asrProvider = dom.asrProvider.value;
    config.llmEndpoint = dom.llmEndpoint.value.trim();
    config.llmApiKey = dom.llmApiKey.value.trim();
    config.llmModel = dom.llmModel.value.trim();
    config.ttsProvider = dom.ttsProvider.value;
    saveConfig();
    dom.settingsOverlay.classList.remove('active');
    showToast('配置已保存', 'success');
  });

  // 点击遮罩关闭
  dom.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === dom.settingsOverlay) {
      dom.settingsOverlay.classList.remove('active');
    }
  });
}

// ============================================================
// 初始化
// ============================================================
function init() {
  cacheDom();
  loadConfig();
  bindEvents();
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
