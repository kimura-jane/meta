// ============================================
// connection.js - PartyKit接続・音声通話（秘密会議対応版）
// ============================================

import {
  debugLog,
  isIOS,
  addSpeakerIndicator,
  removeSpeakerIndicator
} from './utils.js';

import { setHostAuthResult } from './settings.js';

// --------------------------------------------
// 設定
// --------------------------------------------
const PARTYKIT_HOST = 'kimurameta.kimura-jane.partykit.dev';
const ROOM_ID = 'main-stage';
const PARTY_NAME = null;

// --------------------------------------------
// 状態
// --------------------------------------------
let socket = null;
let connected = false;
let myServerConnectionId = null;
let turnCredentials = null;
let currentUserName = '';

let localStream = null;
let peerConnection = null;
let mySessionId = null;
let isSpeaker = false;
let isMicMuted = false;
let myPublishedTrackName = null;

const subscribedTracks = new Map();
const pendingSubscriptions = new Map();
const pendingStreams = [];

let speakerCount = 0;
let audioUnlocked = false;

let sharedAudioContext = null;
let masterGainNode = null;

const remoteAudioEls = new Map();
const pendingAudioPlays = new Set();

let speakRequests = [];
let currentSpeakers = [];

let hostAuthed = false;
let hostAuthPending = false;

let secretMode = false;
let isAuthed = false;
let isHost = false;

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
  onMyIdChanged: null
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
    subscribedTracks,
    speakRequests,
    currentSpeakers,
    hostAuthed,
    secretMode,
    isAuthed,
    isHost
  };
}

export function getMyConnectionId() {
  return myServerConnectionId;
}

// --------------------------------------------
// ICE サーバー設定
// --------------------------------------------
function getIceServers() {
  const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }];

  if (turnCredentials) {
    servers.push({
      urls: 'turn:turn.cloudflare.com:3478?transport=udp',
      username: turnCredentials.username,
      credential: turnCredentials.credential
    });
    servers.push({
      urls: 'turn:turn.cloudflare.com:3478?transport=tcp',
      username: turnCredentials.username,
      credential: turnCredentials.credential
    });
  }

  return servers;
}

// --------------------------------------------
// 共有AudioContext管理
// --------------------------------------------
function createSharedAudioContext() {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext;
  }

  try {
    sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000
    });

    masterGainNode = sharedAudioContext.createGain();
    masterGainNode.gain.value = 1.0;
    masterGainNode.connect(sharedAudioContext.destination);

    debugLog(`SharedAudioContext作成: state=${sharedAudioContext.state}`, 'info');
    return sharedAudioContext;
  } catch (e) {
    debugLog(`SharedAudioContext作成失敗: ${e?.message || e}`, 'error');
    return null;
  }
}

async function unlockAudioContext() {
  if (audioUnlocked && sharedAudioContext && sharedAudioContext.state === 'running') {
    return true;
  }

  if (!sharedAudioContext) createSharedAudioContext();
  if (!sharedAudioContext) return false;

  try {
    if (sharedAudioContext.state === 'suspended') {
      debugLog('AudioContext resume試行...', 'info');
      await sharedAudioContext.resume();
      debugLog(`AudioContext resume完了: state=${sharedAudioContext.state}`, 'success');
    }

    if (sharedAudioContext.state === 'running') {
      audioUnlocked = true;
      debugLog('AudioContextアンロック成功', 'success');

      connectPendingStreams();
      tryPlayPendingAudioEls();

      const btn = document.getElementById('audio-unlock-btn');
      if (btn) btn.remove();

      return true;
    }
    debugLog(`AudioContextがrunningにならない: ${sharedAudioContext.state}`, 'error');
    return false;
  } catch (e) {
    debugLog(`AudioContext resume失敗: ${e?.message || e}`, 'error');
    return false;
  }
}

function connectPendingStreams() {
  if (!sharedAudioContext || sharedAudioContext.state !== 'running') return;

  debugLog(`待機中ストリーム接続: ${pendingStreams.length}件`, 'info');
  while (pendingStreams.length > 0) {
    const { stream, trackName, odUserId } = pendingStreams.shift();
    connectStreamPlayback(stream, trackName, odUserId);
  }
}

function connectStreamPlayback(stream, trackName, odUserId) {
  if (isIOS()) return connectStreamToAudioElement(stream, trackName, odUserId);
  return connectStreamToAudioContext(stream, trackName, odUserId);
}

function connectStreamToAudioContext(stream, trackName, odUserId) {
  if (!sharedAudioContext || sharedAudioContext.state !== 'running') {
    pendingStreams.push({ stream, trackName, odUserId });
    showAudioUnlockButton();
    return false;
  }

  try {
    const source = sharedAudioContext.createMediaStreamSource(stream);
    const gainNode = sharedAudioContext.createGain();
    gainNode.gain.value = 1.0;

    source.connect(gainNode);
    gainNode.connect(masterGainNode);

    const trackInfo = subscribedTracks.get(trackName);
    if (trackInfo) {
      trackInfo.source = source;
      trackInfo.gainNode = gainNode;
    }

    debugLog(`ストリーム接続(WebAudio)成功: ${trackName}`, 'success');

    if (callbacks.remoteAvatars && odUserId) {
      const userData = callbacks.remoteAvatars.get(odUserId);
      if (userData && userData.avatar) addSpeakerIndicator(userData.avatar);
    }

    return true;
  } catch (e) {
    debugLog(`ストリーム接続(WebAudio)失敗: ${e?.message || e}`, 'error');
    return false;
  }
}

function ensureRemoteAudioEl(trackName) {
  let el = remoteAudioEls.get(trackName);
  if (el) return el;

  el = document.createElement('audio');
  el.autoplay = true;
  el.playsInline = true;
  el.muted = false;
  el.controls = false;
  el.style.cssText = 'position:fixed; left:-9999px; top:-9999px; width:1px; height:1px; opacity:0;';

  document.body.appendChild(el);
  remoteAudioEls.set(trackName, el);
  return el;
}

function connectStreamToAudioElement(stream, trackName, odUserId) {
  const el = ensureRemoteAudioEl(trackName);
  el.srcObject = stream;
  el.volume = 1.0;

  const trackInfo = subscribedTracks.get(trackName);
  if (trackInfo) trackInfo.audioEl = el;

  el.play().then(() => {
    pendingAudioPlays.delete(trackName);
    debugLog(`ストリーム接続(<audio>)成功: ${trackName}`, 'success');
  }).catch((e) => {
    pendingAudioPlays.add(trackName);
    debugLog(`audio.play失敗: ${trackName} / ${e?.message || e}`, 'warn');
    showAudioUnlockButton();
  });

  if (callbacks.remoteAvatars && odUserId) {
    const userData = callbacks.remoteAvatars.get(odUserId);
    if (userData && userData.avatar) addSpeakerIndicator(userData.avatar);
  }

  return true;
}

function tryPlayPendingAudioEls() {
  if (pendingAudioPlays.size === 0) return;
  for (const trackName of Array.from(pendingAudioPlays)) {
    const el = remoteAudioEls.get(trackName);
    if (!el) continue;
    el.play().then(() => {
      pendingAudioPlays.delete(trackName);
      debugLog(`pending audio.play成功: ${trackName}`, 'success');
    }).catch(() => {});
  }
}

// --------------------------------------------
// 音声アンロックボタン（iOS Safari用）
// --------------------------------------------
function showAudioUnlockButton() {
  if (audioUnlocked && sharedAudioContext && sharedAudioContext.state === 'running') return;

  const existing = document.getElementById('audio-unlock-btn');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = 'audio-unlock-btn';
  btn.textContent = '🔊 タップして音声を有効化';
  btn.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 20px 40px;
    font-size: 18px;
    background: linear-gradient(135deg, #ff66ff, #9966ff);
    color: white;
    border: none;
    border-radius: 20px;
    z-index: 20000;
    cursor: pointer;
    box-shadow: 0 4px 30px rgba(255, 102, 255, 0.5);
  `;

  btn.onclick = async () => {
    debugLog('音声アンロックボタン押下', 'info');
    const ok = await unlockAudioContext();
    if (ok) debugLog('音声アンロック完了', 'success');
    else debugLog('音声アンロック失敗', 'error');
  };

  document.body.appendChild(btn);
}

let audioUnlockSetupDone = false;

function setupAudioUnlockOnce() {
  if (audioUnlockSetupDone) return;
  audioUnlockSetupDone = true;

  createSharedAudioContext();

  const handleUserGesture = async () => {
    if (!audioUnlocked || !sharedAudioContext || sharedAudioContext.state !== 'running') {
      await unlockAudioContext();
    } else {
      tryPlayPendingAudioEls();
    }
  };

  document.addEventListener('touchstart', handleUserGesture, { passive: true });
  document.addEventListener('touchend', handleUserGesture, { passive: true });
  document.addEventListener('click', handleUserGesture);
}

// --------------------------------------------
// WebSocket URL
// --------------------------------------------
function buildWsUrl(userName) {
  const base = `wss://${PARTYKIT_HOST}`;
  const room = encodeURIComponent(ROOM_ID);
  const name = encodeURIComponent(userName);

  const path = PARTY_NAME
    ? `/parties/${encodeURIComponent(PARTY_NAME)}/${room}`
    : `/party/${room}`;

  return `${base}${path}?name=${name}`;
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

function cleanupSubscriptions() {
  subscribedTracks.forEach((obj) => {
    if (obj.source) { try { obj.source.disconnect(); } catch(_) {} }
    if (obj.gainNode) { try { obj.gainNode.disconnect(); } catch(_) {} }
    if (obj.pc) { try { obj.pc.close(); } catch(_) {} }
    if (obj.audioEl) {
      try { obj.audioEl.srcObject = null; } catch(_) {}
    }
  });
  subscribedTracks.clear();
  pendingSubscriptions.clear();
  pendingStreams.length = 0;

  for (const [trackName, el] of remoteAudioEls) {
    try { el.srcObject = null; } catch(_) {}
    try { el.remove(); } catch(_) {}
    remoteAudioEls.delete(trackName);
    pendingAudioPlays.delete(trackName);
  }
}

// --------------------------------------------
// PartyKit接続
// --------------------------------------------
export function connectToPartyKit(userName) {
  currentUserName = userName;

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    try { socket.close(1000, 'reconnect'); } catch(_) {}
  }
  socket = null;

  wantReconnect = true;
  clearReconnectTimer();

  // 接続ごとに状態リセット
  isAuthed = false;
  secretMode = false;
  isHost = false;
  hostAuthed = false;
  hostAuthPending = false;
  myServerConnectionId = null;

  const wsUrl = buildWsUrl(userName);
  debugLog(`[Connection] 接続開始: ${wsUrl}`, 'info');

  setupAudioUnlockOnce();

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

    cleanupSubscriptions();

    isAuthed = false;
    secretMode = false;
    isHost = false;
    hostAuthed = false;
    hostAuthPending = false;

    setHostAuthResult(false, '接続が切れたため主催者状態を解除しました');

    if (ev.code === 1000 || ev.code === 1001) return;

    scheduleReconnect();
  };

  socket.onerror = () => {
    debugLog('[Connection] WebSocketエラー', 'error');
  };
}

export function disconnectPartyKit() {
  wantReconnect = false;
  clearReconnectTimer();
  if (socket) {
    try { socket.close(1000, 'manual'); } catch(_) {}
  }
  socket = null;
  connected = false;
  cleanupSubscriptions();
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

      // IDが変わったことを通知
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

      // IDが変わったことを通知
      if (callbacks.onMyIdChanged && oldId !== myServerConnectionId) {
        callbacks.onMyIdChanged(oldId, myServerConnectionId);
      }

      if (data.turnCredentials) {
        turnCredentials = data.turnCredentials;
        debugLog('[Connection] TURN認証情報取得', 'success');
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

      if (data.tracks && data.sessions) {
        const tracksArray = Array.isArray(data.tracks) ? data.tracks : [];
        const sessionsArray = Array.isArray(data.sessions) ? data.sessions : [];
        const sessionsMap = new Map(sessionsArray);

        setTimeout(() => {
          tracksArray.forEach(([odUserId, trackName]) => {
            if (odUserId === myServerConnectionId) return;
            const speakerSessionId = sessionsMap.get(odUserId);
            if (speakerSessionId) subscribeToTrack(odUserId, speakerSessionId, trackName);
          });
        }, 500);
      }

      break;
    }

    case 'authOk': {
      isAuthed = true;
      debugLog('[Connection] authOk: 入室認証OK', 'success');
      if (callbacks.onAuthOk) callbacks.onAuthOk();
      safeSend({ type: 'requestInit' });
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

      safeSend({ type: 'requestInit' });
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
      removeRemoteAudio(leaveUserId);
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

    case 'speakApproved': {
      if (!canAccessContent()) return;
      mySessionId = data.sessionId;
      isSpeaker = true;

      if (!currentSpeakers.find((s) => s.userId === myServerConnectionId)) {
        currentSpeakers.push({ userId: myServerConnectionId, userName: currentUserName });
      }

      speakerCount = currentSpeakers.length;
      updateSpeakerButton();
      updateSpeakerCountUI();

      if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);

      startPublishing();
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
      break;
    }

    case 'speakerLeft': {
      if (!canAccessContent()) return;
      const leftUserId = data.odUserId || data.userId;

      currentSpeakers = currentSpeakers.filter((s) => s.userId !== leftUserId);

      if (data.speakers) updateSpeakerList(data.speakers);
      removeRemoteAudio(leftUserId);
      if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(leftUserId);
      if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
      break;
    }

    case 'trackPublished': {
      if (!canAccessContent()) return;
      handleTrackPublished(data);
      break;
    }

    case 'newTrack': {
      if (!canAccessContent()) return;

      const trackUserId = data.odUserId || data.userId;
      const newTrackName = data.trackName;

      if (trackUserId === myServerConnectionId) return;
      if (myPublishedTrackName && newTrackName === myPublishedTrackName) return;

      if (!audioUnlocked || !sharedAudioContext || sharedAudioContext.state !== 'running') {
        showAudioUnlockButton();
      }

      setTimeout(() => {
        subscribeToTrack(trackUserId, data.sessionId, newTrackName);
      }, 250);
      break;
    }

    case 'subscribed': {
      if (!canAccessContent()) return;
      handleSubscribed(data);
      break;
    }

    case 'subscribeAnswerAck': {
      if (!canAccessContent()) return;
      debugLog('[Connection] Answer確認OK', 'success');
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
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (isSpeaker) {
    currentSpeakers = currentSpeakers.filter((s) => s.userId !== myServerConnectionId);
    speakerCount = Math.max(0, currentSpeakers.length);
    updateSpeakerCountUI();
    if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
  }

  isSpeaker = false;
  isMicMuted = false;
  mySessionId = null;
  myPublishedTrackName = null;
  updateSpeakerButton();

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stopSpeak' }));
  }

  if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(myServerConnectionId);
}

async function startPublishing() {
  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため publish をブロック', 'warn');
    stopSpeaking();
    return;
  }

  try {
    debugLog('[Connection] マイク取得開始...', 'info');

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0.01,
        sampleRate: 48000,
        channelCount: 1
      },
      video: false
    });

    debugLog('[Connection] マイク取得成功', 'success');

    await unlockAudioContext();

    peerConnection = new RTCPeerConnection({
      iceServers: getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('No audio track');

    const transceiver = peerConnection.addTransceiver(audioTrack, {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: 128000, priority: 'high' }]
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    let mid = transceiver.mid;
    if (!mid) {
      const sdp = peerConnection.localDescription?.sdp || '';
      const midMatch = sdp.match(/a=mid:(\S+)/);
      mid = midMatch ? midMatch[1] : '0';
    }

    const trackName = `audio-${myServerConnectionId}`;
    myPublishedTrackName = trackName;

    debugLog(`[Connection] トラック公開: ${trackName}`, 'info');

    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Socket not open');

    socket.send(JSON.stringify({
      type: 'publishTrack',
      sessionId: mySessionId,
      offer: { sdp: peerConnection.localDescription.sdp, type: 'offer' },
      tracks: [{ location: 'local', mid: mid, trackName: trackName }]
    }));

  } catch (error) {
    debugLog(`[Connection] publishエラー: ${error?.message || error}`, 'error');
    stopSpeaking();
  }
}

async function handleTrackPublished(data) {
  if (!peerConnection || !data.answer) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    debugLog('[Connection] トラック公開完了', 'success');
  } catch (e) {
    debugLog(`[Connection] setRemoteDescriptionエラー: ${e?.message || e}`, 'error');
  }
}

async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため subscribeToTrack をブロック', 'warn');
    return;
  }

  if (odUserId === myServerConnectionId) return;
  if (trackName === myPublishedTrackName) return;
  if (subscribedTracks.has(trackName)) return;
  if (pendingSubscriptions.has(trackName)) return;

  debugLog(`[Connection] トラック購読開始: ${trackName}`, 'info');

  pendingSubscriptions.set(trackName, { odUserId, remoteSessionId });

  socket.send(JSON.stringify({
    type: 'subscribeTrack',
    remoteSessionId: remoteSessionId,
    trackName: trackName
  }));
}

function waitIceGatheringComplete(pc, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }

    const timeout = setTimeout(() => resolve(), timeoutMs);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        clearTimeout(timeout);
        resolve();
      }
    };
  });
}

async function handleSubscribed(data) {
  if (!canAccessContent()) return;
  if (!data.offer) return;

  const trackName = data.trackName;
  const pendingInfo = pendingSubscriptions.get(trackName);
  if (!pendingInfo) return;

  debugLog(`[Connection] 購読処理: ${trackName}`, 'info');

  try {
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (_) {}

    pc.ontrack = (event) => {
      debugLog(`[Connection] 音声トラック受信: ${trackName}`, 'success');

      const stream = event.streams?.[0] || new MediaStream([event.track]);

      if (!audioUnlocked || !sharedAudioContext || sharedAudioContext.state !== 'running') {
        showAudioUnlockButton();
      }
      connectStreamPlayback(stream, trackName, pendingInfo.odUserId);
    };

    const offerSdp = typeof data.offer === 'string' ? data.offer : data.offer.sdp;
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await waitIceGatheringComplete(pc, 1500);

    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Socket not open');

    socket.send(JSON.stringify({
      type: 'subscribeAnswer',
      sessionId: data.sessionId,
      answer: { type: 'answer', sdp: pc.localDescription.sdp }
    }));

    pendingSubscriptions.delete(trackName);

    subscribedTracks.set(trackName, {
      odUserId: pendingInfo.odUserId,
      pc: pc,
      sessionId: data.sessionId,
      source: null,
      gainNode: null,
      audioEl: null
    });

    debugLog(`[Connection] 購読完了: ${trackName}`, 'success');

  } catch (e) {
    debugLog(`[Connection] handleSubscribedエラー: ${e?.message || e}`, 'error');
    pendingSubscriptions.delete(trackName);
  }
}

function removeRemoteAudio(odUserId) {
  for (const [trackName, obj] of subscribedTracks) {
    if (obj.odUserId === odUserId) {
      debugLog(`[Connection] 音声削除: ${trackName}`, 'info');

      if (obj.source) { try { obj.source.disconnect(); } catch(_) {} }
      if (obj.gainNode) { try { obj.gainNode.disconnect(); } catch(_) {} }
      if (obj.pc) { try { obj.pc.close(); } catch(_) {} }

      if (obj.audioEl) {
        try { obj.audioEl.srcObject = null; } catch(_) {}
        try { obj.audioEl.remove(); } catch(_) {}
        remoteAudioEls.delete(trackName);
        pendingAudioPlays.delete(trackName);
      }

      subscribedTracks.delete(trackName);
    }
  }

  for (const [trackName, obj] of pendingSubscriptions) {
    if (obj.odUserId === odUserId) pendingSubscriptions.delete(trackName);
  }

  for (let i = pendingStreams.length - 1; i >= 0; i--) {
    if (pendingStreams[i].odUserId === odUserId) pendingStreams.splice(i, 1);
  }
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

  if (isSpeaker && localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      isMicMuted = !audioTrack.enabled;
      debugLog(`[Connection] マイク: ${isMicMuted ? 'OFF' : 'ON'}`, 'info');
      return !isMicMuted;
    }
  }
  return false;
}

// --------------------------------------------
// 送信（共通）
// --------------------------------------------
function safeSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  debugLog(`[Connection] safeSend失敗: socket not open`, 'warn');
  return false;
}

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
  socket.send(JSON.stringify({ type: 'hostAuth', password }));
}

export function hostLogout() {
  debugLog('[Connection] hostLogout called', 'info');
  hostAuthed = false;
  hostAuthPending = false;
  isHost = false;
  setHostAuthResult(false, 'ログアウトしました');
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'hostLogout' }));
  }
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
  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため approveSpeak をブロック', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type: 'approveSpeak', userId }));
}

export function denySpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため denySpeak をブロック', 'warn');
    return;
  }
  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため denySpeak をブロック', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type: 'denySpeak', userId }));
}

export function kickSpeaker(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('[Connection] 主催者未認証のため kickSpeaker をブロック', 'warn');
    return;
  }
  if (!canAccessContent()) {
    debugLog('[Connection] 未認証のため kickSpeaker をブロック', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type: 'kickSpeaker', userId }));
}

export function getSpeakRequests() {
  return [...speakRequests];
}

export function getCurrentSpeakers() {
  return [...currentSpeakers];
}
