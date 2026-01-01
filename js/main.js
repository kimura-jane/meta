// main.js - Metaverse空間のメインスクリプト

import { initVenue, createAllVenue, animateVenue, changeStageBackground, setRoomBrightness } from './venue.js';
import { connectToPartyKit, sendPosition, sendReaction, sendChat, sendNameChange, sendBackgroundChange, sendBrightness, sendAnnounce, requestSpeak, stopSpeaking, toggleMic, approveSpeak, denySpeak, kickSpeaker, setCallbacks, getState } from './connection.js';
import { initSettings, getSettings, showNotification, updateSpeakRequests, updateCurrentSpeakers } from './settings.js';
import { createAvatar, setAvatarImage, setAvatarSpotlight, createPenlight, addChatMessage, debugLog, createDebugUI } from './utils.js';

// Three.js
let scene, camera, renderer;
let clock;

// アバター設定
const CHARA_LIST = ['12444', '12555', 'IMG_1677', 'IMG_1861', 'IMG_1889', 'IMG_2958', 'IMG_3264', 'IMG_3267', 'IMG_3269', 'IMG_7483', 'onigiriya_kanatake_512'];
const CHARA_EXTENSIONS = {
    '12444': 'png', '12555': 'png', 'IMG_1677': 'png', 'IMG_1861': 'png',
    'IMG_1889': 'png', 'IMG_2958': 'png', 'IMG_3264': 'png', 'IMG_3267': 'png',
    'IMG_3269': 'png', 'IMG_7483': 'png', 'onigiriya_kanatake_512': 'png'
};
const CHARA_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/chara/';

// 背景設定
const STAGE_BACKGROUNDS = [
    { name: 'IMG_0967', file: 'IMG_0967.png' },
    { name: 'IMG_3273', file: 'IMG_3273.jpeg' },
    { name: 'IMG_3274', file: 'IMG_3274.jpeg' },
    { name: 'IMG_3275', file: 'IMG_3275.jpeg' },
    { name: 'IMG_9719', file: 'IMG_9719.jpeg' }
];
const STAGE_BASE_URL = 'https://raw.githubusercontent.com/kimura-jane/meta/main/stage/';

// ローカルユーザー
let myUserId = 'user_' + Math.random().toString(36).substr(2, 9);
let myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);
let myAvatar = null;
let myPenlight = null;
let myAvatarImage = null;

// リモートユーザー
const remoteAvatars = new Map();

// 状態
let isOnStage = false;
let isPenlightActive = false;
let isOtageiActive = false;
let penlightColor = '#ff00ff';
let penlightLongPressTimer = null;
let otageiAnimationId = null;
let otageiBaseY = 0;

// カメラ制御
let cameraAngleX = 0;
let cameraDistance = 6;
let cameraHeight = 4;

// ジョイスティック
let joystickActive = false;
let joystickX = 0;
let joystickY = 0;

// 初期化
async function init() {
    debugLog('Initializing...');
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
        },
        onDenySpeak: (userId) => {
            denySpeak(userId);
        },
        onKickSpeaker: (userId) => {
            kickSpeaker(userId);
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
                remoteAvatars.set(userId, { avatar, userName });
            }
            updateUserCount();
        },
        onUserLeave: (userId) => {
            debugLog(`User left: ${userId}`);
            const userData = remoteAvatars.get(userId);
            if (userData) {
                scene.remove(userData.avatar);
                remoteAvatars.delete(userId);
            }
            updateUserCount();
        },
        onPosition: (userId, x, y, z) => {
            const userData = remoteAvatars.get(userId);
            if (userData) {
                userData.avatar.position.set(x, y, z);
            }
        },
        onReaction: (userId, reactionType, color) => {
            debugLog(`Reaction from ${userId}: ${reactionType}`);
        },
        onChat: (userId, userName, message) => {
            const state = getState();
            if (userId !== state.myServerConnectionId) {
                addChatMessage(userName, message);
            }
        },
        onSpeakApproved: () => {
            debugLog('Speak approved!');
            isOnStage = true;
            moveToStage();
            showSpeakerControls(true);
            showNotification('登壇が承認されました！', 'success');
        },
        onSpeakerJoined: (userId, userName) => {
            debugLog(`Speaker joined: ${userId}`);
            const userData = remoteAvatars.get(userId);
            if (userData) {
                setAvatarSpotlight(userData.avatar, true);
            }
        },
        onSpeakerLeft: (userId) => {
            debugLog(`Speaker left: ${userId}`);
            const userData = remoteAvatars.get(userId);
            if (userData) {
                setAvatarSpotlight(userData.avatar, false);
            }
        },
        onSpeakRequestsUpdate: (requests) => {
            updateSpeakRequests(requests);
        },
        onCurrentSpeakersUpdate: (speakers) => {
            updateCurrentSpeakers(speakers);
            updateSpeakerCount(speakers.length);
        },
        onAnnounce: (message) => {
            showNotification(`📢 ${message}`, 'info');
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
    const targetY = 1.2;

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
    } else {
        let newX = myAvatar.position.x + moveX;
        let newZ = myAvatar.position.z + moveZ;

        newX = Math.max(-15, Math.min(15, newX));
        newZ = Math.max(-2, Math.min(15, newZ));

        myAvatar.position.x = newX;
        myAvatar.position.z = newZ;
    }

    sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);

    if (isPenlightActive) {
        updatePenlightPosition();
    }
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

    // ペンライトON/OFF
    function togglePenlight() {
        debugLog('Penlight toggle called', 'info');
        
        isPenlightActive = !isPenlightActive;
        myPenlight.visible = isPenlightActive;
        penlightBtn.classList.toggle('active', isPenlightActive);
        
        debugLog(`Penlight active: ${isPenlightActive}, visible: ${myPenlight.visible}`, 'info');
        
        // ボタンの色を変更
        if (isPenlightActive) {
            penlightBtn.style.background = penlightColor;
            penlightBtn.style.boxShadow = `0 0 15px ${penlightColor}`;
            updatePenlightPosition();
            sendReaction('penlight', penlightColor);
            debugLog(`Penlight position: ${myPenlight.position.x.toFixed(2)}, ${myPenlight.position.y.toFixed(2)}, ${myPenlight.position.z.toFixed(2)}`, 'info');
        } else {
            penlightBtn.style.background = '';
            penlightBtn.style.boxShadow = '';
        }
    }

    // 長押し関連
    let longPressTriggered = false;

    // クリックイベント（PC用）
    penlightBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 長押し後やタッチデバイスでは無視
        if (longPressTriggered) {
            longPressTriggered = false;
            return;
        }
    });

    // マウスイベント（PC用）
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
            togglePenlight();
        }
        longPressTriggered = false;
    });

    penlightBtn.addEventListener('mouseleave', () => {
        if (penlightLongPressTimer) {
            clearTimeout(penlightLongPressTimer);
            penlightLongPressTimer = null;
        }
    });

    // タッチイベント（モバイル用）
    penlightBtn.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        longPressTriggered = false;
        penlightLongPressTimer = setTimeout(() => {
            longPressTriggered = true;
            penlightColors.classList.remove('hidden');
            debugLog('Penlight color panel opened (touch)', 'info');
        }, 500);
    }, { passive: true });

    penlightBtn.addEventListener('touchend', (e) => {
        e.stopPropagation();
        if (penlightLongPressTimer) {
            clearTimeout(penlightLongPressTimer);
            penlightLongPressTimer = null;
        }
        if (!longPressTriggered) {
            togglePenlight();
        }
        longPressTriggered = false;
    });

    penlightBtn.addEventListener('touchcancel', () => {
        if (penlightLongPressTimer) {
            clearTimeout(penlightLongPressTimer);
            penlightLongPressTimer = null;
        }
        longPressTriggered = false;
    });

    // 色ボタン
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            penlightColor = btn.dataset.color;
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            
            updatePenlightColor();
            
            if (isPenlightActive) {
                penlightBtn.style.background = penlightColor;
                penlightBtn.style.boxShadow = `0 0 15px ${penlightColor}`;
            }
            
            penlightColors.classList.add('hidden');
            debugLog(`Penlight color changed to ${penlightColor}`, 'info');
        });
        
        // タッチでも反応
        btn.addEventListener('touchend', (e) => {
            e.stopPropagation();
            e.preventDefault();
            penlightColor = btn.dataset.color;
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            
            updatePenlightColor();
            
            if (isPenlightActive) {
                penlightBtn.style.background = penlightColor;
                penlightBtn.style.boxShadow = `0 0 15px ${penlightColor}`;
            }
            
            penlightColors.classList.add('hidden');
            debugLog(`Penlight color changed to ${penlightColor} (touch)`, 'info');
        });
    });

    // オタ芸ボタン
    otageiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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
    });
    
    // タッチでも反応
    otageiBtn.addEventListener('touchend', (e) => {
        e.stopPropagation();
        e.preventDefault();
        isOtageiActive = !isOtageiActive;
        otageiBtn.classList.toggle('active', isOtageiActive);

        if (isOtageiActive) {
            startOtageiAnimation();
            sendReaction('otagei', null);
            debugLog('Otagei started (touch)', 'info');
        } else {
            stopOtageiAnimation();
            debugLog('Otagei stopped (touch)', 'info');
        }
    });

    debugLog('Action buttons setup complete', 'success');
}

// ペンライト位置更新
function updatePenlightPosition() {
    if (myPenlight && myAvatar) {
        // アバターの上に配置（よく見える位置）
        myPenlight.position.set(
            myAvatar.position.x,
            myAvatar.position.y + 2.5,
            myAvatar.position.z
        );
    }
}

// ペンライト色更新
function updatePenlightColor() {
    if (myPenlight) {
        const colorValue = new THREE.Color(penlightColor);
        
        myPenlight.traverse((child) => {
            if (child.isMesh && child.material) {
                // 持ち手以外の色を更新
                if (child.name !== 'penlightHandle') {
                    child.material.color.copy(colorValue);
                    if (child.material.emissive) {
                        child.material.emissive.copy(colorValue);
                    }
                }
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

        if (isPenlightActive) {
            updatePenlightPosition();
            myPenlight.rotation.z = Math.sin(time * 2) * 0.5;
        }

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
        myAvatar.position.y = 1.2;
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

    // ペンライト揺れアニメーション
    if (isPenlightActive && myPenlight && myPenlight.visible) {
        myPenlight.rotation.z = Math.sin(Date.now() * 0.003) * 0.3;
    }

    renderer.render(scene, camera);
}

// 開始
init();
