// ============================================
// connection.js - PartyKit接続・音声通話（秘密会議対応版）
// ============================================
//
// ✅追加したこと（重要）
// 1) 秘密会議：secretMode / isAuthed / isHost を保持し、未認証をデフォルトdeny
// 2) サーバから initMin を受けて main.js に通知（callbacks.onInitMin）
// 3) 入室認証 sendAuth(pass) と authOk/authNg を処理（callbacks.onAuthOk/onAuthNg）
// 4) secretModeChanged を処理（callbacks.onSecretModeChanged）
// 5) 未認証時は「送信も受信も中身系はブロック」（クライアント側の保険）
// 6) 主催者は未認証でも解除（disableSecretMode）だけ可能（中身は不可）
//
// ※server.ts側に以下イベント/メッセージの実装が必要
// - initMin: { type:'initMin', yourId, secretMode, isHost, ... }  ※未認証には中身を載せない
// - auth:    { type:'auth', password } → authOk / authNg
// - authOk:  { type:'authOk' }  ※このあと full init を送る（init か initFull）推奨
// - authNg:  { type:'authNg' }
// - secretModeChanged: { type:'secretModeChanged', value:boolean }
// - disableSecretMode: { type:'disableSecretMode' }  ※isHostのみ許可
// - （既存）hostAuth / hostLogout / hostAuthResult
//

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

const subscribedTracks = new Map();        // trackName -> { odUserId, pc, sessionId, source, gainNode, audioEl }
const pendingSubscriptions = new Map();    // trackName -> { odUserId, remoteSessionId }
const pendingStreams = [];                 // { stream, trackName, odUserId }

let speakerCount = 0;
let audioUnlocked = false;

// 共有AudioContext（iOS Safari対策：1個だけ作成）
let sharedAudioContext = null;
let masterGainNode = null;

// iOS向け：audio要素も併用
const remoteAudioEls = new Map(); // trackName -> HTMLAudioElement
const pendingAudioPlays = new Set(); // trackName

// 登壇リクエスト・登壇者リスト
let speakRequests = [];
let currentSpeakers = [];

// 主催者認証（サーバ結果で確定）
let hostAuthed = false;
let hostAuthPending = false;

// ★秘密会議：サーバ真実
let secretMode = false;
let isAuthed = false; // 入室パスOKか（default deny）
let isHost = false;   // 主催者ログイン済みか（server管理）

function canAccessContent() {
  return !secretMode || isAuthed;
}

// コールバック
let callbacks = {
  // 既存
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

  // ★追加（main.js が期待）
  onInitMin: null,            // (data:{secretMode,isHost,authRequired?}) => void
  onAuthOk: null,             // () => void
  onAuthNg: null,             // () => void
  onSecretModeChanged: null   // (value:boolean) => void
};

export function setCallbacks(cbs) {
  callbacks = { ...callbacks, ...cbs };
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

    // ★追加（デバッグ用）
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
    debugLog(`SharedAudioContext作成失敗: ${e.message}`, 'error');
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
    debugLog(`AudioContext resume失敗: ${e.message}`, 'error');
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

// iOSはaudio要素優先
function connectStreamPlayback(stream, trackName, odUserId) {
  if (isIOS()) {
    return connectStreamToAudioElement(stream, trackName, odUserId);
  }
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
    debugLog(`ストリーム接続(WebAudio)失敗: ${e.message}`, 'error');
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
    }).catch(() => {
      // 放置（次のユーザー操作でまた試す）
    });
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

function setupAudioUnlock() {
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
// PartyKit接続
// --------------------------------------------
export function connectToPartyKit(userName) {
  currentUserName = userName;

  // 接続ごとに default deny
  isAuthed = false;
  secretMode = false;
  isHost = false;

  const wsUrl = `wss://${PARTYKIT_HOST}/party/${ROOM_ID}?name=${encodeURIComponent(userName)}`;
  debugLog(`接続開始: ${PARTYKIT_HOST}`, 'info');

  setupAudioUnlock();

  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    debugLog(`WebSocket作成エラー: ${e}`, 'error');
    return;
  }

  socket.onopen = () => {
    connected = true;
    debugLog('PartyKit接続成功', 'success');
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== 'position') debugLog(`受信: ${data.type}`, 'info');
      handleServerMessage(data);
    } catch (e) {
      debugLog(`メッセージ解析エラー: ${e}`, 'error');
    }
  };

  socket.onclose = () => {
    debugLog('接続切断 - 3秒後再接続', 'warn');

    connected = false;
    if (callbacks.onConnectedChange) callbacks.onConnectedChange(false);

    // 状態リセット（購読も全破棄）
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

    // 秘密会議：接続単位で無効
    isAuthed = false;
    secretMode = false;
    isHost = false;

    // 主催者認証はサーバ接続単位なので切断で無効
    hostAuthed = false;
    hostAuthPending = false;
    setHostAuthResult(false, '接続が切れたため主催者状態を解除しました');

    setTimeout(() => connectToPartyKit(currentUserName), 3000);
  };

  socket.onerror = () => {
    debugLog('WebSocketエラー', 'error');
  };
}

// --------------------------------------------
// サーバ受信
// --------------------------------------------
function handleServerMessage(data) {
  switch (data.type) {
    // ★秘密会議：最小初期化（未認証向け）
    // 例: { type:'initMin', yourId:'..', secretMode:true, isHost:false, authRequired:true }
    case 'initMin': {
      myServerConnectionId = data.yourId;

      // turnCredentials は未認証へ送らない（推奨）のでここでは受けない
      secretMode = !!data.secretMode;
      isHost = !!data.isHost;

      // default deny を徹底
      isAuthed = !!data.isAuthed; // もしサーバが返すなら尊重（基本false）

      debugLog(`initMin: ID=${myServerConnectionId}, secretMode=${secretMode}, isHost=${isHost}`, 'success');

      if (callbacks.onInitMin) {
        callbacks.onInitMin({
          secretMode,
          isHost,
          authRequired: data.authRequired !== undefined ? !!data.authRequired : secretMode
        });
      }
      break;
    }

    // 既存（認証後の full init）
    // ※ server.ts は secretMode=ON で未認証のクライアントには絶対送らないこと
    case 'init': {
      // 保険：secretMode ON で未認証なら無視（サーバ設計が正しければ来ない）
      if (secretMode && !isAuthed) {
        debugLog('init を未認証で受信（危険）→ 無視', 'error');
        return;
      }

      myServerConnectionId = data.yourId;
      debugLog(`初期化(init): ID=${myServerConnectionId}, ${Object.keys(data.users || {}).length}人`, 'success');

      if (data.turnCredentials) {
        turnCredentials = data.turnCredentials;
        debugLog('TURN認証情報取得', 'success');
      }

      // secretMode情報が乗ってきた場合は更新
      if (data.secretMode !== undefined) secretMode = !!data.secretMode;
      if (data.isHost !== undefined) isHost = !!data.isHost;

      // 既存ユーザー反映
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

      if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);

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

      // 既存トラック購読
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

    // ★入室認証結果
    case 'authOk': {
      isAuthed = true;
      debugLog('authOk: 入室認証OK', 'success');
      if (callbacks.onAuthOk) callbacks.onAuthOk();

      // 認証OK後に full init を要求（サーバが自動で送るなら不要だが、保険）
      safeSend({ type: 'requestInit' });
      break;
    }

    case 'authNg': {
      isAuthed = false;
      debugLog('authNg: 入室認証NG', 'warn');
      if (callbacks.onAuthNg) callbacks.onAuthNg();
      break;
    }

    // ★秘密会議のON/OFF変更
    case 'secretModeChanged': {
      secretMode = !!data.value;

      // ONになった瞬間は default deny に戻す（安全）
      if (secretMode) isAuthed = false;

      debugLog(`secretModeChanged: ${secretMode}`, 'info');
      if (callbacks.onSecretModeChanged) callbacks.onSecretModeChanged(secretMode);

      // OFFなら full init を要求しても良い
      if (!secretMode) safeSend({ type: 'requestInit' });

      break;
    }

    // --------- ここから「中身系」：未認証なら全部無視（保険） ---------
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
      debugLog(`speakDenied: ${data.reason}`, 'warn');
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
      debugLog('Answer確認OK', 'success');
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
      debugLog('強制降壇されました', 'warn');
      stopSpeaking();
      if (callbacks.onKicked) callbacks.onKicked();
      if (callbacks.onChat) callbacks.onChat('system', 'システム', '主催者により登壇を終了しました');
      break;
    }

    // ✅主催者認証結果（サーバから）※これは未認証でも受けてOK
    case 'hostAuthResult': {
      const ok = !!data.ok;
      const reason = data.reason || '';
      hostAuthed = ok;
      hostAuthPending = false;

      // server が isHost も返すなら同期しておく（推奨）
      if (data.isHost !== undefined) isHost = !!data.isHost;

      setHostAuthResult(ok, reason);
      debugLog(`hostAuthResult: ${ok ? 'OK' : 'NG'} ${reason}`, ok ? 'success' : 'warn');

      // initMin の host表示更新用に通知（mainが使う）
      if (callbacks.onInitMin) {
        callbacks.onInitMin({
          secretMode,
          isHost,
          authRequired: secretMode
        });
      }
      break;
    }

    case 'error': {
      debugLog(`サーバーエラー: ${data.code || data.message}`, 'error');
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

  // ★秘密会議：未認証ブロック
  if (!canAccessContent()) {
    debugLog('未認証のため requestSpeak をブロック', 'warn');
    return;
  }

  if (isSpeaker) {
    stopSpeaking();
    return;
  }
  debugLog('登壇リクエスト送信', 'info');
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
  // ★秘密会議：未認証でpublishさせない
  if (!canAccessContent()) {
    debugLog('未認証のため publish をブロック', 'warn');
    stopSpeaking();
    return;
  }

  try {
    debugLog('マイク取得開始...', 'info');

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

    debugLog('マイク取得成功', 'success');

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

    debugLog(`トラック公開: ${trackName}`, 'info');

    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Socket not open');

    socket.send(JSON.stringify({
      type: 'publishTrack',
      sessionId: mySessionId,
      offer: { sdp: peerConnection.localDescription.sdp, type: 'offer' },
      tracks: [{ location: 'local', mid: mid, trackName: trackName }]
    }));

  } catch (error) {
    debugLog(`publishエラー: ${error.message}`, 'error');
    stopSpeaking();
  }
}

async function handleTrackPublished(data) {
  if (!peerConnection || !data.answer) return;

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    debugLog('トラック公開完了', 'success');
  } catch (e) {
    debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
  }
}

async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  // ★秘密会議：未認証ブロック
  if (!canAccessContent()) {
    debugLog('未認証のため subscribeToTrack をブロック', 'warn');
    return;
  }

  if (odUserId === myServerConnectionId) return;
  if (trackName === myPublishedTrackName) return;
  if (subscribedTracks.has(trackName)) return;
  if (pendingSubscriptions.has(trackName)) return;

  debugLog(`トラック購読開始: ${trackName}`, 'info');

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

    const timeout = setTimeout(() => {
      resolve();
    }, timeoutMs);

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
  // ★秘密会議：未認証なら来ない想定だが保険
  if (!canAccessContent()) return;

  if (!data.offer) return;

  const trackName = data.trackName;
  const pendingInfo = pendingSubscriptions.get(trackName);
  if (!pendingInfo) return;

  debugLog(`購読処理: ${trackName}`, 'info');

  try {
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (_) {}

    pc.ontrack = (event) => {
      debugLog(`音声トラック受信: ${trackName}`, 'success');

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

    debugLog(`購読完了: ${trackName}`, 'success');

  } catch (e) {
    debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
    pendingSubscriptions.delete(trackName);
  }
}

function removeRemoteAudio(odUserId) {
  for (const [trackName, obj] of subscribedTracks) {
    if (obj.odUserId === odUserId) {
      debugLog(`音声削除: ${trackName}`, 'info');

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
      debugLog(`マイク: ${isMicMuted ? 'OFF' : 'ON'}`, 'info');
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
  return false;
}

// ★秘密会議：入室認証
export function sendAuth(password) {
  if (!password) return false;
  // これ自体は未認証でも送れる
  return safeSend({ type: 'auth', password });
}

// ★主催者：秘密会議解除（未認証でも送ってOK。ただし server が isHost を必須にする）
export function disableSecretMode() {
  return safeSend({ type: 'disableSecretMode' });
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

  // 名前変更も中身扱いにする（secretMode中未認証は送らない）
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
// 主催者機能：サーバ認証
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
  socket.send(JSON.stringify({ type: 'hostAuth', password }));
}

export function hostLogout() {
  hostAuthed = false;
  hostAuthPending = false;
  setHostAuthResult(false, 'ログアウトしました');
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'hostLogout' }));
  }
}

// --------------------------------------------
// 主催者操作（サーバでも必ず検証する想定）
// ※仕様どおり「未認証主催者は解除だけ」なら、ここは contentAllowed を必須にしておく
// --------------------------------------------
export function approveSpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('主催者未認証のため approveSpeak をブロック', 'warn');
    return;
  }
  if (!canAccessContent()) {
    debugLog('未認証のため approveSpeak をブロック（解除だけ許可）', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type: 'approveSpeak', userId }));
}

export function denySpeak(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('主催者未認証のため denySpeak をブロック', 'warn');
    return;
  }
  if (!canAccessContent()) {
    debugLog('未認証のため denySpeak をブロック（解除だけ許可）', 'warn');
    return;
  }
  socket.send(JSON.stringify({ type: 'denySpeak', userId }));
}

export function kickSpeaker(userId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!hostAuthed) {
    debugLog('主催者未認証のため kickSpeaker をブロック', 'warn');
    return;
  }
  if (!canAccessContent()) {
    debugLog('未認証のため kickSpeaker をブロック（解除だけ許可）', 'warn');
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
