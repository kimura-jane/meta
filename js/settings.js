// settings.js - 設定画面・主催者メニュー（即復旧版・全文）
// ✅ 主催者判定はローカル照合（HOST_PASSWORD）で行う（※サーバ判定ではない）

const HOST_PASSWORD = 'jomon2026';

const STAGE_BACKGROUNDS = [
  { name: 'デフォルト', file: 'IMG_3206.jpeg', isRoot: true },
  { name: 'IMG_0967', file: 'IMG_0967.png' },
  { name: 'IMG_3273', file: 'IMG_3273.jpeg' },
  { name: 'IMG_3274', file: 'IMG_3274.jpeg' },
  { name: 'IMG_3275', file: 'IMG_3275.jpeg' },
  { name: 'IMG_9719', file: 'IMG_9719.jpeg' }
];

const STAGE_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/stage/';
const ROOT_BASE_URL  = 'https://raw.githubusercontent.com/kimura-jane/meta/main/';

const CHARA_LIST = [
  '12444', '12555', 'IMG_1677', 'IMG_1861', 'IMG_1889',
  'IMG_2958', 'IMG_3264', 'IMG_3267', 'IMG_3269', 'IMG_3325',
  'IMG_3326', 'IMG_3327', 'IMG_3328', 'IMG_7483', 'onigiriya_kanatake_512'
];

const CHARA_EXTENSIONS = {
  '12444': 'png',
  '12555': 'png',
  'IMG_1677': 'png',
  'IMG_1861': 'png',
  'IMG_1889': 'png',
  'IMG_2958': 'png',
  'IMG_3264': 'png',
  'IMG_3267': 'png',
  'IMG_3269': 'png',
  'IMG_3325': 'png',
  'IMG_3326': 'png',
  'IMG_3327': 'webp',
  'IMG_3328': 'webp',
  'IMG_7483': 'png',
  'onigiriya_kanatake_512': 'png'
};

const CHARA_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/chara/';

let isHost = false;

let currentSettings = {
  userName: 'ゲスト',
  visibleNames: true,
  notifications: true,
  selectedAvatar: null
};

let callbacks = {};
let hostLoginPending = false;

function initSettings(userName, cbs) {
  currentSettings.userName = userName;
  callbacks = { ...callbacks, ...(cbs || {}) }; // ✅ 安全にマージ
  createSettingsUI();
}

function getSettings() {
  return { ...currentSettings };
}

function setHostMode(enabled) {
  isHost = !!enabled;

  const loginArea = document.getElementById('host-login-area');
  const controls  = document.getElementById('host-controls');

  if (loginArea && controls) {
    loginArea.style.display = isHost ? 'none' : 'block';
    controls.style.display  = isHost ? 'block' : 'none';
  }

  if (!isHost) {
    const pw = document.getElementById('host-password');
    if (pw) pw.value = '';
  }
}

function isHostMode() {
  return isHost;
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    background: ${
      type === 'success' ? 'rgba(76, 175, 80, 0.9)'
      : type === 'error' ? 'rgba(244, 67, 54, 0.9)'
      : 'rgba(33, 150, 243, 0.9)'
    };
    color: white;
    border-radius: 8px;
    font-size: 14px;
    z-index: 10000;
    opacity: 0;
    transition: opacity 0.3s ease;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(notification);

  setTimeout(() => notification.style.opacity = '1', 10);
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function updateSpeakRequests(requests) {
  const container = document.getElementById('speak-requests-list');
  if (!container) return;

  if (!requests || requests.length === 0) {
    container.innerHTML = '<div style="color: #888; font-size: 12px;">リクエストなし</div>';
    return;
  }

  container.innerHTML = requests.map(req => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; background:rgba(255,255,255,0.1); border-radius:4px; margin-bottom:4px;">
      <span>${req.userName || 'ゲスト'}</span>
      <div>
        <button onclick="window.approveSpeak('${req.userId}')" style="background:#4CAF50; border:none; color:white; padding:4px 8px; border-radius:4px; margin-right:4px; cursor:pointer;">許可</button>
        <button onclick="window.denySpeak('${req.userId}')" style="background:#f44336; border:none; color:white; padding:4px 8px; border-radius:4px; cursor:pointer;">拒否</button>
      </div>
    </div>
  `).join('');
}

function updateCurrentSpeakers(speakers) {
  const container = document.getElementById('current-speakers-list');
  if (!container) return;

  if (!speakers || speakers.length === 0) {
    container.innerHTML = '<div style="color: #888; font-size: 12px;">登壇者なし</div>';
    return;
  }

  container.innerHTML = speakers.map(speaker => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; background:rgba(255,255,255,0.1); border-radius:4px; margin-bottom:4px;">
      <span>🎤 ${speaker.userName || 'ゲスト'}</span>
      <button onclick="window.kickSpeaker('${speaker.userId}')" style="background:#ff9800; border:none; color:white; padding:4px 8px; border-radius:4px; cursor:pointer;">降壇</button>
    </div>
  `).join('');
}

function updateUserCount(count) {
  // main.js側で更新するなら空でOK
}

function createSettingsUI() {
  if (document.getElementById('settings-btn')) return;

  const settingsBtn = document.createElement('button');
  settingsBtn.id = 'settings-btn';
  settingsBtn.innerHTML = '⚙️';
  settingsBtn.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(30, 30, 40, 0.9);
    border: 2px solid rgba(255, 102, 255, 0.5);
    color: white;
    font-size: 28px;
    cursor: pointer;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 15px rgba(255, 102, 255, 0.3);
    transition: all 0.3s ease;
  `;
  settingsBtn.onmouseenter = () => {
    settingsBtn.style.transform = 'scale(1.1)';
    settingsBtn.style.boxShadow = '0 0 25px rgba(255, 102, 255, 0.6)';
  };
  settingsBtn.onmouseleave = () => {
    settingsBtn.style.transform = 'scale(1)';
    settingsBtn.style.boxShadow = '0 0 15px rgba(255, 102, 255, 0.3)';
  };
  document.body.appendChild(settingsBtn);

  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    z-index: 999;
    display: none;
  `;
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.style.cssText = `
    position: fixed;
    top: 0;
    right: -350px;
    width: 320px;
    height: 100%;
    background: linear-gradient(180deg, rgba(20,20,30,0.98) 0%, rgba(30,20,40,0.98) 100%);
    z-index: 1001;
    transition: right 0.3s ease;
    overflow-y: auto;
    padding: 20px;
    box-sizing: border-box;
  `;

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2 style="margin:0; font-size:18px;">⚙️ 設定</h2>
      <button id="close-settings" style="background:none; border:none; color:white; font-size:24px; cursor:pointer;">×</button>
    </div>

    <div style="margin-bottom: 20px;">
      <button id="request-speak-btn" style="
        width: 100%;
        padding: 12px;
        background: linear-gradient(135deg, #ff0066 0%, #ff66ff 100%);
        border: none;
        border-radius: 8px;
        color: white;
        font-size: 16px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(255, 0, 102, 0.4);
      ">🎤 登壇リクエスト</button>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 14px; margin-bottom: 10px; color: #ff66ff;">🎭 アバター選択</h3>
      <div id="avatar-grid" style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;"></div>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 14px; margin-bottom: 10px; color: #66ffff;">📋 一般設定</h3>

      <div style="margin-bottom: 12px;">
        <label style="font-size: 12px; color: #aaa;">名前</label>
        <div style="display:flex; gap:8px; margin-top:4px;">
          <input type="text" id="user-name-input" value="${currentSettings.userName}" style="
            flex:1;
            padding:8px;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius:4px;
            color:white;
            font-size:14px;
          ">
          <button id="save-name-btn" style="
            padding:8px 12px;
            background:#66ffff;
            border:none;
            border-radius:4px;
            color:black;
            cursor:pointer;
          ">保存</button>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size: 13px;">名前を表示</span>
        <label class="toggle-switch">
          <input type="checkbox" id="visible-names-toggle" ${currentSettings.visibleNames ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size: 13px;">入退室通知</span>
        <label class="toggle-switch">
          <input type="checkbox" id="notifications-toggle" ${currentSettings.notifications ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <button id="reset-camera-btn" style="
        width:100%;
        padding:10px;
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.2);
        border-radius:4px;
        color:white;
        cursor:pointer;
        margin-top:8px;
      ">📷 カメラ視点リセット</button>
    </div>

    <div style="margin-bottom: 20px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
      <h3 style="font-size: 14px; margin-bottom: 10px; color: #ffaa00;">👑 主催者ログイン</h3>

      <div id="host-login-area">
        <input type="password" id="host-password" placeholder="パスワード" style="
          width:100%;
          padding:10px;
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius:4px;
          color:white;
          margin-bottom:8px;
          box-sizing:border-box;
        ">
        <button id="host-login-btn" style="
          width:100%;
          padding:10px;
          background: linear-gradient(135deg, #ffaa00 0%, #ff6600 100%);
          border:none;
          border-radius:4px;
          color:white;
          font-weight:bold;
          cursor:pointer;
        ">認証</button>

        <div style="margin-top:8px; font-size:11px; color:#aaa; line-height:1.4;">
          ※ 主催者判定はこの端末で照合します（HOST_PASSWORD）
        </div>
      </div>

      <div id="host-controls" style="display:none;">
        <div style="background: rgba(255,170,0,0.2); padding:10px; border-radius:8px; margin-bottom:15px;">
          <span style="color:#ffaa00; font-weight:bold;">👑 主催者モード有効</span>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="font-size:12px; color:#aaa;">🔆 部屋の明るさ</label>
          <div style="display:flex; align-items:center; gap:10px; margin-top:8px;">
            <input type="range" id="brightness-slider" min="0" max="200" value="60" style="flex:1;">
            <span id="brightness-value" style="width:80px; text-align:center; font-size:14px; color:#66ffff; background: rgba(102,255,255,0.1); padding:4px 8px; border-radius:4px;">60%</span>
          </div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="font-size:12px; color:#aaa;">🖼️ ステージ背景</label>
          <div id="background-selection" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:8px;"></div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="font-size:12px; color:#aaa;">📋 登壇リクエスト</label>
          <div id="speak-requests-list" style="margin-top:8px; max-height:150px; overflow-y:auto;">
            <div style="color:#888; font-size:12px;">リクエストなし</div>
          </div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="font-size:12px; color:#aaa;">🎤 現在の登壇者</label>
          <div id="current-speakers-list" style="margin-top:8px; max-height:150px; overflow-y:auto;">
            <div style="color:#888; font-size:12px;">登壇者なし</div>
          </div>
        </div>

        <div style="margin-bottom: 15px;">
          <label style="font-size:12px; color:#aaa;">📢 全体アナウンス</label>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="text" id="announce-input" placeholder="メッセージ" style="
              flex:1;
              padding:8px;
              background: rgba(255,255,255,0.1);
              border: 1px solid rgba(255,255,255,0.2);
              border-radius:4px;
              color:white;
            ">
            <button id="announce-btn" style="
              padding:8px 12px;
              background:#ff66ff;
              border:none;
              border-radius:4px;
              color:white;
              cursor:pointer;
            ">送信</button>
          </div>
        </div>

        <button id="host-logout-btn" style="
          width:100%;
          padding:10px;
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.2);
          border-radius:4px;
          color:#ff6666;
          cursor:pointer;
        ">ログアウト</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  const avatarGrid = document.getElementById('avatar-grid');
  CHARA_LIST.forEach(charaId => {
    const ext = CHARA_EXTENSIONS[charaId] || 'png';
    const url = `${CHARA_BASE_URL}${charaId}.${ext}`;

    const avatarOption = document.createElement('div');
    avatarOption.className = 'avatar-option';
    avatarOption.style.cssText = `
      width:60px;
      height:60px;
      border-radius:8px;
      background: url('${url}') center/cover;
      cursor:pointer;
      border: 2px solid transparent;
      transition: all 0.2s;
    `;
    avatarOption.dataset.charaId = charaId;

    avatarOption.onclick = () => {
      document.querySelectorAll('.avatar-option').forEach(opt => opt.style.border = '2px solid transparent');
      avatarOption.style.border = '2px solid #ff66ff';
      currentSettings.selectedAvatar = charaId;
      if (callbacks.onAvatarChange) callbacks.onAvatarChange(charaId);
    };

    avatarGrid.appendChild(avatarOption);
  });

  const bgSelection = document.getElementById('background-selection');
  STAGE_BACKGROUNDS.forEach(bg => {
    const url = bg.isRoot ? `${ROOT_BASE_URL}${bg.file}` : `${STAGE_BASE_URL}${bg.file}`;

    const bgOption = document.createElement('div');
    bgOption.className = 'bg-option';
    bgOption.style.cssText = `
      width:80px;
      height:50px;
      border-radius:4px;
      background: url('${url}') center/cover;
      cursor:pointer;
      border: 2px solid transparent;
      transition: all 0.2s;
    `;
    bgOption.title = bg.name;

    bgOption.onclick = () => {
      document.querySelectorAll('.bg-option').forEach(opt => opt.style.border = '2px solid transparent');
      bgOption.style.border = '2px solid #66ffff';
      if (callbacks.onBackgroundChange) callbacks.onBackgroundChange(url);
    };

    bgSelection.appendChild(bgOption);
  });

  settingsBtn.onclick = () => { overlay.style.display = 'block'; panel.style.right = '0'; };
  overlay.onclick = () => { overlay.style.display = 'none'; panel.style.right = '-350px'; };
  document.getElementById('close-settings').onclick = () => { overlay.style.display = 'none'; panel.style.right = '-350px'; };

  document.getElementById('request-speak-btn').onclick = () => { if (callbacks.onRequestSpeak) callbacks.onRequestSpeak(); };

  document.getElementById('save-name-btn').onclick = () => {
    const newName = document.getElementById('user-name-input').value.trim();
    if (newName) {
      currentSettings.userName = newName;
      if (callbacks.onNameChange) callbacks.onNameChange(newName);
      showNotification('名前を保存しました', 'success');
    }
  };

  document.getElementById('visible-names-toggle').onchange = (e) => {
    currentSettings.visibleNames = e.target.checked;
    if (callbacks.onVisibleNamesChange) callbacks.onVisibleNamesChange(e.target.checked);
  };

  document.getElementById('notifications-toggle').onchange = (e) => {
    currentSettings.notifications = e.target.checked;
  };

  document.getElementById('reset-camera-btn').onclick = () => {
    if (callbacks.onResetCamera) callbacks.onResetCamera();
  };

  document.getElementById('host-login-btn').onclick = async () => {
    if (hostLoginPending) return;

    const password = (document.getElementById('host-password').value || '').trim();
    if (!password) {
      showNotification('パスワードを入力してください', 'error');
      return;
    }

    if (password !== HOST_PASSWORD) {
      showNotification('パスワードが違います', 'error');
      return;
    }

    setHostMode(true);
    showNotification('主催者としてログインしました', 'success');

    // 任意：サーバ側に通知したいときだけ（無ければ何もしない）
    if (callbacks.onHostLogin) {
      hostLoginPending = true;
      try {
        const ret = callbacks.onHostLogin(password);
        const ok = (ret instanceof Promise) ? await ret : !!ret;
        if (!ok) showNotification('サーバ通知に失敗（主催UIは利用可）', 'error');
      } catch (e) {
        showNotification(`サーバ通知エラー（主催UIは利用可）: ${e?.message || e}`, 'error');
      } finally {
        hostLoginPending = false;
      }
    }
  };

  document.getElementById('host-logout-btn').onclick = () => {
    setHostMode(false);
    if (callbacks.onHostLogout) callbacks.onHostLogout();
    showNotification('ログアウトしました', 'info');
  };

  document.getElementById('brightness-slider').oninput = (e) => {
    const value = Number(e.target.value);
    document.getElementById('brightness-value').textContent = `${value}%`;
    if (callbacks.onBrightnessChange) callbacks.onBrightnessChange(value / 100);
  };

  document.getElementById('announce-btn').onclick = () => {
    const message = document.getElementById('announce-input').value.trim();
    if (message && callbacks.onAnnounce) {
      callbacks.onAnnounce(message);
      document.getElementById('announce-input').value = '';
    }
  };

  const style = document.createElement('style');
  style.textContent = `
    .toggle-switch { position: relative; width: 44px; height: 24px; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: rgba(255,255,255,0.2);
      transition: 0.3s; border-radius: 24px;
    }
    .toggle-slider:before {
      position: absolute; content: "";
      height: 18px; width: 18px; left: 3px; bottom: 3px;
      background-color: white; transition: 0.3s; border-radius: 50%;
    }
    .toggle-switch input:checked + .toggle-slider {
      background: linear-gradient(135deg, #ff66ff 0%, #66ffff 100%);
    }
    .toggle-switch input:checked + .toggle-slider:before { transform: translateX(20px); }
    .avatar-option:hover { transform: scale(1.05); box-shadow: 0 0 10px rgba(255,102,255,0.5); }
    .bg-option:hover { transform: scale(1.05); box-shadow: 0 0 10px rgba(102,255,255,0.5); }
  `;
  document.head.appendChild(style);

  setHostMode(isHost);
}

window.approveSpeak = (userId) => { if (callbacks.onApproveSpeak) callbacks.onApproveSpeak(userId); };
window.denySpeak    = (userId) => { if (callbacks.onDenySpeak) callbacks.onDenySpeak(userId); };
window.kickSpeaker  = (userId) => { if (callbacks.onKickSpeaker) callbacks.onKickSpeaker(userId); };

export {
  initSettings,
  getSettings,
  showNotification,
  updateSpeakRequests,
  updateCurrentSpeakers,
  updateUserCount,
  setHostMode,
  isHostMode
};
