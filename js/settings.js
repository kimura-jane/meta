// ============================================
// 設定画面・主催者メニュー
// ============================================

import { debugLog } from './utils.js';

// --------------------------------------------
// 状態
// --------------------------------------------
let isHost = false;
let currentUserName = '';
let showNames = true;
let showNotifications = true;

// 主催者パスワード
const HOST_PASSWORDS = ['host2024', 'admin123', 'organizer'];

// コールバック
let callbacks = {
    onNameChange: null,
    onResetCamera: null,
    onApproveSpeak: null,
    onDenySpeak: null,
    onKickSpeaker: null,
    onChangeBackground: null,
    onAnnounce: null,
    onShowNamesChange: null
};

// --------------------------------------------
// 初期化
// --------------------------------------------
export function initSettings(userName, cbs) {
    currentUserName = userName;
    callbacks = { ...callbacks, ...cbs };
    createSettingsUI();
    debugLog('設定画面初期化', 'success');
}

export function getSettings() {
    return {
        isHost,
        showNames,
        showNotifications,
        currentUserName
    };
}

export function isHostUser() {
    return isHost;
}

// --------------------------------------------
// 設定UIの作成
// --------------------------------------------
function createSettingsUI() {
    // 設定ボタン
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'settings-btn';
    settingsBtn.textContent = '⚙️';
    settingsBtn.style.cssText = `
        position: fixed;
        top: 60px;
        right: 10px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: rgba(0,0,0,0.7);
        color: white;
        border: 1px solid #444;
        font-size: 20px;
        cursor: pointer;
        z-index: 1000;
    `;
    settingsBtn.onclick = () => toggleSettingsPanel(true);
    document.body.appendChild(settingsBtn);

    // 設定パネル
    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.style.cssText = `
        position: fixed;
        top: 0;
        right: -320px;
        width: 300px;
        height: 100%;
        background: rgba(20,20,30,0.95);
        border-left: 1px solid #444;
        z-index: 2000;
        transition: right 0.3s ease;
        overflow-y: auto;
        padding: 20px;
        box-sizing: border-box;
    `;
    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="margin:0;color:#fff;font-size:18px;">⚙️ 設定</h2>
            <button id="close-settings" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;">&times;</button>
        </div>
        
        <!-- 一般設定 -->
        <div class="settings-section">
            <h3 style="color:#ff66ff;font-size:14px;margin:15px 0 10px;">一般設定</h3>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:block;margin-bottom:5px;">名前</label>
                <input type="text" id="setting-name" maxlength="20" style="
                    width:100%;
                    padding:8px;
                    background:#333;
                    border:1px solid #555;
                    border-radius:4px;
                    color:#fff;
                    box-sizing:border-box;
                ">
                <button id="save-name-btn" style="
                    margin-top:8px;
                    padding:6px 12px;
                    background:#ff66ff;
                    border:none;
                    border-radius:4px;
                    color:#fff;
                    cursor:pointer;
                    font-size:12px;
                ">名前を変更</button>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:flex;align-items:center;cursor:pointer;">
                    <input type="checkbox" id="setting-show-names" checked style="margin-right:8px;">
                    名前を表示する
                </label>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:flex;align-items:center;cursor:pointer;">
                    <input type="checkbox" id="setting-notifications" checked style="margin-right:8px;">
                    入退室通知を表示
                </label>
            </div>
            
            <button id="reset-camera-btn" style="
                width:100%;
                padding:10px;
                background:#444;
                border:none;
                border-radius:4px;
                color:#fff;
                cursor:pointer;
                font-size:12px;
            ">📷 カメラ視点をリセット</button>
        </div>
        
        <!-- 主催者ログイン -->
        <div class="settings-section" id="host-login-section">
            <h3 style="color:#ff66ff;font-size:14px;margin:25px 0 10px;">主催者ログイン</h3>
            <div style="margin-bottom:10px;">
                <input type="password" id="host-password" placeholder="パスワードを入力" style="
                    width:100%;
                    padding:8px;
                    background:#333;
                    border:1px solid #555;
                    border-radius:4px;
                    color:#fff;
                    box-sizing:border-box;
                ">
            </div>
            <button id="host-login-btn" style="
                width:100%;
                padding:10px;
                background:#66ffff;
                border:none;
                border-radius:4px;
                color:#000;
                cursor:pointer;
                font-size:12px;
                font-weight:bold;
            ">🔐 ログイン</button>
            <p id="host-login-error" style="color:#ff6b6b;font-size:11px;margin-top:5px;display:none;">パスワードが違います</p>
        </div>
        
        <!-- 主催者メニュー -->
        <div class="settings-section" id="host-menu-section" style="display:none;">
            <h3 style="color:#66ffff;font-size:14px;margin:25px 0 10px;">👑 主催者メニュー</h3>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:block;margin-bottom:8px;">登壇リクエスト</label>
                <div id="speak-requests-list" style="
                    background:#222;
                    border-radius:4px;
                    padding:8px;
                    max-height:120px;
                    overflow-y:auto;
                    font-size:12px;
                    color:#888;
                ">リクエストはありません</div>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:block;margin-bottom:8px;">現在の登壇者</label>
                <div id="current-speakers-list" style="
                    background:#222;
                    border-radius:4px;
                    padding:8px;
                    max-height:120px;
                    overflow-y:auto;
                    font-size:12px;
                    color:#888;
                ">登壇者はいません</div>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:block;margin-bottom:5px;">背景画像URL</label>
                <input type="text" id="background-url" placeholder="https://..." style="
                    width:100%;
                    padding:8px;
                    background:#333;
                    border:1px solid #555;
                    border-radius:4px;
                    color:#fff;
                    box-sizing:border-box;
                    font-size:11px;
                ">
                <button id="change-bg-btn" style="
                    margin-top:8px;
                    padding:6px 12px;
                    background:#ff66ff;
                    border:none;
                    border-radius:4px;
                    color:#fff;
                    cursor:pointer;
                    font-size:12px;
                ">🖼️ 背景を変更</button>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa;font-size:12px;display:block;margin-bottom:5px;">全体アナウンス</label>
                <textarea id="announce-text" placeholder="メッセージを入力..." style="
                    width:100%;
                    padding:8px;
                    background:#333;
                    border:1px solid #555;
                    border-radius:4px;
                    color:#fff;
                    box-sizing:border-box;
                    font-size:12px;
                    resize:none;
                    height:60px;
                "></textarea>
                <button id="send-announce-btn" style="
                    margin-top:8px;
                    padding:6px 12px;
                    background:#ffff66;
                    border:none;
                    border-radius:4px;
                    color:#000;
                    cursor:pointer;
                    font-size:12px;
                    font-weight:bold;
                ">📢 送信</button>
            </div>
            
            <button id="host-logout-btn" style="
                width:100%;
                padding:10px;
                background:#ff6b6b;
                border:none;
                border-radius:4px;
                color:#fff;
                cursor:pointer;
                font-size:12px;
                margin-top:10px;
            ">ログアウト</button>
        </div>
    `;
    document.body.appendChild(panel);

    setupSettingsListeners();
}

// --------------------------------------------
// イベントリスナー
// --------------------------------------------
function setupSettingsListeners() {
    document.getElementById('close-settings').onclick = () => toggleSettingsPanel(false);

    document.getElementById('setting-name').value = currentUserName;
    document.getElementById('save-name-btn').onclick = () => {
        const newName = document.getElementById('setting-name').value.trim();
        if (newName && newName !== currentUserName) {
            currentUserName = newName;
            if (callbacks.onNameChange) callbacks.onNameChange(newName);
            debugLog(`名前を変更: ${newName}`, 'success');
        }
    };

    document.getElementById('setting-show-names').onchange = (e) => {
        showNames = e.target.checked;
        if (callbacks.onShowNamesChange) callbacks.onShowNamesChange(showNames);
    };

    document.getElementById('setting-notifications').onchange = (e) => {
        showNotifications = e.target.checked;
    };

    document.getElementById('reset-camera-btn').onclick = () => {
        if (callbacks.onResetCamera) callbacks.onResetCamera();
        debugLog('カメラ視点をリセット', 'info');
    };

    document.getElementById('host-login-btn').onclick = () => {
        const password = document.getElementById('host-password').value;
        if (HOST_PASSWORDS.includes(password)) {
            isHost = true;
            document.getElementById('host-login-section').style.display = 'none';
            document.getElementById('host-menu-section').style.display = 'block';
            document.getElementById('host-password').value = '';
            document.getElementById('host-login-error').style.display = 'none';
            debugLog('主催者としてログイン', 'success');
        } else {
            document.getElementById('host-login-error').style.display = 'block';
        }
    };

    document.getElementById('host-logout-btn').onclick = () => {
        isHost = false;
        document.getElementById('host-login-section').style.display = 'block';
        document.getElementById('host-menu-section').style.display = 'none';
        debugLog('主催者からログアウト', 'info');
    };

    document.getElementById('change-bg-btn').onclick = () => {
        const url = document.getElementById('background-url').value.trim();
        if (url && callbacks.onChangeBackground) {
            callbacks.onChangeBackground(url);
            debugLog(`背景を変更: ${url}`, 'success');
        }
    };

    document.getElementById('send-announce-btn').onclick = () => {
        const text = document.getElementById('announce-text').value.trim();
        if (text && callbacks.onAnnounce) {
            callbacks.onAnnounce(text);
            document.getElementById('announce-text').value = '';
            debugLog(`アナウンス送信: ${text}`, 'success');
        }
    };
}

// --------------------------------------------
// パネル表示/非表示
// --------------------------------------------
function toggleSettingsPanel(show) {
    const panel = document.getElementById('settings-panel');
    if (panel) {
        panel.style.right = show ? '0' : '-320px';
    }
}

// --------------------------------------------
// 登壇リクエスト更新
// --------------------------------------------
export function updateSpeakRequests(requests) {
    const list = document.getElementById('speak-requests-list');
    if (!list) return;

    if (!requests || requests.length === 0) {
        list.innerHTML = '<span style="color:#666;">リクエストはありません</span>';
        return;
    }

    list.innerHTML = requests.map(req => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #333;">
            <span style="color:#fff;">${req.name}</span>
            <div>
                <button onclick="window.approveSpeak('${req.id}')" style="
                    padding:3px 8px;
                    background:#51cf66;
                    border:none;
                    border-radius:3px;
                    color:#fff;
                    cursor:pointer;
                    font-size:11px;
                    margin-right:4px;
                ">✓</button>
                <button onclick="window.denySpeak('${req.id}')" style="
                    padding:3px 8px;
                    background:#ff6b6b;
                    border:none;
                    border-radius:3px;
                    color:#fff;
                    cursor:pointer;
                    font-size:11px;
                ">✕</button>
            </div>
        </div>
    `).join('');

    window.approveSpeak = (id) => {
        if (callbacks.onApproveSpeak) callbacks.onApproveSpeak(id);
    };
    window.denySpeak = (id) => {
        if (callbacks.onDenySpeak) callbacks.onDenySpeak(id);
    };
}

// --------------------------------------------
// 現在の登壇者更新
// --------------------------------------------
export function updateCurrentSpeakers(speakers) {
    const list = document.getElementById('current-speakers-list');
    if (!list) return;

    if (!speakers || speakers.length === 0) {
        list.innerHTML = '<span style="color:#666;">登壇者はいません</span>';
        return;
    }

    list.innerHTML = speakers.map(sp => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #333;">
            <span style="color:#fff;">🎤 ${sp.name}</span>
            <button onclick="window.kickSpeaker('${sp.id}')" style="
                padding:3px 8px;
                background:#ff6b6b;
                border:none;
                border-radius:3px;
                color:#fff;
                cursor:pointer;
                font-size:11px;
            ">退場</button>
        </div>
    `).join('');

    window.kickSpeaker = (id) => {
        if (callbacks.onKickSpeaker) callbacks.onKickSpeaker(id);
    };
}

// --------------------------------------------
// 通知表示
// --------------------------------------------
export function showNotification(message, type = 'info') {
    if (!showNotifications && type === 'join-leave') return;

    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 60px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 20px;
        background: ${type === 'announce' ? 'rgba(255,255,100,0.9)' : 'rgba(0,0,0,0.8)'};
        color: ${type === 'announce' ? '#000' : '#fff'};
        border-radius: 20px;
        font-size: 14px;
        z-index: 3000;
        animation: fadeInOut 3s ease forwards;
        ${type === 'announce' ? 'font-weight:bold;' : ''}
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.remove(), 3000);
}

// アニメーション用CSS追加
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeInOut {
        0% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        15% { opacity: 1; transform: translateX(-50%) translateY(0); }
        85% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
    }
`;
document.head.appendChild(style);
