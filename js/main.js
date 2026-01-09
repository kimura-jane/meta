// main.js - Metaverse空間のメインスクリプト

import {
  initVenue,
  createAllVenue,
  animateVenue,
  changeStageBackground,
  setRoomBrightness
} from './venue.js';

import {
  connectToPartyKit,
  sendPosition,
  sendReaction,
  sendChat,
  sendNameChange,
  sendAvatarChange,
  sendBackgroundChange,
  sendBrightness,
  sendAnnounce,
  requestSpeak,
  stopSpeaking,
  toggleMic,
  approveSpeak,
  denySpeak,
  kickSpeaker,
  setCallbacks,
  getState,
  getMyConnectionId,
  hostLogin,
  hostLogout,
  sendAuth,
  disableSecretMode
} from './connection.js';

import {
  initSettings,
  getSettings,
  showNotification,
  updateSpeakRequests,
  updateCurrentSpeakers,
  setHostAuthResult
} from './settings.js';

import {
  createAvatar,
  setAvatarImage,
  setAvatarSpotlight,
  createPenlight,
  addChatMessage,
  debugLog,
  createDebugUI
} from './utils.js';

// Three.js
let scene, camera, renderer;
let clock;

// -----------------------------
// ★ 秘密会議（認証状態）
// -----------------------------
let secretMode = false;
let isAuthed = false;
let isHost = false;

function isContentAllowed() {
  return !secretMode || isAuthed;
}

// -----------------------------
// ★ 認証リクエストの種類
// -----------------------------
let lastAuthRequestKind = null;

function requestAuth(kind, pass) {
  lastAuthRequestKind = kind;
  const p = (pass || '').trim();
  if (!p) return;

  try {
    if (kind === 'host') {
      hostLogin(p);
    } else {
      sendAuth(p);
    }
  } catch (e) {
    debugLog('Auth send failed', 'error');
    setAuthOverlayMessage('認証送信に失敗しました');
  }
}

// ★ 秘密会議ON/未認証時にクライアント状態を掃除
function purgeSensitiveClientState(reason = '') {
  const hasScene = !!scene;

  remoteAvatars.forEach((userData, odUserId) => {
    try {
      stopRemoteOtagei(odUserId);
    } catch (_) {}

    if (hasScene) {
      try { if (userData?.avatar) scene.remove(userData.avatar); } catch (_) {}
      try { if (userData?.penlight) scene.remove(userData.penlight); } catch (_) {}
    }
  });
  remoteAvatars.clear();

  Array.from(nameTags.keys()).forEach((id) => removeNameTag(id));

  try { updateSpeakRequests([]); } catch (_) {}
  try { updateCurrentSpeakers([]); } catch (_) {}
  try { updateSpeakerCount(0); } catch (_) {}
  try { showSpeakerControls(false); } catch (_) {}

  try {
    isOnStage = false;
    setAvatarSpotlight(myAvatar, false);
  } catch (_) {}

  try {
    isOtageiActive = false;
    stopOtageiAnimation();
  } catch (_) {}

  try {
    isPenlightActive = false;
    if (myPenlight) myPenlight.visible = false;
  } catch (_) {}

  try { updateUserCount(); } catch (_) {}

  try {
    const myId = getMyConnectionId() || myUserId;
    upsertNameTag(myId, myUserName);
  } catch (_) {}

  try {
    const existing = document.getElementById('announcement-overlay');
    if (existing) existing.remove();
  } catch (_) {}

  if (reason) debugLog(`purgeSensitiveClientState: ${reason}`, 'warn');
}

// -----------------------------
// ★ ネームタグ（DOMオーバーレイ）
// -----------------------------
const nameTags = new Map();
let nameTagLayer = null;

// アバター設定
const CHARA_LIST = ['12444', '12555', 'IMG_1677', 'IMG_1861', 'IMG_1889', 'IMG_2958', 'IMG_3264', 'IMG_3267', 'IMG_3269', 'IMG_3325', 'IMG_3326', 'IMG_3327', 'IMG_3328', 'IMG_7483', 'onigiriya_kanatake_512'];
const CHARA_EXTENSIONS = {
  '12444': 'png', '12555': 'png', 'IMG_1677': 'png', 'IMG_1861': 'png',
  'IMG_1889': 'png', 'IMG_2958': 'png', 'IMG_3264': 'png', 'IMG_3267': 'png',
  'IMG_3269': 'png', 'IMG_3325': 'png', 'IMG_3326': 'png', 'IMG_3327': 'webp',
  'IMG_3328': 'webp', 'IMG_7483': 'png', 'onigiriya_kanatake_512': 'png'
};
const CHARA_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/chara/';

// 背景設定
const STAGE_BACKGROUNDS = [
  { name: 'デフォルト', file: 'IMG_3206.jpeg', isRoot: true },
  { name: 'IMG_0967', file: 'IMG_0967.png' },
  { name: 'IMG_3273', file: 'IMG_3273.jpeg' },
  { name: 'IMG_3274', file: 'IMG_3274.jpeg' },
  { name: 'IMG_3275', file: 'IMG_3275.jpeg' },
  { name: 'IMG_9719', file: 'IMG_9719.jpeg' }
];
const STAGE_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/stage/';
const ROOT_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/';

// ローカルユーザー
let myUserId = 'user_' + Math.random().toString(36).substr(2, 9);
let myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);
let myAvatar = null;
let myPenlight = null;
let myAvatarImage = null;

// リモートユーザー
const remoteAvatars = new Map();
const remoteOtageiAnimations = new Map();

// 状態
let isOnStage = false;
let isPenlightActive = false;
let isOtageiActive = false;
let penlightColor = '#ff00ff';
let penlightLongPressTimer = null;
let otageiAnimationId = null;
let otageiBaseY = 0;

// ステージの高さ
const STAGE_Y = 1.5;

// カメラ制御
let cameraAngleX = 0;
let cameraDistance = 6;
let cameraHeight = 4;

// ジョイスティック
let joystickActive = false;
let joystickX = 0;
let joystickY = 0;

// タッチデバイス判定
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

// ペンライトアニメーション用
let penlightTime = 0;

// -----------------------------
// ★ 秘密会議 UI（オーバーレイ）
// -----------------------------
let authOverlay = null;
let authOverlayMsg = null;
let authOverlayInput = null;
let authOverlayEnterBtn = null;
let hostOverlayWrap = null;
let hostOverlayInput = null;
let hostOverlayLoginBtn = null;
let authOverlayDisableBtn = null;

function ensureAuthOverlay() {
  if (authOverlay) return;

  authOverlay = document.createElement('div');
  authOverlay.id = 'secret-auth-overlay';
  authOverlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 20000;
    background: rgba(0,0,0,0.96);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 20px;
  `;

  const card = document.createElement('div');
  card.style.cssText = `
    width: min(560px, 92vw);
    background: rgba(20,20,30,0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px;
    padding: 18px 16px;
    box-shadow: 0 18px 60px rgba(0,0,0,0.45);
    color: #fff;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans JP", sans-serif;
  `;

  const title = document.createElement('div');
  title.textContent = '🔒 秘密会議モード';
  title.style.cssText = `font-size:18px; font-weight:800; margin-bottom:10px;`;

  const desc = document.createElement('div');
  desc.textContent = '入室パスワードを入力すると、音声・チャット・参加者情報にアクセスできます。';
  desc.style.cssText = `font-size:13px; opacity:0.9; line-height:1.5; margin-bottom:14px;`;

  authOverlayMsg = document.createElement('div');
  authOverlayMsg.textContent = '';
  authOverlayMsg.style.cssText = `font-size:13px; margin: 8px 0 10px; color:#ffb3ff; min-height: 18px;`;

  authOverlayInput = document.createElement('input');
  authOverlayInput.type = 'password';
  authOverlayInput.placeholder = '入室パスワード';
  authOverlayInput.autocomplete = 'current-password';
  authOverlayInput.style.cssText = `
    width: 100%;
    box-sizing: border-box;
    padding: 12px 12px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(0,0,0,0.35);
    color: #fff;
    outline: none;
    font-size: 15px;
  `;

  const row = document.createElement('div');
  row.style.cssText = `display:flex; gap:10px; margin-top: 12px;`;

  authOverlayEnterBtn = document.createElement('button');
  authOverlayEnterBtn.textContent = '入室';
  authOverlayEnterBtn.style.cssText = `
    flex: 1;
    padding: 12px 10px;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    font-weight: 800;
    background: linear-gradient(135deg, #ff66ff, #6633ff);
    color: white;
  `;

  authOverlayDisableBtn = document.createElement('button');
  authOverlayDisableBtn.textContent = '主催者：秘密会議を解除';
  authOverlayDisableBtn.style.cssText = `
    flex: 1;
    padding: 12px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.22);
    cursor: pointer;
    font-weight: 800;
    background: rgba(255,255,255,0.08);
    color: white;
    display: none;
  `;

  row.appendChild(authOverlayEnterBtn);
  row.appendChild(authOverlayDisableBtn);

  hostOverlayWrap = document.createElement('div');
  hostOverlayWrap.style.cssText = `
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,0.12);
  `;

  const hostTitle = document.createElement('div');
  hostTitle.textContent = '👑 主催者ログイン';
  hostTitle.style.cssText = `font-size:13px; font-weight:800; margin-bottom:8px; opacity:0.95;`;

  hostOverlayInput = document.createElement('input');
  hostOverlayInput.type = 'password';
  hostOverlayInput.placeholder = '主催者パスワード';
  hostOverlayInput.autocomplete = 'current-password';
  hostOverlayInput.style.cssText = `
    width: 100%;
    box-sizing: border-box;
    padding: 12px 12px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(0,0,0,0.35);
    color: #fff;
    outline: none;
    font-size: 15px;
    margin-bottom: 10px;
  `;

  hostOverlayLoginBtn = document.createElement('button');
  hostOverlayLoginBtn.textContent = '認証中...';
  hostOverlayLoginBtn.style.cssText = `
    width: 100%;
    padding: 12px 10px;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    font-weight: 800;
    background: linear-gradient(135deg, #ffaa00, #ff5500);
    color: white;
  `;
  hostOverlayLoginBtn.textContent = '認証';

  const foot = document.createElement('div');
  foot.style.cssText = `margin-top: 12px; font-size: 12px; opacity: 0.8; line-height: 1.45;`;
  foot.textContent = '※ 認証の合否はサーバ判定です（この端末だけで主催者化しません）';

  hostOverlayWrap.appendChild(hostTitle);
  hostOverlayWrap.appendChild(hostOverlayInput);
  hostOverlayWrap.appendChild(hostOverlayLoginBtn);

  card.appendChild(title);
  card.appendChild(desc);
  card.appendChild(authOverlayMsg);
  card.appendChild(authOverlayInput);
  card.appendChild(row);
  card.appendChild(hostOverlayWrap);
  card.appendChild(foot);

  authOverlay.appendChild(card);
  document.body.appendChild(authOverlay);

  // 入室認証
  function tryRoomAuth() {
    const pass = (authOverlayInput.value || '').trim();
    if (!pass) {
      setAuthOverlayMessage('入室パスワードを入力してください');
      return;
    }
    setAuthOverlayMessage('認証中...');
    requestAuth('room', pass);
  }

  // 主催者ログイン
  function tryHostAuth() {
    const pass = (hostOverlayInput.value || '').trim();
    if (!pass) {
      setAuthOverlayMessage('主催者パスワードを入力してください');
      return;
    }
    setAuthOverlayMessage('認証中...');
    hostOverlayLoginBtn.textContent = '認証中...';
    hostOverlayLoginBtn.disabled = true;
    hostLogin(pass);
  }

  authOverlayEnterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tryRoomAuth();
  });

  authOverlayInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tryRoomAuth();
    }
  });

  hostOverlayLoginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tryHostAuth();
  });

  hostOverlayInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tryHostAuth();
    }
  });

  authOverlayDisableBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      disableSecretMode();
      setAuthOverlayMessage('解除リクエストを送信しました');
    } catch (e2) {
      setAuthOverlayMessage('解除送信に失敗しました');
    }
  });
}

function setAuthOverlayMessage(text) {
  if (authOverlayMsg) authOverlayMsg.textContent = text || '';
}

function showAuthOverlay() {
  ensureAuthOverlay();
  authOverlay.style.display = 'flex';

  if (authOverlayDisableBtn) {
    authOverlayDisableBtn.style.display = (isHost && secretMode && !isAuthed) ? 'block' : 'none';
  }

  if (hostOverlayWrap) {
    hostOverlayWrap.style.display = secretMode ? 'block' : 'none';
  }

  // ボタン状態リセット
  if (hostOverlayLoginBtn) {
    hostOverlayLoginBtn.textContent = '認証';
    hostOverlayLoginBtn.disabled = false;
  }

  setTimeout(() => {
    if (authOverlayInput) authOverlayInput.focus();
  }, 50);
}

function hideAuthOverlay() {
  if (!authOverlay) return;
  authOverlay.style.display = 'none';
  setAuthOverlayMessage('');
  if (authOverlayInput) authOverlayInput.value = '';
  if (hostOverlayInput) hostOverlayInput.value = '';
  if (hostOverlayLoginBtn) {
    hostOverlayLoginBtn.textContent = '認証';
    hostOverlayLoginBtn.disabled = false;
  }
}

function refreshSecretGateUI() {
  if (!secretMode) {
    hideAuthOverlay();
    enableContentUI(true);
    return;
  }

  if (isAuthed) {
    hideAuthOverlay();
    enableContentUI(true);
  } else {
    showAuthOverlay();
    enableContentUI(false);
  }

  try { updateNameTags(); } catch (_) {}
}

function enableContentUI(enable) {
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const actionBar = document.getElementById('action-buttons');
  const joystick = document.getElementById('joystick-base');
  const speakerControls = document.getElementById('speaker-controls');

  if (chatInput) chatInput.disabled = !enable;
  if (chatForm) chatForm.style.pointerEvents = enable ? 'auto' : 'none';
  if (actionBar) actionBar.style.pointerEvents = enable ? 'auto' : 'none';
  if (joystick) joystick.style.pointerEvents = enable ? 'auto' : 'none';
  if (speakerControls) speakerControls.style.pointerEvents = enable ? 'auto' : 'none';
}

// -----------------------------
// ★ ネームタグ Layer
// -----------------------------
function ensureNameTagLayer() {
  if (nameTagLayer) return;
  nameTagLayer = document.createElement('div');
  nameTagLayer.id = 'name-tag-layer';
  nameTagLayer.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 12000;
  `;
  document.body.appendChild(nameTagLayer);

  if (!document.getElementById('name-tag-styles')) {
    const style = document.createElement('style');
    style.id = 'name-tag-styles';
    style.textContent = `
      .name-tag {
        position: absolute;
        transform: translate(-50%, -100%);
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 800;
        color: white;
        background: rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.18);
        white-space: nowrap;
        text-shadow: 0 1px 2px rgba(0,0,0,0.7);
        backdrop-filter: blur(4px);
      }
      .name-tag.hidden { display: none; }
    `;
    document.head.appendChild(style);
  }
}

function upsertNameTag(odUserId, userName) {
  ensureNameTagLayer();
  const existing = nameTags.get(odUserId);
  if (existing) {
    if (existing.lastText !== userName) {
      existing.el.textContent = userName || 'ゲスト';
      existing.lastText = userName;
    }
    return;
  }
  const el = document.createElement('div');
  el.className = 'name-tag';
  el.textContent = userName || 'ゲスト';
  nameTagLayer.appendChild(el);
  nameTags.set(odUserId, { el, lastText: userName });
}

function removeNameTag(odUserId) {
  const t = nameTags.get(odUserId);
  if (!t) return;
  t.el.remove();
  nameTags.delete(odUserId);
}

function updateNameTags() {
  const shouldHide = secretMode && !isAuthed;
  nameTags.forEach((t) => {
    t.el.classList.toggle('hidden', shouldHide);
  });
  if (shouldHide) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const headOffset = 2.2;

  function placeTag(odUserId, avatarObj) {
    const t = nameTags.get(odUserId);
    if (!t || !avatarObj) return;

    const pos = avatarObj.position.clone();
    pos.y += headOffset;
    pos.project(camera);

    const x = (pos.x * 0.5 + 0.5) * width;
    const y = (-pos.y * 0.5 + 0.5) * height;

    const behind = pos.z > 1;
    const out = x < -50 || x > width + 50 || y < -50 || y > height + 50;
    t.el.style.display = (behind || out) ? 'none' : 'block';
    if (behind || out) return;

    t.el.style.left = `${x}px`;
    t.el.style.top = `${y}px`;
  }

  if (myAvatar) placeTag(getMyConnectionId() || myUserId, myAvatar);

  remoteAvatars.forEach((userData, odUserId) => {
    if (userData?.avatar) placeTag(odUserId, userData.avatar);
  });
}

// 初期化
async function init() {
  debugLog('Initializing...');
  debugLog(`Touch device: ${isTouchDevice}`, 'info');
  createDebugUI();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000011);
  scene.fog = new THREE.Fog(0x000011, 20, 80);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 4, 10);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  clock = new THREE.Clock();

  initVenue(scene);
  createAllVenue();

  const avatarColor = Math.random() * 0xffffff;
  myAvatar = createAvatar(myUserId, myUserName, avatarColor);
  myAvatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);
  scene.add(myAvatar);

  upsertNameTag(myUserId, myUserName);

  myPenlight = createPenlight(0xff00ff);
  myPenlight.visible = false;
  scene.add(myPenlight);
  debugLog('Penlight created and added to scene', 'success');

  initSettings(myUserName, {
    onNameChange: (newName) => {
      myUserName = newName;
      sendNameChange(newName);
      showNotification(`名前を「${newName}」に変更しました`, 'success');
      const myId = getMyConnectionId() || myUserId;
      upsertNameTag(myId, myUserName);
    },
    onAvatarChange: (avatarName) => {
      const ext = CHARA_EXTENSIONS[avatarName] || 'png';
      const imageUrl = `${CHARA_BASE_URL}${avatarName}.${ext}`;
      setAvatarImage(myAvatar, imageUrl);
      myAvatarImage = avatarName;
      sendAvatarChange(imageUrl);
      showNotification(`アバターを変更しました`, 'success');
    },
    onBackgroundChange: (imageUrl) => {
      changeStageBackground(imageUrl);
      sendBackgroundChange(imageUrl);
      showNotification('背景を変更しました', 'success');
    },
    onBrightnessChange: (value) => {
      setRoomBrightness(value);
      sendBrightness(value);
    },
    onRequestSpeak: () => {
      requestSpeak();
      showNotification('登壇リクエストを送信しました', 'info');
    },
    onApproveSpeak: (odUserId) => {
      approveSpeak(odUserId);
      showNotification('登壇を許可しました', 'success');
    },
    onDenySpeak: (odUserId) => {
      denySpeak(odUserId);
      showNotification('登壇を却下しました', 'info');
    },
    onKickSpeaker: (odUserId) => {
      kickSpeaker(odUserId);
      showNotification('降壇させました', 'info');
    },
    onAnnounce: (message) => {
      sendAnnounce(message);
      showNotification('アナウンスを送信しました', 'success');
    },
    onResetCamera: () => {
      cameraAngleX = 0;
      cameraHeight = 4;
      cameraDistance = 6;
      showNotification('カメラをリセットしました', 'info');
    },
    onHostLogin: (pass) => {
      const p = (pass || '').trim();
      if (!p) {
        showNotification('主催者パスワードを入力してください', 'warn');
        return;
      }
      hostLogin(p);
    },
    onHostLogout: () => {
      hostLogout();
    },
    onDisableSecretMode: () => {
      if (!isHost) {
        showNotification('主催者ログインが必要です', 'warn');
        return;
      }
      try {
        disableSecretMode();
        showNotification('解除リクエストを送信しました', 'info');
      } catch (_) {
        showNotification('解除送信に失敗しました', 'warn');
      }
    }
  });

  setupConnection();

  setupChatUI();
  setupActionButtons();
  setupSpeakerControls();
  setupJoystick();
  setupCameraSwipe();

  window.addEventListener('resize', onWindowResize);

  animate();

  updateUserCount();
  updateSpeakerCount(0);

  debugLog('Initialization complete');
}

// 接続セットアップ
function setupConnection() {
  setCallbacks({
    onInitMin: (data) => {
      secretMode = !!data?.secretMode;
      isHost = !!data?.isHost;
      isAuthed = false;

      if (secretMode) purgeSensitiveClientState('onInitMin secretMode=ON');

      const myId = getMyConnectionId();
      if (myId && myId !== myUserId) {
        removeNameTag(myUserId);
        upsertNameTag(myId, myUserName);
      }

      debugLog(`InitMin: secretMode=${secretMode} isHost=${isHost}`, 'info');
      refreshSecretGateUI();
    },

    onAuthOk: () => {
      isAuthed = true;
      setAuthOverlayMessage('');
      showNotification('入室パスワード認証OK', 'success');
      refreshSecretGateUI();
    },

    onAuthNg: () => {
      purgeSensitiveClientState('onAuthNg');
      setAuthOverlayMessage('パスワードが違います');
      showNotification('入室パスワードが違います', 'warn');
      refreshSecretGateUI();
    },

    onSecretModeChanged: (value) => {
      secretMode = !!value;

      if (secretMode) {
        isAuthed = false;
        purgeSensitiveClientState('onSecretModeChanged -> ON');
      }

      refreshSecretGateUI();
      showNotification(secretMode ? '秘密会議モード ON' : '秘密会議モード OFF', 'info');
    },

    onUserJoin: (odUserId, userName) => {
      if (!isContentAllowed()) return;

      debugLog(`User joined: ${odUserId} (${userName})`);
      if (!remoteAvatars.has(odUserId)) {
        const avatarColor = Math.random() * 0xffffff;
        const avatar = createAvatar(odUserId, userName, avatarColor);
        avatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);
        scene.add(avatar);
        remoteAvatars.set(odUserId, { avatar, userName, penlight: null });
        debugLog(`Remote avatar created for ${odUserId}`, 'success');
        upsertNameTag(odUserId, userName || 'ゲスト');
      }
      updateUserCount();
    },

    onUserLeave: (odUserId) => {
      if (!isContentAllowed()) return;

      debugLog(`User left: ${odUserId}`);
      const userData = remoteAvatars.get(odUserId);
      if (userData) {
        if (userData.avatar) scene.remove(userData.avatar);
        if (userData.penlight) scene.remove(userData.penlight);
        stopRemoteOtagei(odUserId);
        remoteAvatars.delete(odUserId);
      }
      removeNameTag(odUserId);
      updateUserCount();
    },

    onPosition: (odUserId, x, y, z) => {
      if (!isContentAllowed()) return;

      const userData = remoteAvatars.get(odUserId);
      if (userData && userData.avatar) {
        userData.avatar.position.set(x, y, z);
        if (userData.penlight && userData.penlight.visible) {
          userData.penlight.position.set(x, y + 1.6, z);
        }
      }
    },

    onAvatarChange: (odUserId, imageUrl) => {
      if (!isContentAllowed()) return;

      debugLog(`Avatar change received: ${odUserId} -> ${imageUrl}`);
      const userData = remoteAvatars.get(odUserId);
      if (userData && userData.avatar) setAvatarImage(userData.avatar, imageUrl);
    },

    onNameChange: (odUserId, newName) => {
      if (!isContentAllowed()) return;

      debugLog(`Name change received: ${odUserId} -> ${newName}`);
      const userData = remoteAvatars.get(odUserId);
      if (userData) userData.userName = newName;
      upsertNameTag(odUserId, newName || 'ゲスト');
    },

    onReaction: (odUserId, reactionType, color) => {
      if (!isContentAllowed()) return;

      debugLog(`Reaction from ${odUserId}: ${reactionType}`, 'info');
      const userData = remoteAvatars.get(odUserId);
      if (userData && userData.avatar) {
        if (reactionType === 'penlight') {
          let remotePenlight = userData.penlight;
          if (!remotePenlight) {
            remotePenlight = createPenlight(color || '#ff00ff');
            userData.penlight = remotePenlight;
            scene.add(remotePenlight);
            debugLog(`Created penlight for ${odUserId}`, 'success');
          }
          remotePenlight.visible = true;
          remotePenlight.position.set(
            userData.avatar.position.x,
            userData.avatar.position.y + 1.6,
            userData.avatar.position.z
          );
          if (color) {
            const colorValue = new THREE.Color(color);
            remotePenlight.traverse((child) => {
              if (child.isMesh && child.material && child.name !== 'penlightHandle') {
                child.material.color.copy(colorValue);
              }
              if (child.isPointLight) child.color.copy(colorValue);
            });
          }
          debugLog(`Penlight shown for ${odUserId}`, 'success');
        } else if (reactionType === 'penlight_off') {
          if (userData.penlight) {
            userData.penlight.visible = false;
            debugLog(`Penlight hidden for ${odUserId}`, 'info');
          }
        } else if (reactionType === 'otagei') {
          startRemoteOtagei(odUserId, userData.avatar);
          debugLog(`Otagei started for ${odUserId}`, 'success');
        }
      }
    },

    onChat: (odUserId, userName, message) => {
      if (!isContentAllowed()) return;

      const myId = getMyConnectionId();
      if (odUserId !== myId) addChatMessage(userName, message);
    },

    onSpeakApproved: () => {
      if (!isContentAllowed()) return;

      debugLog('Speak approved!');
      isOnStage = true;
      if (isOtageiActive) {
        isOtageiActive = false;
        stopOtageiAnimation();
      }
      moveToStage();
      showSpeakerControls(true);
      showNotification('登壇が承認されました！', 'success');
    },

    onSpeakerJoined: (odUserId, userName) => {
      if (!isContentAllowed()) return;

      debugLog(`Speaker joined: ${odUserId} (${userName})`);
      const userData = remoteAvatars.get(odUserId);
      if (userData && userData.avatar) setAvatarSpotlight(userData.avatar, true);
      showNotification(`${userName || 'ゲスト'} が登壇しました`, 'info');
    },

    onSpeakerLeft: (odUserId) => {
      if (!isContentAllowed()) return;

      debugLog(`Speaker left: ${odUserId}`);
      const userData = remoteAvatars.get(odUserId);
      if (userData && userData.avatar) setAvatarSpotlight(userData.avatar, false);
    },

    onSpeakRequestsUpdate: (requests) => {
      if (!isContentAllowed()) return;

      debugLog(`Speak requests updated: ${requests.length} requests`, 'info');
      updateSpeakRequests(requests);
    },

    onCurrentSpeakersUpdate: (speakers) => {
      if (!isContentAllowed()) return;

      debugLog(`Current speakers updated: ${speakers.length} speakers`, 'info');
      updateCurrentSpeakers(speakers);
      updateSpeakerCount(speakers.length);
    },

    onKicked: () => {
      if (!isContentAllowed()) return;

      debugLog('Kicked from stage');
      isOnStage = false;
      moveToAudience();
      showSpeakerControls(false);
      showNotification('主催者により降壇しました', 'warn');
    },

    onAnnounce: (message) => {
      if (!isContentAllowed()) return;
      showAnnouncement(message);
    },

    onBackgroundChange: (imageUrl) => {
      if (!isContentAllowed()) return;
      changeStageBackground(imageUrl);
    },

    onBrightnessChange: (value) => {
      if (!isContentAllowed()) return;
      setRoomBrightness(value);
    },

    remoteAvatars: remoteAvatars
  });

  connectToPartyKit(myUserName);

  ensureAuthOverlay();
  ensureNameTagLayer();
  refreshSecretGateUI();
}

// アナウンス表示
function showAnnouncement(message) {
  const existing = document.getElementById('announcement-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'announcement-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(135deg, rgba(255, 102, 255, 0.95), rgba(102, 51, 255, 0.95));
    color: white;
    padding: 20px;
    text-align: center;
    font-size: 18px;
    font-weight: bold;
    z-index: 15000;
    animation: slideDown 0.3s ease-out;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;
  overlay.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
      <span style="font-size: 24px;">📢</span>
      <span>${message}</span>
    </div>
  `;

  if (!document.getElementById('announcement-styles')) {
    const style = document.createElement('style');
    style.id = 'announcement-styles';
    style.textContent = `
      @keyframes slideDown {
        from { transform: translateY(-100%); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(0); opacity: 1; }
        to { transform: translateY(-100%); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.animation = 'slideUp 0.3s ease-in forwards';
    setTimeout(() => overlay.remove(), 300);
  }, 5000);

  addChatMessage('📢 アナウンス', message);
}

// リモートユーザーのオタ芸開始
function startRemoteOtagei(odUserId, avatar) {
  stopRemoteOtagei(odUserId);

  const baseY = avatar.position.y;
  let time = 0;
  let animationId = null;

  function animateOtagei() {
    time += 0.15;
    const jumpHeight = Math.abs(Math.sin(time)) * 0.5;
    avatar.position.y = baseY + jumpHeight;
    animationId = requestAnimationFrame(animateOtagei);
  }

  animateOtagei();
  remoteOtageiAnimations.set(odUserId, { animationId, baseY });

  setTimeout(() => {
    stopRemoteOtagei(odUserId);
  }, 3000);
}

// リモートユーザーのオタ芸停止
function stopRemoteOtagei(odUserId) {
  const animation = remoteOtageiAnimations.get(odUserId);
  if (animation) {
    cancelAnimationFrame(animation.animationId);
    const userData = remoteAvatars.get(odUserId);
    if (userData && userData.avatar) userData.avatar.position.y = animation.baseY;
    remoteOtageiAnimations.delete(odUserId);
  }
}

// リモートペンライトのアニメーション更新
function updateRemotePenlights() {
  remoteAvatars.forEach((userData, odUserId) => {
    if (userData.penlight && userData.penlight.visible && userData.avatar) {
      const visitorId = odUserId;
      const swingPhase = Math.sin(penlightTime * 2.5 + visitorId.charCodeAt(0) * 0.1);
      const sideOffset = swingPhase * 0.3;
      const arcHeight = (1 - Math.abs(swingPhase)) * 0.25;

      userData.penlight.position.set(
        userData.avatar.position.x + sideOffset,
        userData.avatar.position.y + 1.6 + arcHeight,
        userData.avatar.position.z
      );
      userData.penlight.rotation.z = swingPhase * 0.5;
      userData.penlight.rotation.x = -0.3;
    }
  });
}

// ジョイスティックセットアップ
function setupJoystick() {
  const joystickBase = document.getElementById('joystick-base');
  const joystickStick = document.getElementById('joystick-stick');

  if (!joystickBase || !joystickStick) {
    debugLog('Joystick elements not found', 'error');
    return;
  }

  const maxDistance = 35;

  function handleJoystickMove(clientX, clientY) {
    const rect = joystickBase.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;

    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance > maxDistance) {
      deltaX = (deltaX / distance) * maxDistance;
      deltaY = (deltaY / distance) * maxDistance;
    }

    joystickStick.style.left = `calc(50% + ${deltaX}px)`;
    joystickStick.style.top = `calc(50% + ${deltaY}px)`;

    joystickX = deltaX / maxDistance;
    joystickY = deltaY / maxDistance;
  }

  function resetJoystick() {
    joystickStick.style.left = '50%';
    joystickStick.style.top = '50%';
    joystickX = 0;
    joystickY = 0;
    joystickActive = false;
  }

  joystickBase.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    joystickActive = true;
    const touch = e.touches[0];
    handleJoystickMove(touch.clientX, touch.clientY);
  });

  joystickBase.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!joystickActive) return;
    const touch = e.touches[0];
    handleJoystickMove(touch.clientX, touch.clientY);
  });

  joystickBase.addEventListener('touchend', (e) => {
    e.stopPropagation();
    resetJoystick();
  });

  joystickBase.addEventListener('touchcancel', (e) => {
    e.stopPropagation();
    resetJoystick();
  });

  joystickBase.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    joystickActive = true;
    handleJoystickMove(e.clientX, e.clientY);
  });

  document.addEventListener('mousemove', (e) => {
    if (!joystickActive) return;
    handleJoystickMove(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', resetJoystick);

  debugLog('Joystick setup complete', 'success');
}

// カメラスワイプセットアップ
function setupCameraSwipe() {
  const canvas = renderer.domElement;
  let isDragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }
  });

  canvas.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    e.preventDefault();

    const touch = e.touches[0];
    const deltaX = touch.clientX - lastX;
    const deltaY = touch.clientY - lastY;

    cameraAngleX -= deltaX * 0.005;
    cameraHeight -= deltaY * 0.02;
    cameraHeight = Math.max(2, Math.min(8, cameraHeight));

    lastX = touch.clientX;
    lastY = touch.clientY;
  });

  canvas.addEventListener('touchend', () => {
    isDragging = false;
  });

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaX = e.clientX - lastX;
    const deltaY = e.clientY - lastY;

    cameraAngleX -= deltaX * 0.005;
    cameraHeight -= deltaY * 0.02;
    cameraHeight = Math.max(2, Math.min(8, cameraHeight));

    lastX = e.clientX;
    lastY = e.clientY;
  });

  canvas.addEventListener('mouseup', () => {
    isDragging = false;
  });

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
  });

  debugLog('Camera swipe setup complete', 'success');
}

// ステージへ移動
function moveToStage() {
  const targetX = (Math.random() - 0.5) * 10;
  const targetZ = -5;
  const targetY = STAGE_Y;

  if (isOtageiActive) {
    isOtageiActive = false;
    stopOtageiAnimation();
  }

  animateMove(myAvatar, targetX, targetY, targetZ, () => {
    setAvatarSpotlight(myAvatar, true);
    sendPosition(targetX, targetY, targetZ);
  });
}

// 観客席へ移動
function moveToAudience() {
  const targetX = (Math.random() - 0.5) * 10;
  const targetZ = 5 + Math.random() * 5;
  const targetY = 0;

  animateMove(myAvatar, targetX, targetY, targetZ, () => {
    setAvatarSpotlight(myAvatar, false);
    sendPosition(targetX, targetY, targetZ);
  });
}

// スムーズ移動アニメーション
function animateMove(avatar, targetX, targetY, targetZ, onComplete) {
  const startX = avatar.position.x;
  const startY = avatar.position.y;
  const startZ = avatar.position.z;
  const duration = 1000;
  const startTime = Date.now();

  function update() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);

    avatar.position.x = startX + (targetX - startX) * eased;
    avatar.position.y = startY + (targetY - startY) * eased;
    avatar.position.z = startZ + (targetZ - startZ) * eased;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      if (onComplete) onComplete();
    }
  }
  update();
}

// ジョイスティックによる移動処理
function processJoystickMovement() {
  if (!isContentAllowed()) return;

  if (!joystickActive || (joystickX === 0 && joystickY === 0)) return;

  const speed = 0.15;

  const moveAngle = cameraAngleX;
  const forward = joystickY;
  const right = joystickX;

  const moveX = (Math.sin(moveAngle) * forward + Math.cos(moveAngle) * right) * speed;
  const moveZ = (Math.cos(moveAngle) * forward - Math.sin(moveAngle) * right) * speed;

  if (isOnStage) {
    let newX = myAvatar.position.x + moveX;
    newX = Math.max(-7, Math.min(7, newX));
    myAvatar.position.x = newX;
    myAvatar.position.y = STAGE_Y;
  } else {
    let newX = myAvatar.position.x + moveX;
    let newZ = myAvatar.position.z + moveZ;

    newX = Math.max(-15, Math.min(15, newX));
    newZ = Math.max(-2, Math.min(15, newZ));

    myAvatar.position.x = newX;
    myAvatar.position.z = newZ;
  }

  sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);
}

// ユーザー数更新
function updateUserCount() {
  const count = isContentAllowed() ? (remoteAvatars.size + 1) : 1;
  const el = document.getElementById('user-count');
  if (el) el.textContent = count;
}

// 登壇者数更新
function updateSpeakerCount(count) {
  const el = document.getElementById('speaker-count');
  if (el) el.textContent = count;
}

// チャットUIセットアップ
function setupChatUI() {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');

  if (!form || !input) {
    debugLog('Chat elements not found', 'error');
    return;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!isContentAllowed()) {
      showNotification('入室パスワードが必要です', 'warn');
      return;
    }

    const message = input.value.trim();
    if (message) {
      sendChat(message);
      addChatMessage(myUserName, message, true);
      input.value = '';
    }
  });

  debugLog('Chat UI setup complete', 'success');
}

// アクションボタンセットアップ
function setupActionButtons() {
  const penlightBtn = document.getElementById('penlight-btn');
  const otageiBtn = document.getElementById('otagei-btn');
  const penlightColors = document.getElementById('penlight-colors');

  if (!penlightBtn || !otageiBtn || !penlightColors) {
    debugLog('Action button elements not found', 'error');
    return;
  }

  debugLog('Action buttons setup started', 'info');

  function togglePenlight() {
    if (!isContentAllowed()) return;

    debugLog('Penlight toggle called', 'info');

    isPenlightActive = !isPenlightActive;
    myPenlight.visible = isPenlightActive;
    penlightBtn.classList.toggle('active', isPenlightActive);

    debugLog(`Penlight active: ${isPenlightActive}, visible: ${myPenlight.visible}`, 'info');

    if (isPenlightActive) {
      penlightBtn.style.background = penlightColor;
      penlightBtn.style.boxShadow = `0 0 15px ${penlightColor}`;
      updatePenlightPosition();
      sendReaction('penlight', penlightColor);
      debugLog(`Penlight position: ${myPenlight.position.x.toFixed(2)}, ${myPenlight.position.y.toFixed(2)}, ${myPenlight.position.z.toFixed(2)}`, 'info');
    } else {
      penlightBtn.style.background = '';
      penlightBtn.style.boxShadow = '';
      sendReaction('penlight_off', null);
    }
  }

  let longPressTriggered = false;
  let lastToggleTime = 0;

  function safeTogglePenlight() {
    const now = Date.now();
    if (now - lastToggleTime < 300) {
      debugLog('Toggle ignored (too fast)', 'warn');
      return;
    }
    lastToggleTime = now;
    togglePenlight();
  }

  if (isTouchDevice) {
    debugLog('Setting up touch events for penlight', 'info');

    penlightBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      longPressTriggered = false;
      penlightLongPressTimer = setTimeout(() => {
        longPressTriggered = true;
        penlightColors.classList.remove('hidden');
        debugLog('Penlight color panel opened (touch)', 'info');
      }, 500);
    });

    penlightBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (penlightLongPressTimer) {
        clearTimeout(penlightLongPressTimer);
        penlightLongPressTimer = null;
      }
      if (!longPressTriggered) safeTogglePenlight();
      longPressTriggered = false;
    });

    penlightBtn.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      if (penlightLongPressTimer) {
        clearTimeout(penlightLongPressTimer);
        penlightLongPressTimer = null;
      }
      longPressTriggered = false;
    });
  } else {
    debugLog('Setting up mouse events for penlight', 'info');

    penlightBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      longPressTriggered = false;
      penlightLongPressTimer = setTimeout(() => {
        longPressTriggered = true;
        penlightColors.classList.remove('hidden');
        debugLog('Penlight color panel opened (mouse)', 'info');
      }, 500);
    });

    penlightBtn.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      if (penlightLongPressTimer) {
        clearTimeout(penlightLongPressTimer);
        penlightLongPressTimer = null;
      }
      if (!longPressTriggered) safeTogglePenlight();
      longPressTriggered = false;
    });

    penlightBtn.addEventListener('mouseleave', () => {
      if (penlightLongPressTimer) {
        clearTimeout(penlightLongPressTimer);
        penlightLongPressTimer = null;
      }
    });
  }

  document.querySelectorAll('.color-btn').forEach(btn => {
    function selectColor(e) {
      e.preventDefault();
      e.stopPropagation();

      if (!isContentAllowed()) return;

      penlightColor = btn.dataset.color;
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      updatePenlightColor();

      if (isPenlightActive) {
        penlightBtn.style.background = penlightColor;
        penlightBtn.style.boxShadow = `0 0 15px ${penlightColor}`;
        sendReaction('penlight', penlightColor);
      }

      penlightColors.classList.add('hidden');
      debugLog(`Penlight color changed to ${penlightColor}`, 'info');
    }

    if (isTouchDevice) btn.addEventListener('touchend', selectColor);
    else btn.addEventListener('click', selectColor);
  });

  let otageiLastToggleTime = 0;

  function safeToggleOtagei() {
    if (!isContentAllowed()) return;

    const now = Date.now();
    if (now - otageiLastToggleTime < 300) {
      debugLog('Otagei toggle ignored (too fast)', 'warn');
      return;
    }
    otageiLastToggleTime = now;

    isOtageiActive = !isOtageiActive;
    otageiBtn.classList.toggle('active', isOtageiActive);

    if (isOtageiActive) {
      startOtageiAnimation();
      sendReaction('otagei', null);
      debugLog('Otagei started', 'info');
    } else {
      stopOtageiAnimation();
      debugLog('Otagei stopped', 'info');
    }
  }

  if (isTouchDevice) {
    otageiBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      safeToggleOtagei();
    });
  } else {
    otageiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeToggleOtagei();
    });
  }

  debugLog('Action buttons setup complete', 'success');
}

// ペンライト位置更新
function updatePenlightPosition() {
  if (myPenlight && myAvatar) {
    const offsetX = -Math.sin(cameraAngleX) * 0.5;
    const offsetZ = -Math.cos(cameraAngleX) * 0.5;

    myPenlight.position.set(
      myAvatar.position.x + offsetX,
      myAvatar.position.y + 1.6,
      myAvatar.position.z + offsetZ
    );
  }
}

// ペンライト色更新
function updatePenlightColor() {
  if (myPenlight) {
    const colorValue = new THREE.Color(penlightColor);

    myPenlight.traverse((child) => {
      if (child.isMesh && child.material && child.name !== 'penlightHandle') {
        child.material.color.copy(colorValue);
      }
      if (child.isPointLight) child.color.copy(colorValue);
    });

    debugLog(`Penlight color updated to ${penlightColor}`, 'info');
  }
}

// オタ芸アニメーション開始
function startOtageiAnimation() {
  otageiBaseY = myAvatar.position.y;
  let time = 0;

  function animateOtagei() {
    if (!isOtageiActive) return;

    time += 0.15;
    const jumpHeight = Math.abs(Math.sin(time)) * 0.5;
    myAvatar.position.y = otageiBaseY + jumpHeight;

    otageiAnimationId = requestAnimationFrame(animateOtagei);
  }
  animateOtagei();
}

// オタ芸アニメーション停止
function stopOtageiAnimation() {
  if (otageiAnimationId) {
    cancelAnimationFrame(otageiAnimationId);
    otageiAnimationId = null;
  }
  if (isOnStage) myAvatar.position.y = STAGE_Y;
  else myAvatar.position.y = 0;
}

// スピーカーコントロールセットアップ
function setupSpeakerControls() {
  const micBtn = document.getElementById('mic-toggle-btn');
  const leaveBtn = document.getElementById('leave-stage-btn');

  if (!micBtn || !leaveBtn) {
    debugLog('Speaker control elements not found', 'warn');
    return;
  }

  micBtn.addEventListener('click', () => {
    if (!isContentAllowed()) {
      showNotification('入室パスワードが必要です', 'warn');
      return;
    }

    toggleMic();
    const state = getState();
    micBtn.textContent = state.isMicMuted ? '🎙️ マイク OFF' : '🎙️ マイク ON';
    micBtn.style.background = state.isMicMuted
      ? 'linear-gradient(135deg, #f44336, #ff5722)'
      : 'linear-gradient(135deg, #4CAF50, #8BC34A)';
  });

  leaveBtn.addEventListener('click', () => {
    if (!isContentAllowed()) return;

    stopSpeaking();
    isOnStage = false;
    moveToAudience();
    showSpeakerControls(false);
    showNotification('降壇しました', 'info');
  });

  debugLog('Speaker controls setup complete', 'success');
}

// スピーカーコントロール表示/非表示
function showSpeakerControls(show) {
  const controls = document.getElementById('speaker-controls');
  if (controls) controls.classList.toggle('hidden', !show);

  if (show) {
    const micBtn = document.getElementById('mic-toggle-btn');
    if (micBtn) {
      micBtn.textContent = '🎙️ マイク ON';
      micBtn.style.background = 'linear-gradient(135deg, #4CAF50, #8BC34A)';
    }
  }
}

// ウィンドウリサイズ
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// アニメーションループ
function animate() {
  requestAnimationFrame(animate);

  animateVenue();
  processJoystickMovement();

  if (myAvatar) {
    const camX = myAvatar.position.x + Math.sin(cameraAngleX) * cameraDistance;
    const camY = myAvatar.position.y + cameraHeight;
    const camZ = myAvatar.position.z + Math.cos(cameraAngleX) * cameraDistance;

    camera.position.set(camX, camY, camZ);
    camera.lookAt(myAvatar.position.x, myAvatar.position.y + 1, myAvatar.position.z);
  }

  if (isPenlightActive && myPenlight && myPenlight.visible) {
    penlightTime += 0.06;

    updatePenlightPosition();

    const swingPhase = Math.sin(penlightTime * 2.5);

    const sideOffset = swingPhase * 0.5;
    myPenlight.position.x += Math.cos(cameraAngleX) * sideOffset;
    myPenlight.position.z += -Math.sin(cameraAngleX) * sideOffset;

    const arcHeight = (1 - Math.abs(swingPhase)) * 0.35;
    myPenlight.position.y += arcHeight;

    myPenlight.rotation.z = swingPhase * 0.6;
    myPenlight.rotation.x = -0.4;
    myPenlight.rotation.y = cameraAngleX + Math.PI;

    const glow = myPenlight.getObjectByName('penlightGlow');
    const outerGlow = myPenlight.getObjectByName('penlightOuterGlow');
    if (glow) {
      const pulse = 1 + Math.sin(penlightTime * 6) * 0.25;
      glow.scale.set(pulse, pulse, pulse);
    }
    if (outerGlow) {
      const pulse = 1 + Math.sin(penlightTime * 6 + 0.5) * 0.2;
      outerGlow.scale.set(pulse, pulse, pulse);
    }
  }

  penlightTime += 0.01;
  updateRemotePenlights();

  updateNameTags();

  renderer.render(scene, camera);
}

// 開始
init();
