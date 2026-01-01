// メタバース空間メインスクリプト (Three.js)

import { initVenue, createAllVenue, animateVenue, changeStageBackground, setRoomBrightness } from './venue.js';
import { 
    connectToPartyKit, sendPosition, sendReaction, sendChat, sendNameChange,
    sendBackgroundChange, sendBrightness, requestSpeak, stopSpeaking, toggleMic, setCallbacks, getState
} from './connection.js';
import { initSettings, getSettings, showNotification, updateSpeakRequests, updateCurrentSpeakers } from './settings.js';
import { createAvatar, setAvatarImage, setAvatarSpotlight, createPenlight, debugLog } from './utils.js';

// Three.js基本設定
let scene, camera, renderer;
let myAvatar, myPenlight;
let myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
let myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);
let remoteAvatars = new Map();

// アバター画像リスト
const CHARA_LIST = [
    '12444',
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
    '12444': 'png',
    '12555': 'png',
    'IMG_1677': 'png',
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

// 状態管理
let isOnStage = false;
let isPenlightActive = false;
let isOtageiActive = false;
let penlightColor = '#ff00ff';
let penlightInterval = null;
let otageiInterval = null;

// 初期化
function init() {
    // シーン作成
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0010);
    scene.fog = new THREE.Fog(0x0a0010, 30, 80);
    
    // カメラ
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 8, 25);
    camera.lookAt(0, 3, 0);
    
    // レンダラー
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('canvas-container').appendChild(renderer.domElement);
    
    // 会場作成
    initVenue(scene);
    createAllVenue();
    
    // 自分のアバター作成
    myAvatar = createAvatar(myUserId, myUserName, 0x00ffff);
    myAvatar.position.set(0, 0, 15);
    scene.add(myAvatar);
    
    // ペンライト作成
    myPenlight = createPenlight(0xff00ff);
    myAvatar.add(myPenlight);
    myPenlight.visible = false;
    
    // 設定初期化
    initSettings(myUserName, {
        onNameChange: (newName) => {
            myUserName = newName;
            myAvatar.userData.userName = newName;
            sendNameChange(newName);
        },
        onAvatarChange: (avatarId) => {
            const ext = CHARA_EXTENSIONS[avatarId] || 'png';
            const url = `${CHARA_BASE_URL}${avatarId}.${ext}`;
            setAvatarImage(myAvatar, url);
        },
        onResetCamera: () => {
            camera.position.set(0, 8, 25);
            camera.lookAt(0, 3, 0);
        },
        onChangeBackground: (url) => {
            changeStageBackground(url);
            sendBackgroundChange(url);
        },
        onBrightnessChange: (value) => {
            setRoomBrightness(value);
            sendBrightness(value);
        },
        onRequestSpeak: () => {
            requestSpeak();
        },
        onApproveSpeak: (userId) => {
            // approveSpeak(userId) from connection.js
        },
        onDenySpeak: (userId) => {
            // denySpeak(userId) from connection.js
        },
        onKickSpeaker: (userId) => {
            // kickSpeaker(userId) from connection.js
        },
        onAnnounce: (message) => {
            sendChat('📢 運営', message);
        },
        onShowNamesChange: (visible) => {
            // 名前表示切替
        }
    });
    
    // 接続設定
    setupConnection();
    
    // UI設定
    setupChatUI();
    setupActionButtons();
    setupSpeakerControls();
    
    // イベント
    window.addEventListener('resize', onWindowResize);
    setupTouchControls();
    
    // 初期値設定
    updateUserCount();
    updateSpeakerCount(0);
    
    // アニメーション開始
    animate();
    
    debugLog('初期化完了', 'success');
}

// ペンライトの色変更
function setPenlightColor(color) {
    penlightColor = color;
    const light = myPenlight.getObjectByName('penlightLight');
    const pointLight = myPenlight.getObjectByName('penlightPointLight');
    if (light) light.material.color.set(color);
    if (pointLight) pointLight.color.set(color);
}

// 接続設定
function setupConnection() {
    setCallbacks({
        onUserJoin: (user) => {
            if (user.id === myUserId) return;
            
            const avatar = createAvatar(user.id, user.name, getRandomColor());
            avatar.position.set(user.x || 0, user.y || 0, user.z || 15);
            scene.add(avatar);
            remoteAvatars.set(user.id, avatar);
            
            updateUserCount();
            if (getSettings().notifications) {
                showNotification(`${user.name} が参加しました`, 'info');
            }
        },
        onUserLeave: (userId) => {
            const avatar = remoteAvatars.get(userId);
            if (avatar) {
                scene.remove(avatar);
                remoteAvatars.delete(userId);
                updateUserCount();
            }
        },
        onPosition: (userId, x, y, z) => {
            const avatar = remoteAvatars.get(userId);
            if (avatar) {
                avatar.position.set(x, y, z);
            }
        },
        onReaction: (userId, reaction, color) => {
            const avatar = remoteAvatars.get(userId);
            if (avatar) {
                // リアクション処理（他ユーザーのペンライト等）
            }
        },
        onChat: (name, message, senderId) => {
            const state = getState();
            if (senderId === state.myServerConnectionId) return;
            addChatMessage(name, message);
        },
        onBackgroundChange: (url) => {
            changeStageBackground(url);
        },
        onBrightnessChange: (value) => {
            setRoomBrightness(value);
        },
        onSpeakRequestsUpdate: (requests) => {
            updateSpeakRequests(requests);
        },
        onCurrentSpeakersUpdate: (speakers) => {
            updateCurrentSpeakers(speakers);
            updateSpeakerCount(speakers.length);
        },
        onSpeakApproved: () => {
            isOnStage = true;
            document.getElementById('speaker-controls').classList.remove('hidden');
            showNotification('登壇が承認されました！', 'success');
            moveToStage();
        },
        onSpeakerJoined: (userId) => {
            const avatar = remoteAvatars.get(userId);
            if (avatar) {
                setAvatarSpotlight(avatar, true);
            }
            updateUserCount();
        },
        onSpeakerLeft: (userId) => {
            const avatar = remoteAvatars.get(userId);
            if (avatar) {
                setAvatarSpotlight(avatar, false);
            }
            
            const state = getState();
            if (userId === state.myServerConnectionId) {
                isOnStage = false;
                document.getElementById('speaker-controls').classList.add('hidden');
                moveToAudience();
            }
            updateUserCount();
        },
        onConnectedChange: (connected) => {
            if (connected) {
                updateUserCount();
                showNotification('接続しました', 'success');
            } else {
                showNotification('接続が切断されました', 'error');
            }
        },
        onAnnounce: (message) => {
            showNotification(`📢 ${message}`, 'info');
            addChatMessage('📢 運営', message);
        },
        remoteAvatars: remoteAvatars
    });
    
    connectToPartyKit(myUserName);
}

// ステージに移動（ステージはZ=-6〜-3、高さY=1.2）
function moveToStage() {
    const targetX = (Math.random() - 0.5) * 10;
    const targetZ = -5;
    animateMove(myAvatar, targetX, 1.2, targetZ);
    setAvatarSpotlight(myAvatar, true);
}

// 観客席に戻る
function moveToAudience() {
    const targetX = (Math.random() - 0.5) * 10;
    const targetZ = 5 + Math.random() * 5;
    animateMove(myAvatar, targetX, 0, targetZ);
    setAvatarSpotlight(myAvatar, false);
}

// アニメーション移動
function animateMove(avatar, targetX, targetY, targetZ) {
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
            // 移動完了後に位置を送信
            sendPosition(avatar.position.x, avatar.position.y, avatar.position.z);
        }
    }
    update();
}

// ユーザー数更新
function updateUserCount() {
    const count = remoteAvatars.size + 1;
    const el = document.getElementById('user-count');
    if (el) el.textContent = `👥 ${count}`;
}

// 登壇者数更新
function updateSpeakerCount(count) {
    const el = document.getElementById('speaker-count');
    if (el) el.textContent = `🎤 ${count}`;
}

// チャットUI設定
function setupChatUI() {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (message) {
            sendChat(myUserName, message);
            addChatMessage(myUserName, message);
            input.value = '';
        }
    });
}

// チャットメッセージ追加
function addChatMessage(name, message) {
    const messages = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="name">${name}</span><span class="text">${message}</span>`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    
    while (messages.children.length > 50) {
        messages.removeChild(messages.firstChild);
    }
}

// スピーカーコントロール設定
function setupSpeakerControls() {
    const micBtn = document.getElementById('mic-toggle-btn');
    const leaveBtn = document.getElementById('leave-stage-btn');
    
    micBtn.addEventListener('click', () => {
        const isMicOn = toggleMic();
        if (isMicOn) {
            micBtn.textContent = '🎙️ マイク ON';
            micBtn.classList.remove('muted');
        } else {
            micBtn.textContent = '🔇 マイク OFF';
            micBtn.classList.add('muted');
        }
    });
    
    leaveBtn.addEventListener('click', () => {
        stopSpeaking();
        isOnStage = false;
        document.getElementById('speaker-controls').classList.add('hidden');
        moveToAudience();
        showNotification('降壇しました', 'info');
    });
}

// アクションボタン設定
function setupActionButtons() {
    const penlightBtn = document.getElementById('penlight-btn');
    const otageiBtn = document.getElementById('otagei-btn');
    const penlightColors = document.getElementById('penlight-colors');
    
    let pressTimer = null;
    let isLongPress = false;
    
    const startPress = () => {
        isLongPress = false;
        pressTimer = setTimeout(() => {
            isLongPress = true;
            penlightColors.classList.remove('hidden');
        }, 500);
    };
    
    const endPress = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    };
    
    penlightBtn.addEventListener('mousedown', startPress);
    penlightBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startPress();
    });
    penlightBtn.addEventListener('mouseup', endPress);
    penlightBtn.addEventListener('mouseleave', endPress);
    penlightBtn.addEventListener('touchend', (e) => {
        endPress();
        if (!isLongPress && penlightColors.classList.contains('hidden')) {
            togglePenlight();
        }
    });
    
    penlightBtn.addEventListener('click', () => {
        if (!isLongPress && penlightColors.classList.contains('hidden')) {
            togglePenlight();
        }
    });
    
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            setPenlightColor(color);
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            penlightColors.classList.add('hidden');
            
            if (!isPenlightActive) {
                togglePenlight();
            }
        });
    });
    
    document.addEventListener('click', (e) => {
        if (!penlightBtn.contains(e.target) && !penlightColors.contains(e.target)) {
            penlightColors.classList.add('hidden');
        }
    });
    
    otageiBtn.addEventListener('click', toggleOtagei);
}

// ペンライトON/OFF
function togglePenlight() {
    isPenlightActive = !isPenlightActive;
    const btn = document.getElementById('penlight-btn');
    
    if (isPenlightActive) {
        btn.classList.add('active');
        myPenlight.visible = true;
        startPenlightAnimation();
        sendReaction('penlight', penlightColor);
    } else {
        btn.classList.remove('active');
        myPenlight.visible = false;
        stopPenlightAnimation();
        sendReaction('penlight_off', null);
    }
}

// ペンライトアニメーション開始
function startPenlightAnimation() {
    if (penlightInterval) clearInterval(penlightInterval);
    penlightInterval = setInterval(() => {
        const time = Date.now() * 0.005;
        myPenlight.rotation.z = Math.sin(time) * 0.5;
    }, 16);
}

// ペンライトアニメーション停止
function stopPenlightAnimation() {
    if (penlightInterval) {
        clearInterval(penlightInterval);
        penlightInterval = null;
    }
    myPenlight.rotation.z = 0;
}

// オタ芸ON/OFF
function toggleOtagei() {
    isOtageiActive = !isOtageiActive;
    const btn = document.getElementById('otagei-btn');
    
    if (isOtageiActive) {
        btn.classList.add('active');
        startOtageiAnimation();
        sendReaction('otagei', null);
    } else {
        btn.classList.remove('active');
        stopOtageiAnimation();
        sendReaction('otagei_off', null);
    }
}

// オタ芸アニメーション開始
function startOtageiAnimation() {
    if (otageiInterval) clearInterval(otageiInterval);
    const baseY = myAvatar.position.y;
    otageiInterval = setInterval(() => {
        const time = Date.now() * 0.01;
        myAvatar.rotation.y = Math.sin(time) * 0.3;
        myAvatar.position.y = baseY + Math.abs(Math.sin(time * 2)) * 0.3;
    }, 16);
}

// オタ芸アニメーション停止
function stopOtageiAnimation() {
    if (otageiInterval) {
        clearInterval(otageiInterval);
        otageiInterval = null;
    }
    myAvatar.rotation.y = 0;
    // ステージ上なら高さを維持
    if (isOnStage) {
        myAvatar.position.y = 1.2;
    } else {
        myAvatar.position.y = 0;
    }
}

// タッチコントロール
function setupTouchControls() {
    let touchStartX = 0;
    let touchStartY = 0;
    
    const canvas = renderer.domElement;
    
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }
    }, { passive: true });
    
    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && !isOnStage) {
            const deltaX = e.touches[0].clientX - touchStartX;
            const deltaY = e.touches[0].clientY - touchStartY;
            
            myAvatar.position.x += deltaX * 0.01;
            myAvatar.position.z += deltaY * 0.01;
            
            myAvatar.position.x = Math.max(-15, Math.min(15, myAvatar.position.x));
            myAvatar.position.z = Math.max(5, Math.min(25, myAvatar.position.z));
            
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            
            sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);
        }
    }, { passive: true });
}

// ウィンドウリサイズ
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ランダムカラー
function getRandomColor() {
    const colors = [0xff66ff, 0x66ffff, 0xffff00, 0xff6666, 0x66ff66];
    return colors[Math.floor(Math.random() * colors.length)];
}

// アニメーションループ
function animate() {
    requestAnimationFrame(animate);
    
    animateVenue();
    
    // カメラ追従
    const targetX = myAvatar.position.x * 0.3;
    const targetZ = myAvatar.position.z + 10;
    camera.position.x += (targetX - camera.position.x) * 0.05;
    camera.position.z += (targetZ - camera.position.z) * 0.05;
    camera.lookAt(myAvatar.position.x, 3, myAvatar.position.z - 5);
    
    renderer.render(scene, camera);
}

// 初期化実行
init();
