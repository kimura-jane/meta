// ============================================
// connection.js - PartyKit接続（Agora RTC/Live切り替え対応版）
// ============================================

import {
  debugLog,
  addSpeakerIndicator,
  removeSpeakerIndicator
} from './utils.js';

import { setHostAuthResult } from './settings.js';

// --------------------------------------------
// 設定
// --------------------------------------------
const PARTYKIT_HOST = 'kimurameta.kimura-jane.partykit.dev';
const ROOM_ID = 'main-stage';

// Agora設定
const AGORA_APP_ID = 'be3dfbd19aea4850bb9564c05248f3f9';
const AGORA_CHANNEL = 'metaverse_room';

// Agoraモード設定（'rtc' または 'live'）- デフォルトはrtc
let agoraMode = localStorage.getItem('agoraMode') || 'rtc';

// 絵文字カテゴリ
const EMOJI_CATEGORIES = {
  cheer: ['🙌', '👏', '🔥', '🩷', '❤️', '❤️‍🔥'],
  celebrate: ['🎉', '🎊', '🎁', '✨', '🥇'],
  funny: ['💩', '🧠', '💢', '🐼', '👼'],
  sports: ['⚾️', '🏀', '⚽️', '🏇'],
  food: ['🍙', '🍌', '🍻', '🍾']
};

// --------------------------------------------
// 状態
// --------------------------------------------
let socket = null;
let connected = false;
let myServerConnectionId = null;
let currentUserName = '';

let isSpeaker = false;
let isMicMuted = false;

let speakerCount = 0;
let speakRequests = [];
let currentSpeakers = [];

let hostAuthed = false;
let hostAuthPending = false;

let secretMode = false;
let isAuthed = false;
let isHost = false;

// Agora関連
let agoraClient = null;
let localAudioTrack = null;
let remoteUsers = new Map();
let isAgoraJoinedAsListener = false;
let audioUnlocked = false;

// Web Audio API用
let audioContext = null;

// ピン留め
let pinnedComment = null;

// beforeunload重複登録防止
let beforeUnloadRegistered = false;

// デバッグパネル
let debugPanel = null;
let debugModeDisplay = null;
let debugEnabled = false;

function canAccessContent() {
  return !secretMode || isAuthed;
}

// コールバック
let callbacks = {
  onUserJoin: null,
  onUserLeave: null,
  onPosition: null,
  onReaction: null,
  onAvatarChange: null,
  onNameChange: null,
  onSpeakApproved: null,
  onSpeakerJoined: null,
  onSpeakerLeft: null,
  onConnectedChange: null,
  onSpeakRequestsUpdate: null,
  onCurrentSpeakersUpdate: null,
  onAnnounce: null,
  onBackgroundChange: null,
  onBrightnessChange: null,
  onChat: null,
  onKicked: null,
  remoteAvatars: null,
  onInitMin: null,
  onAuthOk: null,
  onAuthNg: null,
  onSecretModeChanged: null,
  onHostAuthResult: null,
  onMyIdChanged: null,
  onEmojiThrow: null,
  onPinnedComment: null,
  onAgoraModeChange: null
};

export function setCallbacks(cbs) {
  callbacks = { ...callbacks, ...(cbs || {}) };
}

export function getState() {
  return {
    connected,
    isSpeaker,
    isMicMuted,
    speakerCount,
    myServerConnectionId,
    speakRequests,
    currentSpeakers,
    hostAuthed,
    secretMode,
    isAuthed,
    isHost,
    pinnedComment,
    agoraMode
  };
}

export function getMyConnectionId() {
  return myServerConnectionId;
}

export function getEmojiCategories() {
  return EMOJI_CATEGORIES;
}

// --------------------------------------------
// 主催者用デバッグパネル（右上配置・表示切替可能）
// --------------------------------------------
function createDebugPanel() {
  if (debugPanel) return;
  
  debugPanel = document.createElement('div');
  debugPanel.id = 'host-debug-panel';
  debugPanel.style.cssText = `
    position: fixed;
    top: 100px;
    right: 10px;
    width: 200px;
    max-height: 250px;
    background: rgba(0, 0, 0, 0.9);
    color: #0f0;
    font-family: monospace;
    font-size: 9px;
    padding: 8px;
    border-radius: 8px;
    overflow-y: auto;
    z-index: 10000;
    display: none;
    border: 1px solid #0f0;
    pointer-events: none;
  `;
  
  // モード表示エリア
  debugModeDisplay = document.createElement('div');
  debugModeDisplay.style.cssText = `
    background: #333;
    padding: 4px 8px;
    margin-bottom: 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: bold;
    text-align: center;
  `;
  updateModeDisplay();
  debugPanel.appendChild(debugModeDisplay);
  
  document.body.appendChild(debugPanel);
}

function updateModeDisplay() {
  if (!debugModeDisplay) return;
  const modeText = agoraMode === 'rtc' ? '📞 通話' : '📡 配信';
  const color = agoraMode === 'rtc' ? '#0ff' : '#f0f';
  debugModeDisplay.innerHTML = `<span style="color:${color}">${modeText}</span>`;
}

// デバッグ表示ON/OFF（settings.jsから呼ばれる）
export function setDebugEnabled(enabled) {
  debugEnabled = enabled;
  if (!debugPanel) createDebugPanel();
  
  if (enabled && hostAuthed) {
    debugPanel.style.display = 'block';
    updateModeDisplay();
  } else {
    debugPanel.style.display = 'none';
  }
}

export function getDebugEnabled() {
  return debugEnabled;
}

function showDebugPanel() {
  if (!debugPanel) createDebugPanel();
  if (debugEnabled && hostAuthed) {
    debugPanel.style.display = 'block';
    updateModeDisplay();
  }
}

function hideDebugPanel() {
  if (debugPanel) debugPanel.style.display = 'none';
}

function hostDebugLog(message, type = 'info') {
  console.log(`[${type}] ${message}`);
  
  if (!debugEnabled || !hostAuthed || !debugPanel) return;
  
  const colors = {
    info: '#0ff',
    success: '#0f0',
    warn: '#ff0',
    error: '#f00'
  };
  
  const line = document.createElement('div');
  line.style.color = colors[type] || '#fff';
  line.style.borderBottom = '1px solid #333';
  line.style.padding = '2px 0';
  line.style.wordBreak = 'break-all';
  
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `${time} ${message}`;
  
  debugPanel.appendChild(line);
  debugPanel.scrollTop = debugPanel.scrollHeight;
  
  while (debugPanel.children.length > 51) {
    debugPanel.removeChild(debugPanel.children[1]);
  }
}

// --------------------------------------------
// Agoraモード切り替え
// --------------------------------------------
export function getAgoraMode() {
  return agoraMode;
}

export function setAgoraMode(mode) {
  if (mode !== 'rtc' && mode !== 'live') {
    hostDebugLog(`無効なモード: ${mode}`, 'error');
    return false;
  }
  
  const oldMode = agoraMode;
  if (oldMode === mode) {
    return true;
  }
  
  const wasInChannel = agoraClient !== null;
  const wasSpeaker = isSpeaker;
  const wasListener = isAgoraJoinedAsListener;
  
  agoraMode = mode;
  localStorage.setItem('agoraMode', mode);
  
  updateModeDisplay();
  hostDebugLog(`モード: ${oldMode} → ${mode}`, 'success');
  
  if (callbacks.onAgoraModeChange) {
    callbacks.onAgoraModeChange(mode);
  }
  
  if (wasInChannel) {
    hostDebugLog('再接続中...', 'info');
    leaveAgoraChannel().then(() => {
      if (wasSpeaker) {
        joinAgoraChannel();
      } else if (wasListener) {
        joinAgoraAsListener();
      }
    });
  }
  
  return true;
}

export function toggleAgoraMode() {
  const newMode = agoraMode === 'rtc' ? 'live' : 'rtc';
  return setAgoraMode(newMode);
}

// --------------------------------------------
// WebSocket URL
// --------------------------------------------
function buildWsUrl(userName) {
  const base = `wss://${PARTYKIT_HOST}`;
  const room = encodeURIComponent(ROOM_ID);
  const name = encodeURIComponent(userName);
  return `${base}/party/${room}?name=${name}`;
}

// --------------------------------------------
// 再接続制御
// --------------------------------------------
let reconnectTimer = null;
let reconnectAttempt = 0;
let wantReconnect = true;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!wantReconnect) return;
  if (reconnectTimer) return;

  const base = 800;
  const max = 8000;
  const jitter = Math.floor(Math.random() * 250);
  const delay = Math.min(max, base * Math.pow(2, Math.min(5, reconnectAttempt))) + jitter;
  reconnectAttempt++;

  hostDebugLog(`再接続: ${delay}ms`, 'warn');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToPartyKit(currentUserName);
  }, delay);
}

// --------------------------------------------
// 送信ヘルパー
// --------------------------------------------
function safeSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  hostDebugLog(`送信失敗: 未接続`, 'warn');
  return false;
}

// --------------------------------------------
// iOS音声アンロック（超シンプル版）
// --------------------------------------------
async function unlockAudioForIOS() {
  hostDebugLog('音声アンロック開始', 'info');
  
  try {
    // AudioContextの初期化のみ
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    
    // 無音を鳴らすだけ
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.001);
    
    hostDebugLog('音声アンロック完了', 'success');
    return true;
    
  } catch (e) {
    hostDebugLog(`アンロック失敗: ${e.message}`, 'error');
    return false;
  }
}

// --------------------------------------------
// 音声再生オーバーレイ制御
// --------------------------------------------
function showAudioUnlockOverlay() {
  const overlay = document.getElementById('audio-unlock-overlay');
  if (!overlay) {
    hostDebugLog('オーバーレイ要素なし', 'error');
    return;
  }
  
  overlay.style.cssText = `
    display: flex !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
    background: rgba(0, 0, 0, 0.85) !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 99999 !important;
    cursor: pointer !important;
    pointer-events: auto !important;
  `;
  
  overlay.classList.add('show');
  hostDebugLog('オーバーレイ表示', 'info');
}

function hideAudioUnlockOverlay() {
  const overlay = document.getElementById('audio-unlock-overlay');
  if (overlay) {
    overlay.style.cssText = `
      display: none !important;
      pointer-events: none !important;
    `;
    overlay.classList.remove('show');
    hostDebugLog('オーバーレイ非表示', 'info');
  }
}

let overlayInitialized = false;

function initAudioUnlockOverlay() {
  if (overlayInitialized) return;
  
  const overlay = document.getElementById('audio-unlock-overlay');
  if (!overlay) {
    hostDebugLog('オーバーレイ要素が見つからない', 'error');
    return;
  }
  
  overlayInitialized = true;
  overlay.style.display = 'none';
  
  const handleTap = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    hostDebugLog('タップ検出!', 'success');
    
    await unlockAudioForIOS();
    
    audioUnlocked = true;
    hideAudioUnlockOverlay();
    
    if (speakerCount > 0 && !isSpeaker && !isAgoraJoinedAsListener) {
      hostDebugLog('視聴者参加開始', 'info');
      joinAgoraAsListener();
    }
  };
  
  overlay.addEventListener('click', handleTap, true);
  overlay.addEventListener('touchend', handleTap, { capture: true, passive: false });
  
  const content = overlay.querySelector('.audio-unlock-content');
  if (content) {
    content.addEventListener('click', handleTap, true);
    content.addEventListener('touchend', handleTap, { capture: true, passive: false });
  }
  
  hostDebugLog('オーバーレイ初期化完了', 'success');
}

// --------------------------------------------
// beforeunload設定
// --------------------------------------------
function setupBeforeUnload() {
  if (beforeUnloadRegistered) return;
  beforeUnloadRegistered = true;
  
  window.addEventListener('beforeunload', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'leave' }));
      socket.close(1000, 'page unload');
    }
  });
}

// --------------------------------------------
// PartyKit接続
// --------------------------------------------
export function connectToPartyKit(userName) {
  currentUserName = userName || 'ゲスト';

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    try { socket.close(1000, 'reconnect'); } catch (_) {}
  }
  socket = null;

  wantReconnect = true;
  clearReconnectTimer();

  isAuthed = false;
  secretMode = false;
  isHost = false;
  hostAuthed = false;
  hostAuthPending = false;
  myServerConnectionId = null;
  audioUnlocked = false;

  const wsUrl = buildWsUrl(currentUserName);
  hostDebugLog(`接続開始`, 'info');

  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    hostDebugLog(`WS作成エラー`, 'error');
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    connected = true;
    reconnectAttempt = 0;
    hostDebugLog('接続成功', 'success');
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);

    createDebugPanel();
    initAudioUnlockOverlay();
    setupBeforeUnload();

    safeSend({ type: 'requestInit', userName: currentUserName });
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'position') {
        hostDebugLog(`受信: ${data.type}`, 'info');
      }
      handleServerMessage(data);
    } catch (e) {
      hostDebugLog(`解析エラー`, 'error');
    }
  };

  socket.onclose = (ev) => {
    hostDebugLog(`切断 code=${ev.code}`, 'warn');

    connected = false;
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(false);

    isAuthed = false;
    secretMode = false;
    isHost = false;
    hostAuthed = false;
    hostAuthPending = false;

    hideDebugPanel();
    leaveAgoraChannel();

    setHostAuthResult(false, '接続が切れたため主催者状態を解除しました');

    if (ev.code === 1000 || ev.code === 1001) return;
    scheduleReconnect();
  };

  socket.onerror = () => {
    hostDebugLog(`WSエラー`, 'error');
  };
}

export function disconnectPartyKit() {
  wantReconnect = false;
  clearReconnectTimer();
  if (socket) {
    try { socket.close(1000, 'manual'); } catch (_) {}
  }
  socket = null;
  connected = false;
  leaveAgoraChannel();
  hideDebugPanel();
  if (callbacks.onConnectedChange) callbacks.onConnectedChange(false);
}

// --------------------------------------------
// サーバ受信
// --------------------------------------------
function handleServerMessage(data) {
  switch (data.type) {
    case 'initMin': {
      const oldId = myServerConnectionId;
      myServerConnectionId = data.yourId;

      secretMode = !!data.secretMode;
      isHost = !!data.isHost;
      if (data.isAuthed !== undefined) isAuthed = !!data.isAuthed;

      hostDebugLog(`initMin: ID取得`, 'success');

      if (callbacks.onMyIdChanged && oldId !== myServerConnectionId) {
        callbacks.onMyIdChanged(oldId, myServerConnectionId);
      }

      if (callbacks.onInitMin) {
        callbacks.onInitMin({
          secretMode,
          isHost,
          isAuthed,
          authRequired: data.authRequired !== undefined ? !!data.authRequired : secretMode
        });
      }
      break;
    }

    case 'init': {
      const oldId = myServerConnectionId;
      myServerConnectionId = data.yourId;

      if (data.secretMode !== undefined) secretMode = !!data.secretMode;
      if (data.isHost !== undefined) isHost = !!data.isHost;
      if (data.isAuthed !== undefined) isAuthed = !!data.isAuthed;

      const userCount = Object.keys(data.users || {}).length;
      hostDebugLog(`init: ${userCount}人`, 'success');

      if (callbacks.onMyIdChanged && oldId !== myServerConnectionId) {
        callbacks.onMyIdChanged(oldId, myServerConnectionId);
      }

      Object.entries(data.users || {}).forEach(([odUserId, user]) => {
        if (odUserId === myServerConnectionId) return;

        if (callbacks.onUserJoin) callbacks.onUserJoin(odUserId, user.name || user.userName || 'ゲスト');

        if (callbacks.onPosition && user.x !== undefined && user.z !== undefined) {
          setTimeout(() => callbacks.onPosition(odUserId, user.x, user.y ?? 0, user.z), 100);
        }

        if (callbacks.onAvatarChange && user.avatarUrl) {
          setTimeout(() => callbacks.onAvatarChange(odUserId, user.avatarUrl), 200);
        }
      });

      updateSpeakerList(data.speakers || []);

      if (data.speakRequests) {
        speakRequests = data.speakRequests;
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
      }

      if (data.brightness !== undefined && callbacks.onBrightnessChange) {
        callbacks.onBrightnessChange(data.brightness);
      }

      if (data.backgroundUrl && callbacks.onBackgroundChange) {
        callbacks.onBackgroundChange(data.backgroundUrl);
      }

      if (data.pinnedComment) {
        pinnedComment = data.pinnedComment;
        if (callbacks.onPinnedComment) callbacks.onPinnedComment(pinnedComment);
      }

      checkAndShowAudioOverlay();

      break;
    }

    case 'authOk': {
      isAuthed = true;
      hostDebugLog('入室認証OK', 'success');
      if (callbacks.onAuthOk) callbacks.onAuthOk();
      safeSend({ type: 'requestInit', userName: currentUserName });
      break;
    }

    case 'authNg': {
      isAuthed = false;
      hostDebugLog('入室認証NG', 'warn');
      if (callbacks.onAuthNg) callbacks.onAuthNg();
      break;
    }

    case 'secretModeChanged': {
      secretMode = !!data.value;
      if (data.isAuthed !== undefined) isAuthed = !!data.isAuthed;

      hostDebugLog(`secretMode: ${secretMode}`, 'info');
      if (callbacks.onSecretModeChanged) callbacks.onSecretModeChanged(secretMode);

      safeSend({ type: 'requestInit', userName: currentUserName });
      break;
    }

    case 'hostAuthResult': {
      const ok = !!data.ok;
      const reason = data.reason || '';
      hostAuthed = ok;
      hostAuthPending = false;

      if (data.isHost !== undefined) isHost = !!data.isHost;
      if (data.isAuthed !== undefined) isAuthed = !!data.isAuthed;

      setHostAuthResult(ok, reason);
      hostDebugLog(`hostAuth: ${ok ? 'OK' : 'NG'}`, ok ? 'success' : 'warn');

      if (ok) {
        showDebugPanel();
      } else {
        hideDebugPanel();
      }

      if (callbacks.onHostAuthResult) {
        callbacks.onHostAuthResult({ ok, reason, isHost, isAuthed });
      }

      if (callbacks.onInitMin) {
        callbacks.onInitMin({
          secretMode,
          isHost,
          isAuthed,
          authRequired: secretMode
        });
      }

      break;
    }

    case 'userJoin': {
      if (!canAccessContent()) return;
      const joinUserId = data.odUserId || data.userId || data.user?.id;
      const joinUserName = data.userName || data.user?.name || 'ゲスト';
      if (joinUserId && joinUserId !== myServerConnectionId && callbacks.onUserJoin) {
        callbacks.onUserJoin(joinUserId, joinUserName);
      }
      break;
    }

    case 'userLeave': {
      if (!canAccessContent()) return;
      const leaveUserId = data.odUserId || data.userId;
      if (callbacks.onUserLeave) callbacks.onUserLeave(leaveUserId);
      if (data.speakers) updateSpeakerList(data.speakers);
      speakRequests = speakRequests.filter((r) => r.userId !== leaveUserId);
      if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
      break;
    }

    case 'position': {
      if (!canAccessContent()) return;
      const posUserId = data.odUserId || data.userId;
      if (callbacks.onPosition) callbacks.onPosition(posUserId, data.x, data.y ?? 0, data.z);
      break;
    }

    case 'avatarChange': {
      if (!canAccessContent()) return;
      const avatarUserId = data.odUserId || data.userId;
      if (callbacks.onAvatarChange) callbacks.onAvatarChange(avatarUserId, data.imageUrl);
      break;
    }

    case 'nameChange': {
      if (!canAccessContent()) return;
      const nameUserId = data.odUserId || data.userId;
      if (callbacks.onNameChange) callbacks.onNameChange(nameUserId, data.name);
      break;
    }

    case 'reaction': {
      if (!canAccessContent()) return;
      const reactUserId = data.odUserId || data.userId;
      if (callbacks.onReaction) callbacks.onReaction(reactUserId, data.reaction, data.color);
      break;
    }

    case 'chat': {
      if (!canAccessContent()) return;
      if (callbacks.onChat) {
        const senderId = data.senderId || data.odUserId || data.userId;
        callbacks.onChat(senderId, data.name, data.message);
      }
      break;
    }

    case 'emojiThrow': {
      if (!canAccessContent()) return;
      if (callbacks.onEmojiThrow) {
        callbacks.onEmojiThrow(data.emoji, data.senderId, data.senderName);
      }
      break;
    }

    case 'pinComment': {
      if (!canAccessContent()) return;
      pinnedComment = data.comment;
      if (callbacks.onPinnedComment) callbacks.onPinnedComment(pinnedComment);
      break;
    }

    case 'unpinComment': {
      if (!canAccessContent()) return;
      pinnedComment = null;
      if (callbacks.onPinnedComment) callbacks.onPinnedComment(null);
      break;
    }

    case 'speakRequest': {
      if (!canAccessContent()) return;
      const reqUserId = data.userId || data.odUserId;
      const reqUserName = data.userName || 'ゲスト';

      if (!speakRequests.find((r) => r.userId === reqUserId)) {
        speakRequests.push({ userId: reqUserId, userName: reqUserName });
      }
      if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
      break;
    }

    case 'speakRequestsUpdate': {
      if (!canAccessContent()) return;
      speakRequests = data.requests || [];
      if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
      break;
    }

    case 'speakRequestSent': {
      hostDebugLog('登壇リクエスト送信', 'success');
      break;
    }

    case 'speakApproved': {
      if (!canAccessContent()) return;
      hostDebugLog('登壇承認', 'success');

      isSpeaker = true;

      if (!currentSpeakers.find((s) => s.userId === myServerConnectionId)) {
        currentSpeakers.push({ userId: myServerConnectionId, userName: currentUserName });
      }

      speakerCount = currentSpeakers.length;
      updateSpeakerButton();
      updateSpeakerCountUI();

      if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);

      if (isAgoraJoinedAsListener) {
        leaveAgoraChannel().then(() => {
          joinAgoraChannel();
        });
      } else {
        joinAgoraChannel();
      }

      hideAudioUnlockOverlay();

      if (callbacks.onSpeakApproved) callbacks.onSpeakApproved();
      break;
    }

    case 'speakDenied': {
      if (!canAccessContent()) return;
      hostDebugLog(`speakDenied`, 'warn');
      if (callbacks.onChat) callbacks.onChat('system', 'システム', data.reason || '登壇リクエストが却下されました');
      break;
    }

    case 'speakerJoined': {
      if (!canAccessContent()) return;
      const speakerJoinedId = data.odUserId || data.userId;
      const speakerJoinedName = data.userName || 'ゲスト';

      hostDebugLog(`登壇者: ${speakerJoinedName}`, 'info');

      if (!currentSpeakers.find((s) => s.userId === speakerJoinedId)) {
        currentSpeakers.push({ userId: speakerJoinedId, userName: speakerJoinedName });
      }

      if (data.speakers) updateSpeakerList(data.speakers);
      if (callbacks.onSpeakerJoined) callbacks.onSpeakerJoined(speakerJoinedId, speakerJoinedName);
      if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);

      checkAndShowAudioOverlay();
      break;
    }

    case 'speakerLeft': {
      if (!canAccessContent()) return;
      const leftUserId = data.odUserId || data.userId;

      hostDebugLog(`登壇者退出`, 'info');

      currentSpeakers = currentSpeakers.filter((s) => s.userId !== leftUserId);

      if (data.speakers) updateSpeakerList(data.speakers);
      if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(leftUserId);
      if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);

      if (speakerCount === 0) {
        hideAudioUnlockOverlay();
        if (isAgoraJoinedAsListener) {
          leaveAgoraChannel();
        }
      }
      break;
    }

    case 'announce': {
      if (!canAccessContent()) return;
      if (callbacks.onAnnounce) callbacks.onAnnounce(data.message);
      break;
    }

    case 'backgroundChange': {
      if (!canAccessContent()) return;
      if (callbacks.onBackgroundChange) callbacks.onBackgroundChange(data.url);
      break;
    }

    case 'brightnessChange': {
      if (!canAccessContent()) return;
      if (callbacks.onBrightnessChange) callbacks.onBrightnessChange(data.value);
      break;
    }

    case 'kicked': {
      if (!canAccessContent()) return;
      hostDebugLog('強制降壇', 'warn');
      stopSpeaking();
      if (callbacks.onKicked) callbacks.onKicked();
      if (callbacks.onChat) callbacks.onChat('system', 'システム', '主催者により登壇を終了しました');
      break;
    }

    case 'error': {
      hostDebugLog(`エラー: ${data.code || data.message}`, 'error');
      break;
    }

    default: {
      break;
    }
  }
}

// --------------------------------------------
// 音声オーバーレイ表示チェック
// --------------------------------------------
function checkAndShowAudioOverlay() {
  if (speakerCount > 0 && !isSpeaker && !audioUnlocked && !isAgoraJoinedAsListener) {
    hostDebugLog(`オーバーレイ表示`, 'info');
    showAudioUnlockOverlay();
  }
}

// --------------------------------------------
// 登壇者数UIを更新
// --------------------------------------------
function updateSpeakerCountUI() {
  const el = document.getElementById('speaker-count');
  if (el) el.textContent = speakerCount;
}

// --------------------------------------------
// 登壇者リスト更新
// --------------------------------------------
function updateSpeakerList(speakers) {
  const speakersArray = Array.isArray(speakers) ? speakers : [];

  if (isSpeaker && !speakersArray.includes(myServerConnectionId)) {
    speakersArray.push(myServerConnectionId);
  }

  speakerCount = speakersArray.length;
  updateSpeakerButton();
  updateSpeakerCountUI();

  currentSpeakers = speakersArray.map((id) => {
    const existing = currentSpeakers.find((s) => s.userId === id);
    if (existing) return existing;

    if (id === myServerConnectionId) return { userId: id, userName: currentUserName };
    const userData = callbacks.remoteAvatars?.get(id);
    return { userId: id, userName: userData?.userName || 'ゲスト' };
  });

  if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);

  if (callbacks.remoteAvatars) {
    callbacks.remoteAvatars.forEach((userData, odUserId) => {
      if (userData && userData.avatar) {
        if (speakersArray.includes(odUserId)) addSpeakerIndicator(userData.avatar);
        else removeSpeakerIndicator(userData.avatar);
      }
    });
  }

  if (speakerCount === 0 && isAgoraJoinedAsListener) {
    leaveAgoraChannel();
  }
}

// --------------------------------------------
// Agora共通イベントリスナー設定（音量80倍増幅）
// --------------------------------------------
function setupAgoraEventListeners() {
  if (!agoraClient) return;

  agoraClient.on('user-published', async (user, mediaType) => {
    if (mediaType === 'audio') {
      await agoraClient.subscribe(user, mediaType);
      hostDebugLog(`購読: ${user.uid}`, 'success');
      
      const audioTrack = user.audioTrack;
      if (audioTrack) {
        let playedViaWebAudio = false;
        
        try {
          if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }
          
          const mediaStreamTrack = audioTrack.getMediaStreamTrack();
          if (mediaStreamTrack) {
            const mediaStream = new MediaStream([mediaStreamTrack]);
            const source = audioContext.createMediaStreamSource(mediaStream);
            
            const gainNode = audioContext.createGain();
            gainNode.gain.value = 80.0;
            
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            user._webAudioSource = source;
            user._webAudioGain = gainNode;
            
            playedViaWebAudio = true;
            hostDebugLog(`WebAudio(80x): ${user.uid}`, 'success');
          }
        } catch (e) {
          hostDebugLog(`WebAudio失敗`, 'warn');
        }
        
        if (!playedViaWebAudio) {
          try {
            const mediaStreamTrack = audioTrack.getMediaStreamTrack();
            if (mediaStreamTrack) {
              const mediaStream = new MediaStream([mediaStreamTrack]);
              
              const audioEl = document.createElement('audio');
              audioEl.srcObject = mediaStream;
              audioEl.setAttribute('playsinline', 'true');
              audioEl.setAttribute('autoplay', 'true');
              audioEl.volume = 1.0;
              audioEl.style.display = 'none';
              document.body.appendChild(audioEl);
              
              await audioEl.play();
              user._audioElement = audioEl;
              
              hostDebugLog(`Audio要素: ${user.uid}`, 'success');
            }
          } catch (e2) {
            audioTrack.play();
            hostDebugLog(`デフォルト: ${user.uid}`, 'info');
          }
        }
      }
      
      remoteUsers.set(user.uid, user);
    }
  });

  agoraClient.on('user-unpublished', (user, mediaType) => {
    if (mediaType === 'audio') {
      if (user._webAudioSource) {
        try { user._webAudioSource.disconnect(); } catch (_) {}
        user._webAudioSource = null;
      }
      if (user._webAudioGain) {
        try { user._webAudioGain.disconnect(); } catch (_) {}
        user._webAudioGain = null;
      }
      if (user._audioElement) {
        try {
          user._audioElement.pause();
          user._audioElement.srcObject = null;
          user._audioElement.remove();
        } catch (_) {}
        user._audioElement = null;
      }
      
      remoteUsers.delete(user.uid);
    }
  });

  agoraClient.on('user-left', (user) => {
    if (user._webAudioSource) {
      try { user._webAudioSource.disconnect(); } catch (_) {}
    }
    if (user._webAudioGain) {
      try { user._webAudioGain.disconnect(); } catch (_) {}
    }
    if (user._audioElement) {
      try {
        user._audioElement.pause();
        user._audioElement.srcObject = null;
        user._audioElement.remove();
      } catch (_) {}
    }
    
    remoteUsers.delete(user.uid);
  });
}

// --------------------------------------------
// Agora音声通話（登壇者用）
// --------------------------------------------
async function joinAgoraChannel() {
  hostDebugLog(`Agora(登壇者, ${agoraMode})`, 'info');

  try {
    const AgoraRTC = window.AgoraRTC;
    if (!AgoraRTC) {
      hostDebugLog('SDK未読み込み', 'error');
      return;
    }

    agoraClient = AgoraRTC.createClient({ 
      mode: agoraMode, 
      codec: 'vp8' 
    });

    setupAgoraEventListeners();

    if (agoraMode === 'live') {
      await agoraClient.setClientRole('host');
    }

    const uid = await agoraClient.join(AGORA_APP_ID, AGORA_CHANNEL, null, null);
    hostDebugLog(`参加成功: ${uid}`, 'success');

    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
      encoderConfig: 'high_quality_stereo',
      ANS: false,
      AEC: false,
      AGC: false
    });
    
    await agoraClient.publish([localAudioTrack]);
    hostDebugLog('配信開始', 'success');

    isAgoraJoinedAsListener = false;

  } catch (e) {
    hostDebugLog(`エラー: ${e?.message}`, 'error');
  }
}

// --------------------------------------------
// Agora音声受信（視聴者用）
// --------------------------------------------
async function joinAgoraAsListener() {
  if (isAgoraJoinedAsListener || isSpeaker) return;

  hostDebugLog(`Agora(視聴者, ${agoraMode})`, 'info');

  try {
    const AgoraRTC = window.AgoraRTC;
    if (!AgoraRTC) {
      hostDebugLog('SDK未読み込み', 'error');
      return;
    }

    agoraClient = AgoraRTC.createClient({ 
      mode: agoraMode, 
      codec: 'vp8' 
    });

    setupAgoraEventListeners();

    if (agoraMode === 'live') {
      await agoraClient.setClientRole('audience');
    }

    const uid = await agoraClient.join(AGORA_APP_ID, AGORA_CHANNEL, null, null);
    hostDebugLog(`視聴者参加: ${uid}`, 'success');

    isAgoraJoinedAsListener = true;

  } catch (e) {
    hostDebugLog(`エラー: ${e?.message}`, 'error');
  }
}

// --------------------------------------------
// Agoraチャンネル退出
// --------------------------------------------
async function leaveAgoraChannel() {
  try {
    if (localAudioTrack) {
      localAudioTrack.stop();
      localAudioTrack.close();
      localAudioTrack = null;
    }

    remoteUsers.forEach((user) => {
      if (user._webAudioSource) {
        try { user._webAudioSource.disconnect(); } catch (_) {}
      }
      if (user._webAudioGain) {
        try { user._webAudioGain.disconnect(); } catch (_) {}
      }
      if (user._audioElement) {
        try {
          user._audioElement.pause();
          user._audioElement.srcObject = null;
          user._audioElement.remove();
        } catch (_) {}
      }
    });

    if (agoraClient) {
      await agoraClient.leave();
      agoraClient = null;
    }

    remoteUsers.clear();
    isAgoraJoinedAsListener = false;

  } catch (e) {
    hostDebugLog(`退出エラー`, 'error');
  }
}

// --------------------------------------------
// 音声通話
// --------------------------------------------
export function requestSpeak() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!canAccessContent()) return;

  if (isSpeaker) {
    stopSpeaking();
    return;
  }

  socket.send(JSON.stringify({ type: 'requestSpeak' }));
}

export function stopSpeaking() {
  if (isSpeaker) {
    currentSpeakers = currentSpeakers.filter((s) => s.userId !== myServerConnectionId);
    speakerCount = Math.max(0, currentSpeakers.length);
    updateSpeakerCountUI();
    if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
  }

  isSpeaker = false;
  isMicMuted = false;
  updateSpeakerButton();

  leaveAgoraChannel();

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stopSpeak' }));
  }

  if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(myServerConnectionId);
}

function updateSpeakerButton() {
  const btn = document.getElementById('request-stage-btn');
  const btnPanel = document.getElementById('request-stage-btn-panel');

  const updateBtn = (b) => {
    if (!b) return;
    if (isSpeaker) {
      b.textContent = `🎤 登壇中 (${speakerCount}/5)`;
      b.style.background = 'linear-gradient(135deg, #00c853, #69f0ae)';
    } else {
      b.textContent = `🎤 登壇リクエスト (${speakerCount}/5)`;
      b.style.background = '';
    }
  };

  updateBtn(btn);
  updateBtn(btnPanel);
}

export function toggleMic() {
  if (!canAccessContent()) return false;

  if (isSpeaker && localAudioTrack) {
    const newEnabled = !localAudioTrack.enabled;
    localAudioTrack.setEnabled(newEnabled);
    isMicMuted = !newEnabled;
    return newEnabled;
  }
  return false;
}

// --------------------------------------------
// 絵文字投げ
// --------------------------------------------
export function sendEmojiThrow(emoji) {
  if (!canAccessContent()) return;
  safeSend({ 
    type: 'emojiThrow', 
    emoji,
    senderId: myServerConnectionId,
    senderName: currentUserName
  });
}

// --------------------------------------------
// ピン留め
// --------------------------------------------
export function pinComment(senderId, senderName, message) {
  if (!hostAuthed) return;
  safeSend({
    type: 'pinComment',
    comment: { senderId, senderName, message }
  });
}

export function unpinComment() {
  if (!hostAuthed) return;
  safeSend({ type: 'unpinComment' });
}

// --------------------------------------------
// 送信（共通）
// --------------------------------------------
export function sendAuth(password) {
  if (!password) return false;
  return safeSend({ type: 'auth', password });
}

export function disableSecretMode() {
  if (!hostAuthed) return false;
  return safeSend({ type: 'disableSecretMode' });
}

export function setSecretMode(value) {
  if (!hostAuthed) return false;
  return safeSend({ type: 'setSecretMode', value: !!value });
}

export function sendPosition(x, y, z) {
  if (!canAccessContent()) return;
  safeSend({ type: 'position', x, y, z });
}

export function sendReaction(reaction, color) {
  if (!canAccessContent()) return;
  safeSend({ type: 'reaction', reaction, color });
}

export function sendChat(message) {
  if (!canAccessContent()) return;
  safeSend({
    type: 'chat',
    name: currentUserName,
    message: message,
    senderId: myServerConnectionId
  });
}

export function sendNameChange(newName) {
  currentUserName = newName;
  if (!canAccessContent()) return;
  safeSend({ type: 'nameChange', name: newName });
}

export function sendAvatarChange(imageUrl) {
  if (!canAccessContent()) return;
  safeSend({ type: 'avatarChange', imageUrl });
}

export function sendBackgroundChange(url) {
  if (!canAccessContent()) return;
  safeSend({ type: 'backgroundChange', url });
}

export function sendBrightness(value) {
  if (!canAccessContent()) return;
  safeSend({ type: 'brightnessChange', value });
}

export function sendAnnounce(message) {
  if (!canAccessContent()) return;
  safeSend({ type: 'announce', message });
}

// --------------------------------------------
// 主催者機能
// --------------------------------------------
export function hostLogin(password) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setHostAuthResult(false, '未接続です');
    return;
  }
  if (!password) {
    setHostAuthResult(false, 'パスワードが空です');
    return;
  }
  if (hostAuthPending) return;

  hostAuthPending = true;
  safeSend({ type: 'hostAuth', password });
}

export function hostLogout() {
  hostAuthed = false;
  hostAuthPending = false;
  isHost = false;
  hideDebugPanel();
  setHostAuthResult(false, 'ログアウトしました');
  safeSend({ type: 'hostLogout' });
}

// --------------------------------------------
// 主催者操作
// --------------------------------------------
export function approveSpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) return;
  safeSend({ type: 'approveSpeak', userId });
}

export function denySpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) return;
  safeSend({ type: 'denySpeak', userId });
}

export function kickSpeaker(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) return;
  safeSend({ type: 'kickSpeaker', userId });
}

export function getSpeakRequests() {
  return [...speakRequests];
}

export function getCurrentSpeakers() {
  return [...currentSpeakers];
}
