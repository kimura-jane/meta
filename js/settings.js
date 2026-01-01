// js/settings.js - 設定画面・主催者メニュー

import { getStageBackgrounds } from './venue.js';

// 主催者パスワード（ビルド時に置換される）
const HOST_PASSWORDS = '__HOST_PASSWORDS__'.split(',');

let isHost = false;
let currentUserName = '';
let showNames = true;
let notificationsEnabled = true;
let callbacks = {};

// 背景リスト
const STAGE_BACKGROUNDS = [
    { name: 'IMG_0967', file: 'IMG_0967.png' },
    { name: 'IMG_3273', file: 'IMG_3273.jpeg' },
    { name: 'IMG_3274', file: 'IMG_3274.jpeg' },
    { name: 'IMG_3275', file: 'IMG_3275.jpeg' },
    { name: 'IMG_9719', file: 'IMG_9719.jpeg' }
];

const STAGE_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/stage/';

// 設定の初期化
export function initSettings(userName, cbs) {
    currentUserName = userName;
    callbacks = cbs;
    createSettingsUI();
}

// 設定を取得
export function getSettings() {
    return {
        userName: currentUserName,
        showNames,
        notificationsEnabled,
        isHost
    };
}

// 通知を表示
export function showNotification(message, type = 'info') {
    if (!notificationsEnabled && type === 'join-leave') return;
    
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// 登壇リクエストを更新
export function updateSpeakRequests(requests) {
    const list = document.getElementById('speak-request-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    if (requests.length === 0) {
        list.innerHTML = '<div style="color: #888; font-size: 13px;">リクエストなし</div>';
        return;
    }
    
    requests.forEach(req => {
        const item = document.createElement('div');
        item.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            margin-bottom: 8px;
        `;
        item.innerHTML = `
            <span>${req.name}</span>
            <div>
                <button onclick="window.approveSpeak('${req.id}')" style="
                    padding: 4px 12px;
                    border: none;
                    border-radius: 12px;
                    background: #4caf50;
                    color: white;
                    cursor: pointer;
                    margin-right: 4px;
                ">承認</button>
                <button onclick="window.denySpeak('${req.id}')" style="
                    padding: 4px 12px;
                    border: none;
                    border-radius: 12px;
                    background: #f44336;
                    color: white;
                    cursor: pointer;
                ">却下</button>
            </div>
        `;
        list.appendChild(item);
    });
}

// 現在の登壇者を更新
export function updateCurrentSpeakers(speakers) {
    const list = document.getElementById('current-speakers-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    if (speakers.length === 0) {
        list.innerHTML = '<div style="color: #888; font-size: 13px;">登壇者なし</div>';
        return;
    }
    
    speakers.forEach(speaker => {
        const item = document.createElement('div');
        item.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            margin-bottom: 8px;
        `;
        item.innerHTML = `
            <span>🎤 ${speaker.name}</span>
            ${isHost ? `<button onclick="window.kickSpeaker('${speaker.id}')" style="
                padding: 4px 12px;
                border: none;
                border-radius: 12px;
                background: #ff5722;
                color: white;
                cursor: pointer;
            ">退場</button>` : ''}
        `;
        list.appendChild(item);
    });
}

// 参加者数を更新
export function updateUserCount(count) {
    // HTML側で直接更新されるため、ここでは何もしない
}

// 設定UIを作成
function createSettingsUI() {
    // 設定ボタン（右上に配置）
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'settings-btn';
    settingsBtn.textContent = '⚙️';
    settingsBtn.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: linear-gradient(135deg, rgba(0,0,0,0.8), rgba(30,0,50,0.8));
        color: white;
        border: 2px solid rgba(255, 102, 255, 0.5);
        font-size: 20px;
        cursor: pointer;
        z-index: 100;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(255, 102, 255, 0.3);
    `;
    settingsBtn.onmouseenter = () => {
        settingsBtn.style.transform = 'rotate(90deg) scale(1.1)';
        settingsBtn.style.borderColor = '#ff66ff';
    };
    settingsBtn.onmouseleave = () => {
        settingsBtn.style.transform = 'rotate(0deg) scale(1)';
        settingsBtn.style.borderColor = 'rgba(255, 102, 255, 0.5)';
    };
    document.body.appendChild(settingsBtn);

    // 設定パネル
    const settingsPanel = document.createElement('div');
    settingsPanel.id = 'settings-panel';
    settingsPanel.style.cssText = `
        position: fixed;
        top: 0;
        right: -400px;
        width: 380px;
        max-width: 90vw;
        height: 100%;
        background: linear-gradient(180deg, rgba(10,0,20,0.98), rgba(20,0,40,0.98));
        border-left: 2px solid rgba(255, 102, 255, 0.3);
        z-index: 2000;
        transition: right 0.3s ease;
        overflow-y: auto;
        backdrop-filter: blur(20px);
    `;
    
    // 背景選択HTML生成
    let backgroundOptionsHtml = STAGE_BACKGROUNDS.map(bg => `
        <div class="bg-option" data-url="${STAGE_BASE_URL}${bg.file}" style="
            width: 80px;
            height: 50px;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            border: 2px solid transparent;
            transition: all 0.2s ease;
        ">
            <img src="${STAGE_BASE_URL}${bg.file}" style="width: 100%; height: 100%; object-fit: cover;" alt="${bg.name}">
        </div>
    `).join('');
    
    settingsPanel.innerHTML = `
        <div style="padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                <h2 style="
                    font-size: 20px;
                    font-weight: 700;
                    background: linear-gradient(135deg, #ff66ff, #66ffff);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                ">⚙️ 設定</h2>
                <button id="close-settings" style="
                    background: none;
                    border: none;
                    color: #fff;
                    font-size: 28px;
                    cursor: pointer;
                    padding: 0;
                    line-height: 1;
                ">✕</button>
            </div>

            <!-- 登壇リクエストボタン -->
            <div style="margin-bottom: 24px;">
                <button id="request-stage-btn" style="
                    width: 100%;
                    padding: 14px 20px;
                    border: none;
                    border-radius: 25px;
                    background: linear-gradient(135deg, #667eea, #764ba2, #ff66ff);
                    background-size: 200% 200%;
                    animation: gradientShift 3s ease infinite;
                    color: #fff;
                    font-size: 15px;
                    font-weight: 700;
                    cursor: pointer;
                    box-shadow: 0 4px 20px rgba(118, 75, 162, 0.5);
                    transition: all 0.3s ease;
                ">🎤 登壇リクエスト (0/5)</button>
            </div>

            <!-- 一般設定 -->
            <div style="margin-bottom: 28px;">
                <h3 style="font-size: 14px; color: #ff66ff; margin-bottom: 16px; font-weight: 600;">👤 一般設定</h3>
                
                <div style="margin-bottom: 16px;">
                    <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 6px;">名前</label>
                    <div style="display: flex; gap: 8px;">
                        <input type="text" id="user-name-input" value="${currentUserName}" style="
                            flex: 1;
                            padding: 10px 14px;
                            border: 1px solid rgba(255,102,255,0.3);
                            border-radius: 12px;
                            background: rgba(0,0,0,0.5);
                            color: #fff;
                            font-size: 14px;
                            outline: none;
                        ">
                        <button id="save-name-btn" style="
                            padding: 10px 16px;
                            border: none;
                            border-radius: 12px;
                            background: linear-gradient(135deg, #ff66ff, #9966ff);
                            color: #fff;
                            font-size: 13px;
                            font-weight: 600;
                            cursor: pointer;
                        ">保存</button>
                    </div>
                </div>

                <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 14px;">名前を表示</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="show-names-toggle" ${showNames ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>

                <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 14px;">入退室通知</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="notifications-toggle" ${notificationsEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>

                <button id="reset-camera-btn" style="
                    width: 100%;
                    padding: 12px;
                    border: 1px solid rgba(255,102,255,0.3);
                    border-radius: 12px;
                    background: rgba(255,255,255,0.1);
                    color: #fff;
                    font-size: 14px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                ">📷 カメラ視点をリセット</button>
            </div>

            <!-- 主催者ログイン -->
            <div style="margin-bottom: 28px;">
                <h3 style="font-size: 14px; color: #66ffff; margin-bottom: 16px; font-weight: 600;">👑 主催者メニュー</h3>
                
                <div id="host-login-area" style="${isHost ? 'display:none;' : ''}">
                    <div style="display: flex; gap: 8px;">
                        <input type="password" id="host-password" placeholder="パスワード" style="
                            flex: 1;
                            padding: 10px 14px;
                            border: 1px solid rgba(102,255,255,0.3);
                            border-radius: 12px;
                            background: rgba(0,0,0,0.5);
                            color: #fff;
                            font-size: 14px;
                            outline: none;
                        ">
                        <button id="host-login-btn" style="
                            padding: 10px 16px;
                            border: none;
                            border-radius: 12px;
                            background: linear-gradient(135deg, #66ffff, #6699ff);
                            color: #000;
                            font-size: 13px;
                            font-weight: 600;
                            cursor: pointer;
                        ">認証</button>
                    </div>
                </div>

                <div id="host-menu-area" style="${isHost ? '' : 'display:none;'}">
                    <div style="
                        padding: 12px;
                        background: linear-gradient(135deg, rgba(102,255,255,0.2), rgba(255,102,255,0.1));
                        border-radius: 12px;
                        margin-bottom: 16px;
                        border: 1px solid rgba(102,255,255,0.3);
                    ">
                        <span style="color: #66ffff; font-weight: 600;">👑 主催者モード有効</span>
                    </div>

                    <!-- 明るさ調整 -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 8px;">🔆 部屋の明るさ</label>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <input type="range" id="brightness-slider" min="0" max="100" value="60" style="
                                flex: 1;
                                height: 6px;
                                -webkit-appearance: none;
                                background: linear-gradient(90deg, #333, #ff66ff);
                                border-radius: 3px;
                                outline: none;
                            ">
                            <span id="brightness-value" style="color: #fff; font-size: 14px; min-width: 40px;">60%</span>
                        </div>
                    </div>

                    <!-- 背景選択 -->
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 8px;">🖼️ 背景画像</label>
                        <div id="background-options" style="
                            display: flex;
                            flex-wrap: wrap;
                            gap: 10px;
                        ">
                            ${backgroundOptionsHtml}
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 8px;">📋 登壇リクエスト</label>
                        <div id="speak-request-list" style="
                            max-height: 150px;
                            overflow-y: auto;
                            padding: 8px;
                            background: rgba(0,0,0,0.3);
                            border-radius: 8px;
                        ">
                            <div style="color: #888; font-size: 13px;">リクエストなし</div>
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 8px;">🎤 現在の登壇者</label>
                        <div id="current-speakers-list" style="
                            max-height: 150px;
                            overflow-y: auto;
                            padding: 8px;
                            background: rgba(0,0,0,0.3);
                            border-radius: 8px;
                        ">
                            <div style="color: #888; font-size: 13px;">登壇者なし</div>
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; color: #aaa; margin-bottom: 8px;">📢 全体アナウンス</label>
                        <input type="text" id="announce-input" placeholder="アナウンス内容..." style="
                            width: 100%;
                            padding: 10px 14px;
                            border: 1px solid rgba(102,255,255,0.3);
                            border-radius: 12px;
                            background: rgba(0,0,0,0.5);
                            color: #fff;
                            font-size: 13px;
                            outline: none;
                            margin-bottom: 8px;
                            box-sizing: border-box;
                        ">
                        <button id="send-announce-btn" style="
                            width: 100%;
                            padding: 10px;
                            border: none;
                            border-radius: 12px;
                            background: linear-gradient(135deg, #ff6666, #ff66ff);
                            color: #fff;
                            font-size: 13px;
                            font-weight: 600;
                            cursor: pointer;
                        ">📢 送信</button>
                    </div>

                    <button id="host-logout-btn" style="
                        width: 100%;
                        padding: 12px;
                        border: 1px solid rgba(255,100,100,0.5);
                        border-radius: 12px;
                        background: rgba(255,100,100,0.2);
                        color: #ff6666;
                        font-size: 14px;
                        cursor: pointer;
                    ">🚪 主催者モード終了</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(settingsPanel);

    // トグルスイッチ用スタイル追加
    const style = document.createElement('style');
    style.textContent = `
        .toggle-switch {
            position: relative;
            width: 50px;
            height: 26px;
            display: inline-block;
        }
        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #333;
            border-radius: 26px;
            transition: 0.3s;
        }
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 20px;
            width: 20px;
            left: 3px;
            bottom: 3px;
            background: white;
            border-radius: 50%;
            transition: 0.3s;
        }
        .toggle-switch input:checked + .toggle-slider {
            background: linear-gradient(135deg, #ff66ff, #66ffff);
        }
        .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(24px);
        }
        
        @keyframes gradientShift {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }
        
        #brightness-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        
        .bg-option:hover {
            border-color: #ff66ff !important;
            transform: scale(1.05);
        }
        .bg-option.selected {
            border-color: #66ffff !important;
            box-shadow: 0 0 10px rgba(102, 255, 255, 0.5);
        }
    `;
    document.head.appendChild(style);

    // オーバーレイ
    const overlay = document.createElement('div');
    overlay.id = 'settings-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        z-index: 1999;
        display: none;
        backdrop-filter: blur(5px);
    `;
    document.body.appendChild(overlay);

    // イベントリスナー
    setupEventListeners();
}

function setupEventListeners() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const overlay = document.getElementById('settings-overlay');
    const closeBtn = document.getElementById('close-settings');

    // パネル開閉
    settingsBtn.addEventListener('click', () => {
        settingsPanel.style.right = '0';
        overlay.style.display = 'block';
    });

    closeBtn.addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);

    function closePanel() {
        settingsPanel.style.right = '-400px';
        overlay.style.display = 'none';
    }

    // 登壇リクエストボタン
    const requestStageBtn = document.getElementById('request-stage-btn');
    if (requestStageBtn) {
        requestStageBtn.addEventListener('click', () => {
            if (callbacks.onRequestSpeak) callbacks.onRequestSpeak();
        });
    }

    // 名前保存
    document.getElementById('save-name-btn').addEventListener('click', () => {
        const newName = document.getElementById('user-name-input').value.trim();
        if (newName && newName !== currentUserName) {
            currentUserName = newName;
            if (callbacks.onNameChange) callbacks.onNameChange(newName);
        }
    });

    // 名前表示トグル
    document.getElementById('show-names-toggle').addEventListener('change', (e) => {
        showNames = e.target.checked;
        if (callbacks.onShowNamesChange) callbacks.onShowNamesChange(showNames);
    });

    // 通知トグル
    document.getElementById('notifications-toggle').addEventListener('change', (e) => {
        notificationsEnabled = e.target.checked;
    });

    // カメラリセット
    document.getElementById('reset-camera-btn').addEventListener('click', () => {
        if (callbacks.onResetCamera) callbacks.onResetCamera();
    });

    // 主催者ログイン
    document.getElementById('host-login-btn').addEventListener('click', () => {
        const password = document.getElementById('host-password').value;
        if (HOST_PASSWORDS.includes(password)) {
            isHost = true;
            document.getElementById('host-login-area').style.display = 'none';
            document.getElementById('host-menu-area').style.display = 'block';
            showNotification('👑 主催者モードが有効になりました');
        } else {
            showNotification('パスワードが違います');
        }
    });

    // 主催者ログアウト
    document.getElementById('host-logout-btn').addEventListener('click', () => {
        isHost = false;
        document.getElementById('host-login-area').style.display = 'block';
        document.getElementById('host-menu-area').style.display = 'none';
        document.getElementById('host-password').value = '';
        showNotification('主催者モードを終了しました');
    });

    // 明るさスライダー
    const brightnessSlider = document.getElementById('brightness-slider');
    const brightnessValue = document.getElementById('brightness-value');
    if (brightnessSlider) {
        brightnessSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            brightnessValue.textContent = `${value}%`;
            if (callbacks.onBrightnessChange) {
                callbacks.onBrightnessChange(value / 100);
            }
        });
    }

    // 背景選択
    document.querySelectorAll('.bg-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            const url = option.dataset.url;
            if (callbacks.onChangeBackground) {
                callbacks.onChangeBackground(url);
            }
        });
    });

    // アナウンス送信
    document.getElementById('send-announce-btn').addEventListener('click', () => {
        const text = document.getElementById('announce-input').value.trim();
        if (text) {
            if (callbacks.onAnnounce) callbacks.onAnnounce(text);
            document.getElementById('announce-input').value = '';
        }
    });

    // グローバル関数（主催者用）
    window.approveSpeak = (id) => {
        if (callbacks.onApproveSpeak) callbacks.onApproveSpeak(id);
    };
    window.denySpeak = (id) => {
        if (callbacks.onDenySpeak) callbacks.onDenySpeak(id);
    };
    window.kickSpeaker = (id) => {
        if (callbacks.onKickSpeaker) callbacks.onKickSpeaker(id);
    };
}
