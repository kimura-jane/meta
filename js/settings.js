// 設定画面・主催者メニュー

// 主催者パスワード（GitHub Secretsから置換される）
const HOST_PASSWORD = '_HOST_PASSWORDS_';

// 背景画像データ
const STAGE_BACKGROUNDS = [
    { name: 'IMG_0967', file: 'IMG_0967.png' },
    { name: 'IMG_3273', file: 'IMG_3273.jpeg' },
    { name: 'IMG_3274', file: 'IMG_3274.jpeg' },
    { name: 'IMG_3275', file: 'IMG_3275.jpeg' },
    { name: 'IMG_9719', file: 'IMG_9719.jpeg' }
];

const STAGE_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/stage/';

// アバター画像データ
const CHARA_LIST = [
    '12555',
    'IMG_1677',
    'IMG_1861',
    'IMG_1889',
    'IMG_2958',
    'IMG_3264',
    'IMG_3267',
    'IMG_3269',
    'IMG_7483',
    'onigiriya_kanatake_512'
];

const CHARA_EXTENSIONS = {
    '12555': 'png',
    'IMG_1677': 'jpeg',
    'IMG_1861': 'png',
    'IMG_1889': 'png',
    'IMG_2958': 'png',
    'IMG_3264': 'png',
    'IMG_3267': 'png',
    'IMG_3269': 'png',
    'IMG_7483': 'png',
    'onigiriya_kanatake_512': 'png'
};

const CHARA_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/chara/';

// 状態
let isHost = false;
let currentSettings = {
    userName: 'ゲスト',
    visibleNames: true,
    notifications: true,
    selectedAvatar: null
};
let callbacks = {};

// 初期化
function initSettings(userName, cbs) {
    currentSettings.userName = userName;
    callbacks = cbs;
    createSettingsUI();
}

// 設定取得
function getSettings() {
    return { ...currentSettings };
}

// 通知表示
function showNotification(message, type = 'info') {
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// 登壇リクエスト更新
function updateSpeakRequests(requests) {
    const list = document.getElementById('speak-request-list');
    if (!list) return;
    
    if (requests.length === 0) {
        list.innerHTML = '<div style="color: #888; font-size: 12px;">リクエストなし</div>';
        return;
    }
    
    list.innerHTML = requests.map(req => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 4px;">
            <span>${req.name}</span>
            <div>
                <button onclick="window.approveSpeak('${req.id}')" style="background: #4CAF50; border: none; color: white; padding: 4px 8px; border-radius: 4px; margin-right: 4px; cursor: pointer;">承認</button>
                <button onclick="window.denySpeak('${req.id}')" style="background: #f44336; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer;">却下</button>
            </div>
        </div>
    `).join('');
}

// 現在の登壇者更新
function updateCurrentSpeakers(speakers) {
    const list = document.getElementById('current-speakers-list');
    if (!list) return;
    
    if (speakers.length === 0) {
        list.innerHTML = '<div style="color: #888; font-size: 12px;">登壇者なし</div>';
        return;
    }
    
    list.innerHTML = speakers.map(speaker => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 4px;">
            <span>🎤 ${speaker.name}</span>
            <button onclick="window.kickSpeaker('${speaker.id}')" style="background: #f44336; border: none; color: white; padding: 4px 8px; border-radius: 4px; cursor: pointer;">退場</button>
        </div>
    `).join('');
}

// ユーザー数更新
function updateUserCount(count) {
    // main.jsで直接DOMを更新
}

// 設定UI作成
function createSettingsUI() {
    // 設定ボタン（右上）
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'settings-btn';
    settingsBtn.innerHTML = '⚙️';
    settingsBtn.style.cssText = `
        position: fixed;
        top: 60px;
        right: 16px;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: linear-gradient(135deg, rgba(0,0,0,0.8), rgba(30,0,50,0.8));
        color: white;
        border: 1px solid rgba(255, 102, 255, 0.5);
        font-size: 18px;
        cursor: pointer;
        z-index: 100;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
    `;
    document.body.appendChild(settingsBtn);
    
    // オーバーレイ
    const overlay = document.createElement('div');
    overlay.id = 'settings-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.7);
        z-index: 999;
        display: none;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    document.body.appendChild(overlay);
    
    // 設定パネル
    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.style.cssText = `
        position: fixed;
        top: 0;
        right: -350px;
        width: 320px;
        height: 100%;
        background: linear-gradient(180deg, rgba(20,0,40,0.98), rgba(0,0,0,0.98));
        z-index: 1000;
        padding: 20px;
        overflow-y: auto;
        transition: right 0.3s ease;
        border-left: 1px solid rgba(255,102,255,0.3);
    `;
    
    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2 style="margin: 0; font-size: 20px; color: #ff66ff;">⚙️ 設定</h2>
            <button id="close-settings" style="background: none; border: none; color: white; font-size: 24px; cursor: pointer;">✕</button>
        </div>
        
        <!-- 登壇リクエストボタン -->
        <div style="margin-bottom: 20px;">
            <button id="request-stage-btn-panel" style="
                width: 100%;
                padding: 12px;
                background: linear-gradient(135deg, #ff6600, #ff3366, #ff66ff);
                border: none;
                border-radius: 12px;
                color: white;
                font-size: 14px;
                font-weight: bold;
                cursor: pointer;
            ">🎤 登壇リクエスト (0/5)</button>
        </div>
        
        <!-- アバター選択 -->
        <div style="margin-bottom: 20px; padding: 15px; background: rgba(255,255,255,0.05); border-radius: 12px;">
            <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #66ffff;">🎭 アバター選択</h3>
            <div id="avatar-selection" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
            </div>
        </div>
        
        <!-- 一般設定 -->
        <div style="margin-bottom: 20px; padding: 15px; background: rgba(255,255,255,0.05); border-radius: 12px;">
            <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #66ffff;">👤 一般設定</h3>
            
            <div style="margin-bottom: 12px;">
                <label style="font-size: 12px; color: #aaa;">名前</label>
                <div style="display: flex; gap: 8px; margin-top: 4px;">
                    <input type="text" id="user-name-input" value="${currentSettings.userName}" style="
                        flex: 1;
                        padding: 8px;
                        background: rgba(0,0,0,0.5);
                        border: 1px solid rgba(255,255,255,0.2);
                        border-radius: 8px;
                        color: white;
                        font-size: 14px;
                    ">
                    <button id="save-name-btn" style="
                        padding: 8px 12px;
                        background: linear-gradient(135deg, #ff66ff, #66ffff);
                        border: none;
                        border-radius: 8px;
                        color: white;
                        font-size: 12px;
                        cursor: pointer;
                    ">保存</button>
                </div>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="font-size: 12px;">名前を表示</span>
                <label class="toggle-switch">
                    <input type="checkbox" id="show-names-toggle" ${currentSettings.visibleNames ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <span style="font-size: 12px;">入退室通知</span>
                <label class="toggle-switch">
                    <input type="checkbox" id="notifications-toggle" ${currentSettings.notifications ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            
            <button id="reset-camera-btn" style="
                width: 100%;
                padding: 8px;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 8px;
                color: white;
                font-size: 12px;
                cursor: pointer;
            ">📷 カメラ視点リセット</button>
        </div>
        
        <!-- 主催者ログイン -->
        <div style="margin-bottom: 20px; padding: 15px; background: rgba(255,255,255,0.05); border-radius: 12px;">
            <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #66ffff;">🔐 主催者ログイン</h3>
            
            <div id="host-login-area">
                <div style="display: flex; gap: 8px;">
                    <input type="password" id="host-password-input" placeholder="パスワード" style="
                        flex: 1;
                        padding: 8px;
                        background: rgba(0,0,0,0.5);
                        border: 1px solid rgba(255,255,255,0.2);
                        border-radius: 8px;
                        color: white;
                        font-size: 14px;
                    ">
                    <button id="host-login-btn" style="
                        padding: 8px 12px;
                        background: linear-gradient(135deg, #ff66ff, #66ffff);
                        border: none;
                        border-radius: 8px;
                        color: white;
                        font-size: 12px;
                        cursor: pointer;
                    ">認証</button>
                </div>
            </div>
            
            <div id="host-menu-area" style="display: none;">
                <div style="background: linear-gradient(135deg, #ff66ff, #66ffff); padding: 8px; border-radius: 8px; text-align: center; margin-bottom: 12px;">
                    <span style="font-weight: bold;">✨ 主催者モード有効</span>
                </div>
                
                <!-- 明るさ調整 -->
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: #aaa;">🔆 部屋の明るさ</label>
                    <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                        <input type="range" id="brightness-slider" min="0" max="100" value="60" style="flex: 1;">
                        <span id="brightness-value" style="font-size: 12px; width: 40px;">60%</span>
                    </div>
                </div>
                
                <!-- 背景選択 -->
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: #aaa;">🖼️ ステージ背景</label>
                    <div id="background-selection" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px;">
                    </div>
                </div>
                
                <!-- 登壇リクエスト一覧 -->
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: #aaa;">📋 登壇リクエスト</label>
                    <div id="speak-request-list" style="margin-top: 8px;">
                        <div style="color: #888; font-size: 12px;">リクエストなし</div>
                    </div>
                </div>
                
                <!-- 現在の登壇者 -->
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: #aaa;">🎤 現在の登壇者</label>
                    <div id="current-speakers-list" style="margin-top: 8px;">
                        <div style="color: #888; font-size: 12px;">登壇者なし</div>
                    </div>
                </div>
                
                <!-- アナウンス -->
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: #aaa;">📢 全体アナウンス</label>
                    <div style="display: flex; gap: 8px; margin-top: 4px;">
                        <input type="text" id="announce-input" placeholder="メッセージ" style="
                            flex: 1;
                            padding: 8px;
                            background: rgba(0,0,0,0.5);
                            border: 1px solid rgba(255,255,255,0.2);
                            border-radius: 8px;
                            color: white;
                            font-size: 14px;
                        ">
                        <button id="send-announce-btn" style="
                            padding: 8px 12px;
                            background: linear-gradient(135deg, #ff66ff, #66ffff);
                            border: none;
                            border-radius: 8px;
                            color: white;
                            font-size: 12px;
                            cursor: pointer;
                        ">送信</button>
                    </div>
                </div>
                
                <button id="host-logout-btn" style="
                    width: 100%;
                    padding: 8px;
                    background: rgba(255,0,0,0.3);
                    border: 1px solid rgba(255,0,0,0.5);
                    border-radius: 8px;
                    color: white;
                    font-size: 12px;
                    cursor: pointer;
                ">ログアウト</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(panel);
    
    // スタイル追加
    const style = document.createElement('style');
    style.textContent = `
        .toggle-switch {
            position: relative;
            width: 44px;
            height: 24px;
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
            background: rgba(255,255,255,0.2);
            border-radius: 24px;
            transition: 0.3s;
        }
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
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
            transform: translateX(20px);
        }
        .bg-option {
            width: 100%;
            aspect-ratio: 16/9;
            border-radius: 8px;
            border: 2px solid transparent;
            cursor: pointer;
            object-fit: cover;
            transition: all 0.3s ease;
        }
        .bg-option:hover {
            border-color: rgba(255,102,255,0.5);
        }
        .bg-option.selected {
            border-color: #ff66ff;
            box-shadow: 0 0 10px rgba(255,102,255,0.5);
        }
        .avatar-option {
            width: 100%;
            aspect-ratio: 1;
            border-radius: 8px;
            border: 2px solid transparent;
            cursor: pointer;
            object-fit: cover;
            transition: all 0.3s ease;
            background: rgba(0,0,0,0.3);
        }
        .avatar-option:hover {
            border-color: rgba(255,102,255,0.5);
        }
        .avatar-option.selected {
            border-color: #ff66ff;
            box-shadow: 0 0 10px rgba(255,102,255,0.5);
        }
    `;
    document.head.appendChild(style);
    
    // アバター選択肢を生成
    const avatarSelection = document.getElementById('avatar-selection');
    CHARA_LIST.forEach(name => {
        const ext = CHARA_EXTENSIONS[name] || 'png';
        const img = document.createElement('img');
        img.src = `${CHARA_BASE_URL}${name}.${ext}`;
        img.className = 'avatar-option';
        img.title = name;
        img.onclick = () => {
            document.querySelectorAll('.avatar-option').forEach(el => el.classList.remove('selected'));
            img.classList.add('selected');
            currentSettings.selectedAvatar = name;
            if (callbacks.onAvatarChange) {
                callbacks.onAvatarChange(name);
            }
            showNotification(`アバターを変更しました`, 'success');
        };
        avatarSelection.appendChild(img);
    });
    
    // 背景選択肢を生成
    const bgSelection = document.getElementById('background-selection');
    STAGE_BACKGROUNDS.forEach(bg => {
        const img = document.createElement('img');
        img.src = `${STAGE_BASE_URL}${bg.file}`;
        img.className = 'bg-option';
        img.title = bg.name;
        img.onclick = () => {
            document.querySelectorAll('.bg-option').forEach(el => el.classList.remove('selected'));
            img.classList.add('selected');
            if (callbacks.onChangeBackground) {
                callbacks.onChangeBackground(`${STAGE_BASE_URL}${bg.file}`);
            }
        };
        bgSelection.appendChild(img);
    });
    
    // イベントリスナー
    settingsBtn.onclick = () => {
        overlay.style.display = 'block';
        setTimeout(() => {
            overlay.style.opacity = '1';
            panel.style.right = '0';
        }, 10);
    };
    
    const closeSettings = () => {
        overlay.style.opacity = '0';
        panel.style.right = '-350px';
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    };
    
    document.getElementById('close-settings').onclick = closeSettings;
    overlay.onclick = closeSettings;
    
    // 登壇リクエストボタン
    document.getElementById('request-stage-btn-panel').onclick = () => {
        if (callbacks.onRequestSpeak) {
            callbacks.onRequestSpeak();
        }
    };
    
    // 名前保存
    document.getElementById('save-name-btn').onclick = () => {
        const newName = document.getElementById('user-name-input').value.trim();
        if (newName && newName !== currentSettings.userName) {
            currentSettings.userName = newName;
            if (callbacks.onNameChange) {
                callbacks.onNameChange(newName);
            }
        }
    };
    
    // 名前表示切替
    document.getElementById('show-names-toggle').onchange = (e) => {
        currentSettings.visibleNames = e.target.checked;
        if (callbacks.onShowNamesChange) {
            callbacks.onShowNamesChange(e.target.checked);
        }
    };
    
    // 通知切替
    document.getElementById('notifications-toggle').onchange = (e) => {
        currentSettings.notifications = e.target.checked;
    };
    
    // カメラリセット
    document.getElementById('reset-camera-btn').onclick = () => {
        if (callbacks.onResetCamera) {
            callbacks.onResetCamera();
        }
        showNotification('カメラをリセットしました', 'info');
    };
    
    // 主催者ログイン
    document.getElementById('host-login-btn').onclick = () => {
        const password = document.getElementById('host-password-input').value.trim();
        
        if (password === HOST_PASSWORD) {
            isHost = true;
            document.getElementById('host-login-area').style.display = 'none';
            document.getElementById('host-menu-area').style.display = 'block';
            showNotification('主催者モードが有効になりました', 'success');
        } else {
            showNotification('パスワードが正しくありません', 'error');
        }
    };
    
    // 主催者ログアウト
    document.getElementById('host-logout-btn').onclick = () => {
        isHost = false;
        document.getElementById('host-login-area').style.display = 'block';
        document.getElementById('host-menu-area').style.display = 'none';
        document.getElementById('host-password-input').value = '';
        showNotification('ログアウトしました', 'info');
    };
    
    // 明るさ調整
    document.getElementById('brightness-slider').oninput = (e) => {
        const value = e.target.value;
        document.getElementById('brightness-value').textContent = `${value}%`;
        if (callbacks.onBrightnessChange) {
            callbacks.onBrightnessChange(value / 100);
        }
    };
    
    // アナウンス送信
    document.getElementById('send-announce-btn').onclick = () => {
        const message = document.getElementById('announce-input').value.trim();
        if (message) {
            if (callbacks.onAnnounce) {
                callbacks.onAnnounce(message);
            }
            document.getElementById('announce-input').value = '';
            showNotification('アナウンスを送信しました', 'success');
        }
    };
}

// グローバル関数
window.approveSpeak = (userId) => {
    if (callbacks.onApproveSpeak) {
        callbacks.onApproveSpeak(userId);
    }
};

window.denySpeak = (userId) => {
    if (callbacks.onDenySpeak) {
        callbacks.onDenySpeak(userId);
    }
};

window.kickSpeaker = (userId) => {
    if (callbacks.onKickSpeaker) {
        callbacks.onKickSpeaker(userId);
    }
};

// エクスポート
export { initSettings, getSettings, showNotification, updateSpeakRequests, updateCurrentSpeakers, updateUserCount };
