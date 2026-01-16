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

// ピン留め
let pinnedComment = null;

// beforeunload重複登録防止
let beforeUnloadRegistered = false;

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
// Agoraモード切り替え
// --------------------------------------------
export function getAgoraMode() {
  return agoraMode;
}

export function setAgoraMode(mode) {
  if (mode !== 'rtc' && mode !== 'live') {
    debugLog(`[Agora] 無効なモード: ${mode}`, 'error');
    return false;
  }
  
  const oldMode = agoraMode;
  if (oldMode === mode) {
    debugLog(`[Agora] モード変更なし: ${mode}`, 'info');
    return true;
  }
  
  const wasInChannel = agoraClient !== null;
  const wasSpeaker = isSpeaker;
  const wasListener = isAgoraJoinedAsListener;
  
  agoraMode = mode;
  localStorage.setItem('agoraMode', mode);
  debugLog(`[Agora] モード変更: ${oldMode} → ${mode}`, 'success');
  
  if (callbacks.onAgoraModeChange) {
    callbacks.onAgoraModeChange(mode);
  }
  
  // チャンネルに参加中なら再接続
  if (wasInChannel) {
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

  debugLog(`再接続予約: ${delay}ms (attempt=${reconnectAttempt})`, 'warn');

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
  debugLog(`[Connection] safeSend失敗: socket not open`, 'warn');
  return false;
}

// --------------------------------------------
// iOS音声アンロック用ダミー再生
// --------------------------------------------
async function unlockAudioForIOS() {
  try {
    const audio = new Audio();
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    audio.volume = 0.01;
    audio.playsInline = true;
    await audio.play();
    audio.pause();
    audio.remove();
    debugLog('[Audio] iOSスピーカーアンロック成功', 'success');
    return true;
  } catch (e) {
    debugLog(`[Audio] iOSスピーカーアンロック失敗: ${e?.message || e}`, 'warn');
    return false;
  }
}

// --------------------------------------------
// 音声再生オーバーレイ制御
// --------------------------------------------
function showAudioUnlockOverlay() {
  const overlay = document.getElementById('audio-unlock-overlay');
  if (overlay) {
    overlay.classList.add('show');
    debugLog('[Audio] タップして視聴オーバーレイを表示', 'info');
  }
}

function hideAudioUnlockOverlay() {
  const overlay = document.getElementById('audio-unlock-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    debugLog('[Audio] タップして視聴オーバーレイを非表示', 'info');
  }
}

function initAudioUnlockOverlay() {
  const overlay = document.getElementById('audio-unlock-overlay');
  if (overlay && !overlay.dataset.initialized) {
    overlay.dataset.initialized = 'true';
    overlay.addEventListener('click', async () => {
      debugLog('[Audio] オーバーレイがクリックされました', 'info');
      
      await unlockAudioForIOS();
      
      audioUnlocked = true;
      hideAudioUnlockOverlay();
      
      if (speakerCount > 0 && !isSpeaker && !isAgoraJoinedAsListener) {
        joinAgoraAsListener();
      }
    });
  }
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
  debugLog(`[Connection] 接続開始: ${wsUrl}`, 'info');

  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    debugLog(`[Connection] WebSocket作成エラー: ${e?.message || e}`, 'error');
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    connected = true;
    reconnectAttempt = 0;
    debugLog('[Connection] PartyKit接続成功', 'success');
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);

    initAudioUnlockOverlay();
    setupBeforeUnload();

    debugLog('[Connection] requestInit 送信', 'info');
    safeSend({ type: 'requestInit', userName: currentUserName });
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'position') debugLog(`[Connection] 受信: ${data.type}`, 'info');
      handleServerMessage(data);
    } catch (e) {
      debugLog(`[Connection] メッセージ解析エラー: ${e?.message || e}`, 'error');
    }
  };

  socket.onclose = (ev) => {
    debugLog(`[Connection] 接続切断 code=${ev.code} reason=${ev.reason || '(none)'}`, 'warn');

    connected = false;
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(false);

    isAuthed = false;
    secretMode = false;
    isHost = false;
    hostAuthed = false;
    hostAuthPending = false;

    leaveAgoraChannel();

    setHostAuthResult(false, '接続が切れたため主催者状態を解除しました');

    if (ev.code === 1000 || ev.code === 1001) return;
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    debugLog(`[Connection] WebSocketエラー: ${err}`, 'error');
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

      debugLog(`[Connection] initMin: ID=${myServerConnectionId}, secretMode=${secretMode}, isHost=${isHost}, isAuthed=${isAuthed}`, 'success');

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

      debugLog(`[Connection] init: ID=${myServerConnectionId}, ${Object.keys(data.users || {}).length}人, secretMode=${secretMode}, isAuthed=${isAuthed}`, 'success');

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
      debugLog('[Connection] authOk: 入室認証OK', 'success');
      if (callbacks.onAuthOk) callbacks.onAuthOk();
      safeSend({ type: 'requestInit', userName: currentUserName });
      break;
    }

    case 'authNg': {
      isAuthed = false;
      debugLog('[Connection] authNg: 入室認証NG', 'warn');
      if (callbacks.onAuthNg) callbacks.onAuthNg();
      break;
    }

    case 'secretModeChanged': {
      secretMode = !!data.value;
      if (data.isAuthed !== undefined) isAuthed = !!data.isAuthed;

      debugLog(`[Connection] secretModeChanged: ${secretMode} (isAuthed=${isAuthed})`, 'info');
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
      debugLog(`[Connection] hostAuthResult: ${ok ? 'OK' : 'NG'} ${reason}, isHost=${isHost}, isAuthed=${isAuthed}`, ok ? 'success' : 'warn');

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
      debugLog(`[Connection] emojiThrow受信: ${data.emoji}`, 'info');
      if (callbacks.onEmojiThrow) {
        callbacks.onEmojiThrow(data.emoji, data.senderId, data.senderName);
      }
      break;
    }

    case 'pinComment': {
      if (!canAccessContent()) return;
      pinnedComment = data.comment;
      debugLog(`[Connection] pinComment受信: ${JSON.stringify(pinnedComment)}`, 'info');
      if (callbacks.onPinnedComment) callbacks.onPinnedComment(pinnedComment);
      break;
    }

    case 'unpinComment': {
      if (!canAccessContent()) return;
      pinnedComment = null;
      debugLog('[Connection] unpinComment受信', 'info');
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
      debugLog('[Connection] 登壇リクエスト送信完了', 'success');
      break;
    }

    case 'speakApproved': {
      if (!canAccessContent()) return;
      debugLog('[Connection] 登壇が承認されました', 'success');

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
      debugLog(`[Connection] speakDenied: ${data.reason}`, 'warn');
      if (callbacks.onChat) callbacks.onChat('system', 'システム', data.reason || '登壇リクエストが却下されました');
      break;
    }

    case 'speakerJoined': {
      if (!canAccessContent()) return;
      const speakerJoinedId = data.odUserId || data.userId;
      const speakerJoinedName = data.userName || 'ゲスト';

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
      debugLog('[Connection] 強制降壇されました', 'warn');
      stopSpeaking();
      if (callbacks.onKicked) callbacks.onKicked();
      if (callbacks.onChat) callbacks.onChat('system', 'システム', '主催者により登壇を終了しました');
      break;
    }

    case 'error': {
      debugLog(`[Connection] サーバーエラー: ${data.code || data.message}`, 'error');
      break;
    }

    default: {
      if (data?.type) debugLog(`[Connection] 未知メッセージ: ${data.type}`, 'warn');
      break;
    }
  }
}

// --------------------------------------------
// 音声オーバーレイ表示チェック
// --------------------------------------------
function checkAndShowAudioOverlay() {
  if (speakerCount > 0 && !isSpeaker && !audioUnlocked && !isAgoraJoinedAsListener) {
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
// Agora共通イベントリスナー設定
// --------------------------------------------
function setupAgoraEventListeners() {
  if (!agoraClient) return;

  agoraClient.on('user-published', async (user, mediaType) => {
    if (mediaType === 'audio') {
      await agoraClient.subscribe(user, mediaType);
      user.audioTrack?.play();
      remoteUsers.set(user.uid, user);
      debugLog(`[Agora] ${user.uid} の音声を受信開始`, 'success');
    }
  });

  agoraClient.on('user-unpublished', (user, mediaType) => {
    if (mediaType === 'audio') {
      remoteUsers.delete(user.uid);
      debugLog(`[Agora] ${user.uid} の音声が停止`, 'info');
    }
  });

  agoraClient.on('user-left', (user) => {
    remoteUsers.delete(user.uid);
    debugLog(`[Agora] ${user.uid} が退出`, 'info');
  });
}

// --------------------------------------------
// Agora音声通話（登壇者用）
// --------------------------------------------
async function joinAgoraChannel() {
  debugLog(`[Agora] チャンネル参加開始（登壇者, mode=${agoraMode}）...`, 'info');

  try {
    const AgoraRTC = window.AgoraRTC;
    if (!AgoraRTC) {
      debugLog('[Agora] AgoraRTC SDKが読み込まれていません', 'error');
      return;
    }

    agoraClient = AgoraRTC.createClient({ 
      mode: agoraMode, 
      codec: 'vp8' 
    });

    setupAgoraEventListeners();

    // Liveモードの場合のみロール設定
    if (agoraMode === 'live') {
      await agoraClient.setClientRole('host');
    }

    const uid = await agoraClient.join(AGORA_APP_ID, AGORA_CHANNEL, null, null);
    debugLog(`[Agora] 登壇者としてチャンネル参加成功: uid=${uid}, mode=${agoraMode}`, 'success');

    // 音楽用高音質設定
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
      encoderConfig: 'high_quality_stereo',
      ANS: false,
      AEC: false,
      AGC: false
    });
    
    await agoraClient.publish([localAudioTrack]);
    debugLog(`[Agora] 音声配信開始（${agoraMode}, high_quality_stereo）`, 'success');

    isAgoraJoinedAsListener = false;

  } catch (e) {
    debugLog(`[Agora] エラー: ${e?.message || e}`, 'error');
    console.error('[Agora] 詳細エラー:', e);
  }
}

// --------------------------------------------
// Agora音声受信（視聴者用）
// --------------------------------------------
async function joinAgoraAsListener() {
  if (isAgoraJoinedAsListener || isSpeaker) return;

  debugLog(`[Agora] チャンネル参加開始（視聴者, mode=${agoraMode}）...`, 'info');

  try {
    const AgoraRTC = window.AgoraRTC;
    if (!AgoraRTC) {
      debugLog('[Agora] AgoraRTC SDKが読み込まれていません', 'error');
      return;
    }

    agoraClient = AgoraRTC.createClient({ 
      mode: agoraMode, 
      codec: 'vp8' 
    });

    setupAgoraEventListeners();

    // Liveモードの場合のみロール設定
    if (agoraMode === 'live') {
      await agoraClient.setClientRole('audience');
    }

    const uid = await agoraClient.join(AGORA_APP_ID, AGORA_CHANNEL, null, null);
    debugLog(`[Agora] 視聴者としてチャンネル参加成功: uid=${uid}, mode=${agoraMode}`, 'success');

    isAgoraJoinedAsListener = true;

  } catch (e) {
    debugLog(`[Agora] 視聴者参加エラー: ${e?.message || e}`, 'error');
    console.error('[Agora] 詳細エラー:', e);
  }
}

// --------------------------------------------
// Agoraチャンネル退出
// --------------------------------------------
async function leaveAgoraChannel() {
  debugLog('[Agora] チャンネル退出', 'info');

  try {
    if (localAudioTrack) {
      localAudioTrack.stop();
      localAudioTrack.close();
      localAudioTrack = null;
    }

    if (agoraClient) {
      await agoraClient.leave();
      agoraClient = null;
    }

    remoteUsers.clear();
    isAgoraJoinedAsListener = false;
    debugLog('[Agora] 退出完了', 'success');

  } catch (e) {
    debugLog(`[Agora] 退出エラー: ${e?.message || e}`, 'error');
  }
}

// --------------------------------------------
// 音声通話
// --------------------------------------------
export function requestSpeak() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため requestSpeak をブロック', 'warn');
    return;
  }

  if (isSpeaker) {
    stopSpeaking();
    return;
  }

  debugLog('[Connection] 登壇リクエスト送信', 'info');
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
    debugLog(`[Agora] マイク: ${isMicMuted ? 'OFF' : 'ON'}`, 'info');
    return newEnabled;
  }
  return false;
}

// --------------------------------------------
// 絵文字投げ
// --------------------------------------------
export function sendEmojiThrow(emoji) {
  if (!canAccessContent()) return;
  debugLog(`[Connection] 絵文字投げ送信: ${emoji}`, 'info');
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
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため pinComment をブロック', 'warn');
    return;
  }
  debugLog(`[Connection] ピン留め送信: ${senderName}: ${message}`, 'info');
  safeSend({
    type: 'pinComment',
    comment: { senderId, senderName, message }
  });
}

export function unpinComment() {
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため unpinComment をブロック', 'warn');
    return;
  }
  debugLog('[Connection] ピン留め解除送信', 'info');
  safeSend({ type: 'unpinComment' });
}

// --------------------------------------------
// 送信（共通）
// --------------------------------------------
export function sendAuth(password) {
  if (!password) {
    debugLog('[Connection] sendAuth: パスワードが空', 'warn');
    return false;
  }
  debugLog('[Connection] sendAuth: 入室認証送信', 'info');
  return safeSend({ type: 'auth', password });
}

export function disableSecretMode() {
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため disableSecretMode をブロック', 'warn');
    return false;
  }
  debugLog('[Connection] disableSecretMode送信', 'info');
  return safeSend({ type: 'disableSecretMode' });
}

export function setSecretMode(value) {
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため setSecretMode をブロック', 'warn');
    return false;
  }
  debugLog(`[Connection] setSecretMode送信: ${value}`, 'info');
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
  debugLog(`[Connection] sendNameChange: ${newName}`, 'info');
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
  debugLog(`[Connection] hostLogin called: connected=${connected}, hasPassword=${!!password}`, 'info');

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    debugLog('[Connection] hostLogin: ソケット未接続', 'error');
    setHostAuthResult(false, '未接続です');
    return;
  }
  if (!password) {
    debugLog('[Connection] hostLogin: パスワードが空', 'warn');
    setHostAuthResult(false, 'パスワードが空です');
    return;
  }
  if (hostAuthPending) {
    debugLog('[Connection] hostLogin: 認証中のためスキップ', 'warn');
    return;
  }

  hostAuthPending = true;
  debugLog('[Connection] hostLogin: hostAuth送信', 'info');
  safeSend({ type: 'hostAuth', password });
}

export function hostLogout() {
  debugLog('[Connection] hostLogout called', 'info');
  hostAuthed = false;
  hostAuthPending = false;
  isHost = false;
  setHostAuthResult(false, 'ログアウトしました');
  safeSend({ type: 'hostLogout' });
}

// --------------------------------------------
// 主催者操作
// --------------------------------------------
export function approveSpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため approveSpeak をブロック', 'warn');
    return;
  }
  debugLog(`[Connection] approveSpeak: ${userId}`, 'info');
  safeSend({ type: 'approveSpeak', userId });
}

export function denySpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため denySpeak をブロック', 'warn');
    return;
  }
  debugLog(`[Connection] denySpeak: ${userId}`, 'info');
  safeSend({ type: 'denySpeak', userId });
}

export function kickSpeaker(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため kickSpeaker をブロック', 'warn');
    return;
  }
  debugLog(`[Connection] kickSpeaker: ${userId}`, 'info');
  safeSend({ type: 'kickSpeaker', userId });
}

export function getSpeakRequests() {
  return [...speakRequests];
}

export function getCurrentSpeakers() {
  return [...currentSpeakers];
}
