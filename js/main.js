// main.js - Metaverse空間のメインスクリプト

import { initVenue, createAllVenue, animateVenue, changeStageBackground, setRoomBrightness } from './venue.js';
import { connectToPartyKit, sendPosition, sendReaction, sendChat, sendNameChange, sendAvatarChange, sendBackgroundChange, sendBrightness, sendAnnounce, requestSpeak, stopSpeaking, toggleMic, approveSpeak, denySpeak, kickSpeaker, setCallbacks, getState, getMyConnectionId } from './connection.js';
import { initSettings, getSettings, showNotification, updateSpeakRequests, updateCurrentSpeakers } from './settings.js';
import { createAvatar, setAvatarImage, setAvatarSpotlight, createPenlight, addChatMessage, debugLog, createDebugUI } from './utils.js';

// Three.js
let scene, camera, renderer;
let clock;

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

// 初期化
async function init() {
    debugLog('Initializing...');
    debugLog(`Touch device: ${isTouchDevice}`, 'info');
    createDebugUI();

    // Three.js セットアップ
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

    // 会場作成
    initVenue(scene);
    createAllVenue();

    // 自分のアバター作成
    const avatarColor = Math.random() * 0xffffff;
    myAvatar = createAvatar(myUserId, myUserName, avatarColor);
    myAvatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);
    scene.add(myAvatar);

    // ペンライト作成
    myPenlight = createPenlight(0xff00ff);
    myPenlight.visible = false;
    scene.add(myPenlight);
    debugLog('Penlight created and added to scene', 'success');

    // 設定初期化
    initSettings(myUserName, {
        onNameChange: (newName) => {
            myUserName = newName;
            sendNameChange(newName);
            showNotification(`名前を「${newName}」に変更しました`, 'success');
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
        onApproveSpeak: (userId) => {
            approveSpeak(userId);
            showNotification('登壇を許可しました', 'success');
        },
        onDenySpeak: (userId) => {
            denySpeak(userId);
            showNotification('登壇を却下しました', 'info');
        },
        onKickSpeaker: (userId) => {
            kickSpeaker(userId);
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
        }
    });

    // 接続セットアップ
    setupConnection();

    // UI セットアップ
    setupChatUI();
    setupActionButtons();
    setupSpeakerControls();
    setupJoystick();
    setupCameraSwipe();

    // リサイズ対応
    window.addEventListener('resize', onWindowResize);

    // アニメーション開始
    animate();

    // 初期ユーザー数
    updateUserCount();
    updateSpeakerCount(0);

    debugLog('Initialization complete');
}

// 接続セットアップ
function setupConnection() {
    setCallbacks({
        onUserJoin: (userId, userName) => {
            debugLog(`User joined: ${userId} (${userName})`);
            if (!remoteAvatars.has(userId)) {
                const avatarColor = Math.random() * 0xffffff;
                const avatar = createAvatar(userId, userName, avatarColor);
                avatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);
                scene.add(avatar);
                remoteAvatars.set(userId, { avatar, userName, penlight: null });
                debugLog(`Remote avatar created for ${userId}`, 'success');
            }
            updateUserCount();
        },
        onUserLeave: (userId) => {
            debugLog(`User left: ${userId}`);
            const userData = remoteAvatars.get(userId);
            if (userData) {
                if (userData.avatar) {
                    scene.remove(userData.avatar);
                }
                if (userData.penlight) {
                    scene.remove(userData.penlight);
                }
                stopRemoteOtagei(userId);
                remoteAvatars.delete(userId);
            }
            updateUserCount();
        },
        onPosition: (userId, x, y, z) => {
            const userData = remoteAvatars.get(userId);
            if (userData && userData.avatar) {
                userData.avatar.position.set(x, y, z);
                if (userData.penlight && userData.penlight.visible) {
                    userData.penlight.position.set(x, y + 1.6, z);
                }
            }
        },
        onAvatarChange: (userId, imageUrl) => {
            debugLog(`Avatar change received: ${userId} -> ${imageUrl}`);
            const userData = remoteAvatars.get(userId);
            if (userData && userData.avatar) {
                setAvatarImage(userData.avatar, imageUrl);
            }
        },
        onNameChange: (userId, newName) => {
            debugLog(`Name change received: ${userId} -> ${newName}`);
            const userData = remoteAvatars.get(userId);
            if (userData) {
                userData.userName = newName;
            }
        },
        onReaction: (userId, reactionType, color) => {
            debugLog(`Reaction from ${userId}: ${reactionType}`, 'info');
            const userData = remoteAvatars.get(userId);
            if (userData && userData.avatar) {
                if (reactionType === 'penlight') {
                    let remotePenlight = userData.penlight;
                    if (!remotePenlight) {
                        remotePenlight = createPenlight(color || '#ff00ff');
                        userData.penlight = remotePenlight;
                        scene.add(remotePenlight);
                        debugLog(`Created penlight for ${userId}`, 'success');
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
                            if (child.isPointLight) {
                                child.color.copy(colorValue);
                            }
                        });
                    }
                    debugLog(`Penlight shown for ${userId}`, 'success');
                } else if (reactionType === 'penlight_off') {
                    if (userData.penlight) {
                        userData.penlight.visible = false;
                        debugLog(`Penlight hidden for ${userId}`, 'info');
                    }
                } else if (reactionType === 'otagei') {
                    startRemoteOtagei(userId, userData.avatar);
                    debugLog(`Otagei started for ${userId}`, 'success');
                }
            }
        },
        onChat: (userId, userName, message) => {
            const myId = getMyConnectionId();
            if (userId !== myId) {
                addChatMessage(userName, message);
            }
        },
        onSpeakApproved: () => {
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
        onSpeakerJoined: (userId, userName) => {
            debugLog(`Speaker joined: ${userId} (${userName})`);
            const userData = remoteAvatars.get(userId);
            if (userData && userData.avatar) {
                setAvatarSpotlight(userData.avatar, true);
            }
            showNotification(`${userName || 'ゲスト'} が登壇しました`, 'info');
        },
        onSpeakerLeft: (userId) => {
            debugLog(`Speaker left: ${userId}`);
            const userData = remoteAvatars.get(userId);
            if (userData && userData.avatar) {
                setAvatarSpotlight(userData.avatar, false);
            }
        },
        onSpeakRequestsUpdate: (requests) => {
            debugLog(`Speak requests updated: ${requests.length} requests`, 'info');
            updateSpeakRequests(requests);
        },
        onCurrentSpeakersUpdate: (speakers) => {
            debugLog(`Current speakers updated: ${speakers.length} speakers`, 'info');
            updateCurrentSpeakers(speakers);
            updateSpeakerCount(speakers.length);
        },
        onKicked: () => {
            debugLog('Kicked from stage');
            isOnStage = false;
            moveToAudience();
            showSpeakerControls(false);
            showNotification('主催者により降壇しました', 'warn');
        },
        onAnnounce: (message) => {
            showAnnouncement(message);
        },
        onBackgroundChange: (imageUrl) => {
            changeStageBackground(imageUrl);
        },
        onBrightnessChange: (value) => {
            setRoomBrightness(value);
        },
        remoteAvatars: remoteAvatars
    });

    connectToPartyKit(myUserName);
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
function startRemoteOtagei(userId, avatar) {
    stopRemoteOtagei(userId);
    
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
    remoteOtageiAnimations.set(userId, { animationId, baseY });
    
    setTimeout(() => {
        stopRemoteOtagei(userId);
    }, 3000);
}

// リモートユーザーのオタ芸停止
function stopRemoteOtagei(userId) {
    const animation = remoteOtageiAnimations.get(userId);
    if (animation) {
        cancelAnimationFrame(animation.animationId);
        const userData = remoteAvatars.get(userId);
        if (userData && userData.avatar) {
            userData.avatar.position.y = animation.baseY;
        }
        remoteOtageiAnimations.delete(userId);
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
    const count = remoteAvatars.size + 1;
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
            if (!longPressTriggered) {
                safeTogglePenlight();
            }
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
            if (!longPressTriggered) {
                safeTogglePenlight();
            }
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
        
        if (isTouchDevice) {
            btn.addEventListener('touchend', selectColor);
        } else {
            btn.addEventListener('click', selectColor);
        }
    });

    let otageiLastToggleTime = 0;
    
    function safeToggleOtagei() {
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
            if (child.isPointLight) {
                child.color.copy(colorValue);
            }
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
    if (isOnStage) {
        myAvatar.position.y = STAGE_Y;
    } else {
        myAvatar.position.y = 0;
    }
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
        toggleMic();
        const state = getState();
        micBtn.textContent = state.isMicMuted ? '🎙️ マイク OFF' : '🎙️ マイク ON';
        micBtn.style.background = state.isMicMuted 
            ? 'linear-gradient(135deg, #f44336, #ff5722)' 
            : 'linear-gradient(135deg, #4CAF50, #8BC34A)';
    });

    leaveBtn.addEventListener('click', () => {
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
    if (controls) {
        controls.classList.toggle('hidden', !show);
    }
    
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

    renderer.render(scene, camera);
}

// 開始
init();
