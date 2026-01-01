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

// カメラ追従用
let cameraFollowMode = 'normal'; // 'normal' or 'stage'
let normalCameraOffset = new THREE.Vector3(0, 3, 8);

// 初期化
async function init() {
    debugLog('Initializing...');
    createDebugUI();

    // Three.js セットアップ
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000011);
    scene.fog = new THREE.Fog(0x000011, 20, 80);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 3, 10);

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
    myAvatar = createAvatar(scene, myUserId);
    myAvatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);

    // ペンライト作成
    myPenlight = createPenlight(scene);
    myPenlight.visible = false;

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
        onChangeBackground: (bgFile) => {
            const imageUrl = `${STAGE_BASE_URL}${bgFile}`;
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
        }
    });

    // 接続セットアップ
    setupConnection();

    // UI セットアップ
    setupChatUI();
    setupActionButtons();
    setupSpeakerControls();
    setupTouchControls();

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
                const avatar = createAvatar(scene, userId);
                avatar.position.set((Math.random() - 0.5) * 10, 0, 5 + Math.random() * 5);
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
            // リアクションエフェクト処理
        },
        onChat: (userId, userName, message) => {
            // 自分のメッセージは送信時に表示済みなのでスキップ
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

// ステージへ移動
function moveToStage() {
    const targetX = (Math.random() - 0.5) * 10;
    const targetZ = -5;
    const targetY = 1.2;

    animateMove(myAvatar, targetX, targetY, targetZ, () => {
        setAvatarSpotlight(myAvatar, true);
        sendPosition(targetX, targetY, targetZ);

        // 1秒後にカメラを観客席向きに切り替え
        setTimeout(() => {
            cameraFollowMode = 'stage';
            camera.position.set(targetX, 4, -8);
            camera.lookAt(targetX, 2, 10);
        }, 1000);
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

        // カメラを通常モードに戻す
        cameraFollowMode = 'normal';
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
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

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

// ユーザー数更新
function updateUserCount() {
    const count = remoteAvatars.size + 1; // 自分 + リモート
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

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (message) {
            sendChat(message);
            addChatMessage(myUserName, message, true);
            input.value = '';
        }
    });
}

// アクションボタンセットアップ
function setupActionButtons() {
    const penlightBtn = document.getElementById('penlight-btn');
    const otageiBtn = document.getElementById('otagei-btn');
    const penlightColors = document.getElementById('penlight-colors');

    // ペンライトボタン
    penlightBtn.addEventListener('click', () => {
        if (penlightLongPressTimer) return; // 長押し中はスキップ

        isPenlightActive = !isPenlightActive;
        myPenlight.visible = isPenlightActive;
        penlightBtn.classList.toggle('active', isPenlightActive);

        if (isPenlightActive) {
            updatePenlightPosition();
            sendReaction('penlight', penlightColor);
        }
    });

    // 長押しで色選択パネル表示
    penlightBtn.addEventListener('mousedown', startPenlightLongPress);
    penlightBtn.addEventListener('touchstart', startPenlightLongPress);
    penlightBtn.addEventListener('mouseup', cancelPenlightLongPress);
    penlightBtn.addEventListener('touchend', cancelPenlightLongPress);
    penlightBtn.addEventListener('mouseleave', cancelPenlightLongPress);

    function startPenlightLongPress(e) {
        e.preventDefault();
        penlightLongPressTimer = setTimeout(() => {
            penlightColors.classList.toggle('hidden');
            penlightLongPressTimer = null;
        }, 500);
    }

    function cancelPenlightLongPress() {
        if (penlightLongPressTimer) {
            clearTimeout(penlightLongPressTimer);
            penlightLongPressTimer = null;
        }
    }

    // 色選択
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            penlightColor = btn.dataset.color;
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            updatePenlightColor();
            penlightColors.classList.add('hidden');
        });
    });

    // オタ芸ボタン
    otageiBtn.addEventListener('click', () => {
        isOtageiActive = !isOtageiActive;
        otageiBtn.classList.toggle('active', isOtageiActive);

        if (isOtageiActive) {
            startOtageiAnimation();
            sendReaction('otagei', null);
        } else {
            stopOtageiAnimation();
        }
    });
}

// ペンライト位置更新
function updatePenlightPosition() {
    if (myPenlight && myAvatar) {
        myPenlight.position.set(
            myAvatar.position.x + 0.5,
            myAvatar.position.y + 2,
            myAvatar.position.z
        );
    }
}

// ペンライト色更新
function updatePenlightColor() {
    if (myPenlight) {
        const light = myPenlight.children.find(c => c.isPointLight);
        if (light) {
            light.color.setStyle(penlightColor);
        }
        const mesh = myPenlight.children.find(c => c.isMesh);
        if (mesh) {
            mesh.material.emissive.setStyle(penlightColor);
        }
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

        // ペンライトも一緒に動かす
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
    // 元の高さに戻す
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
}

// スピーカーコントロール表示/非表示
function showSpeakerControls(show) {
    const controls = document.getElementById('speaker-controls');
    if (controls) {
        controls.classList.toggle('hidden', !show);
    }
}

// タッチ操作セットアップ
function setupTouchControls() {
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

    const canvas = renderer.domElement;

    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown);
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('touchmove', onPointerMove);
    canvas.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('touchend', onPointerUp);

    function onPointerDown(e) {
        isDragging = true;
        const pos = getPointerPosition(e);
        lastX = pos.x;
        lastY = pos.y;
    }

    function onPointerMove(e) {
        if (!isDragging) return;

        const pos = getPointerPosition(e);
        const deltaX = (pos.x - lastX) * 0.02;
        const deltaY = (pos.y - lastY) * 0.02;

        if (isOnStage) {
            // ステージ上: X方向のみ移動
            let newX = myAvatar.position.x - deltaX;
            newX = Math.max(-7, Math.min(7, newX)); // ステージ範囲内
            myAvatar.position.x = newX;
            sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);

            // ステージモードのカメラも追従
            if (cameraFollowMode === 'stage') {
                camera.position.x = myAvatar.position.x;
                camera.lookAt(myAvatar.position.x, 2, 10);
            }
        } else {
            // 観客席: 自由移動
            myAvatar.position.x -= deltaX;
            myAvatar.position.z += deltaY;

            // 範囲制限
            myAvatar.position.x = Math.max(-15, Math.min(15, myAvatar.position.x));
            myAvatar.position.z = Math.max(2, Math.min(15, myAvatar.position.z));

            sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);
        }

        // ペンライト追従
        if (isPenlightActive) {
            updatePenlightPosition();
        }

        lastX = pos.x;
        lastY = pos.y;
    }

    function onPointerUp() {
        isDragging = false;
    }

    function getPointerPosition(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
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

    const delta = clock.getDelta();

    // 会場アニメーション
    animateVenue();

    // カメラ追従
    if (cameraFollowMode === 'normal' && myAvatar) {
        const targetX = myAvatar.position.x;
        const targetY = myAvatar.position.y + normalCameraOffset.y;
        const targetZ = myAvatar.position.z + normalCameraOffset.z;

        camera.position.x += (targetX - camera.position.x) * 0.05;
        camera.position.y += (targetY - camera.position.y) * 0.05;
        camera.position.z += (targetZ - camera.position.z) * 0.05;

        camera.lookAt(myAvatar.position.x, myAvatar.position.y + 1, myAvatar.position.z);
    }

    // ペンライトアニメーション
    if (isPenlightActive && myPenlight) {
        myPenlight.rotation.z = Math.sin(Date.now() * 0.003) * 0.3;
    }

    renderer.render(scene, camera);
}

// 開始
init();
