// ============================================
// メタバース空間 - メインスクリプト
// エントリーポイント
// ============================================

const THREE = window.THREE;

import { debugLog, createDebugUI, setupErrorHandlers, addChatMessage, createAvatar, createPenlight, setAvatarSpotlight } from './utils.js';
import { connectToPartyKit, setCallbacks, getState, requestSpeak, toggleMic, sendPosition, sendReaction, sendChat, sendNameChange, sendBackgroundChange, sendAnnounce, approveSpeak, denySpeak, kickSpeaker } from './connection.js';
import { initVenue, createAllVenue, animateVenue, changeStageBackground, updateSpeakerSpotlights } from './venue.js';
import { initSettings, getSettings, updateSpeakRequests, updateCurrentSpeakers, showNotification } from './settings.js';

// --------------------------------------------
// 状態
// --------------------------------------------
let scene, camera, renderer;
let myAvatar, myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';

let isOnStage = false;
let originalPosition = null;

const remoteAvatars = new Map();

const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
let myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// --------------------------------------------
// 初期化
// --------------------------------------------
function init() {
    setupErrorHandlers();
    createDebugUI();
    debugLog('Three.js初期化開始');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050508);
    scene.fog = new THREE.Fog(0x050508, 15, 40);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    
    const container = document.getElementById('canvas-container');
    if (container) {
        container.appendChild(renderer.domElement);
        debugLog('canvas-container にレンダラー追加', 'success');
    } else {
        debugLog('canvas-container が見つからない！', 'error');
        document.body.appendChild(renderer.domElement);
    }

    const ambientLight = new THREE.AmbientLight(0x222233, 0.4);
    scene.add(ambientLight);

    // 会場作成
    initVenue(scene);
    createAllVenue();

    // 自分のアバター
    myAvatar = createAvatar(myUserId, myUserName, 0x4fc3f7);
    myAvatar.position.set((Math.random() - 0.5) * 8, 0.5, 5 + Math.random() * 3);
    scene.add(myAvatar);

    myPenlight = createPenlight(penlightColor);
    myPenlight.visible = false;
    myAvatar.add(myPenlight);

    // 設定画面初期化
    initSettings(myUserName, {
        onNameChange: (newName) => {
            myUserName = newName;
            myAvatar.userData.userName = newName;
            sendNameChange(newName);
            showNotification(`名前を「${newName}」に変更しました`);
        },
        onResetCamera: () => {
            if (isOnStage) {
                camera.position.set(myAvatar.position.x * 0.5, 3.5, -2);
                camera.lookAt(myAvatar.position.x * 0.3, 1.5, 10);
            } else {
                camera.position.set(0, 5, 12);
                camera.lookAt(0, 2, 0);
            }
            showNotification('カメラ視点をリセットしました');
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
        onChangeBackground: (url) => {
            changeStageBackground(url);
            sendBackgroundChange(url);
            showNotification('背景を変更しました');
        },
        onAnnounce: (text) => {
            sendAnnounce(text);
            showNotification(`📢 ${text}`, 'announce');
        },
        onShowNamesChange: (show) => {
            updateNameVisibility(show);
        }
    });

    // コールバック設定
    setCallbacks({
        onUserJoin: handleUserJoin,
        onUserLeave: handleUserLeave,
        onPosition: handlePosition,
        onReaction: handleReaction,
        onSpeakApproved: handleSpeakApproved,
        onSpeakerJoined: handleSpeakerJoined,
        onSpeakerLeft: handleSpeakerLeft,
        onConnectedChange: handleConnectedChange,
        onSpeakRequestsUpdate: updateSpeakRequests,
        onCurrentSpeakersUpdate: updateCurrentSpeakers,
        onAnnounce: (message) => {
            showNotification(`📢 ${message}`, 'announce');
            addChatMessage('📢 アナウンス', message);
        },
        onBackgroundChange: (url) => {
            changeStageBackground(url);
        },
        onChat: (name, message, senderId) => {
            const state = getState();
            if (senderId !== state.myServerConnectionId) {
                addChatMessage(name, message);
            }
        },
        remoteAvatars: remoteAvatars
    });

    setupEventListeners();
    connectToPartyKit(myUserName);
    setInterval(() => {
        if (myAvatar) {
            sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);
        }
    }, 100);

    animate();
    debugLog('初期化完了', 'success');

    // グローバルに公開
    window.changeStageBackground = changeStageBackground;
}

// --------------------------------------------
// 名前表示切替
// --------------------------------------------
function updateNameVisibility(show) {
    debugLog(`名前表示: ${show ? 'ON' : 'OFF'}`, 'info');
}

// --------------------------------------------
// コールバックハンドラー
// --------------------------------------------
function handleUserJoin(user) {
    if (remoteAvatars.has(user.id)) return;
    const avatar = createAvatar(user.id, user.name, user.color || 0xff6b6b);
    avatar.position.set(user.x || 0, 0.5, user.z || 5);
    avatar.userData.onStage = false;
    avatar.userData.userName = user.name;
    scene.add(avatar);
    remoteAvatars.set(user.id, avatar);
    updateUserCount();
    showNotification(`${user.name || '誰か'} が参加しました`, 'join-leave');
}

function handleUserLeave(userId) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        showNotification(`${avatar.userData?.userName || '誰か'} が退出しました`, 'join-leave');
        scene.remove(avatar);
        remoteAvatars.delete(userId);
    }
    updateUserCount();
}

function handlePosition(userId, x, y, z) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        avatar.position.x += (x - avatar.position.x) * 0.3;
        avatar.position.z += (z - avatar.position.z) * 0.3;
    }
}

function handleReaction(userId, reaction, color) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    if (reaction === 'jump') {
        let progress = 0;
        function jumpAnim() {
            progress += 0.1;
            if (progress <= Math.PI) {
                avatar.position.y = 0.5 + Math.sin(progress) * 1;
                requestAnimationFrame(jumpAnim);
            } else {
                avatar.position.y = 0.5;
            }
        }
        jumpAnim();
    } else if (reaction === 'clap') {
        let progress = 0;
        function clapAnim() {
            progress += 0.2;
            if (progress <= Math.PI) {
                const scale = 1 + Math.sin(progress) * 0.1;
                avatar.scale.set(scale, scale, scale);
                requestAnimationFrame(clapAnim);
            } else {
                avatar.scale.set(1, 1, 1);
            }
        }
        clapAnim();
    }
}

function handleSpeakApproved() {
    moveToStage();
    addChatMessage('システム', '登壇が承認されました！');
}

function handleSpeakerJoined(userId) {
    moveRemoteToStage(userId);
    addChatMessage('システム', '新しい登壇者が参加しました');
}

function handleSpeakerLeft(userId) {
    const state = getState();
    if (userId === state.myServerConnectionId) {
        moveOffStage();
        addChatMessage('システム', '登壇を終了しました');
    } else {
        moveRemoteToAudience(userId);
    }
}

function handleConnectedChange(connected) {
    updateUserCount();
}

function updateUserCount() {
    const state = getState();
    const count = remoteAvatars.size + (state.connected ? 1 : 0);
    const el = document.getElementById('user-count');
    if (el) el.textContent = `${count}人`;
}

// --------------------------------------------
// 登壇者スポットライト更新
// --------------------------------------------
function updateStageSpeakers() {
    const speakers = [];
    
    if (isOnStage && myAvatar) {
        speakers.push({
            x: myAvatar.position.x,
            y: myAvatar.position.y,
            z: myAvatar.position.z
        });
    }
    
    remoteAvatars.forEach((avatar) => {
        if (avatar.userData && avatar.userData.onStage) {
            speakers.push({
                x: avatar.position.x,
                y: avatar.position.y,
                z: avatar.position.z
            });
        }
    });
    
    updateSpeakerSpotlights(speakers);
}

// --------------------------------------------
// ステージ移動
// --------------------------------------------
function moveToStage() {
    if (isOnStage) return;
    
    originalPosition = {
        x: myAvatar.position.x,
        z: myAvatar.position.z
    };
    
    const state = getState();
    const stageX = (state.speakerCount - 1) * 2 - 4;
    const stageZ = -4;
    const stageY = 1.7;
    
    animateToPosition(myAvatar, stageX, stageY, stageZ, () => {
        isOnStage = true;
        myAvatar.rotation.y = Math.PI;
        myAvatar.userData.onStage = true;
        setAvatarSpotlight(myAvatar, true);
        debugLog('ステージに移動完了', 'success');
    });
}

function moveOffStage() {
    if (!isOnStage) return;
    
    const targetX = originalPosition ? originalPosition.x : (Math.random() - 0.5) * 8;
    const targetZ = originalPosition ? originalPosition.z : 5 + Math.random() * 3;
    
    animateToPosition(myAvatar, targetX, 0.5, targetZ, () => {
        isOnStage = false;
        myAvatar.rotation.y = 0;
        myAvatar.userData.onStage = false;
        setAvatarSpotlight(myAvatar, false);
        originalPosition = null;
        debugLog('フロアに戻りました', 'info');
    });
}

function moveRemoteToStage(userId) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    const stageX = (Math.random() - 0.5) * 8;
    animateToPosition(avatar, stageX, 1.7, -4, () => {
        avatar.rotation.y = Math.PI;
        avatar.userData = avatar.userData || {};
        avatar.userData.onStage = true;
        setAvatarSpotlight(avatar, true);
    });
}

function moveRemoteToAudience(userId) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    const targetX = (Math.random() - 0.5) * 8;
    const targetZ = 5 + Math.random() * 3;
    
    animateToPosition(avatar, targetX, 0.5, targetZ, () => {
        avatar.rotation.y = 0;
        if (avatar.userData) {
            avatar.userData.onStage = false;
        }
        setAvatarSpotlight(avatar, false);
    });
}

function animateToPosition(obj, targetX, targetY, targetZ, onComplete) {
    const startX = obj.position.x;
    const startY = obj.position.y;
    const startZ = obj.position.z;
    const duration = 1000;
    const startTime = Date.now();
    
    function doAnimate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        
        obj.position.x = startX + (targetX - startX) * eased;
        obj.position.y = startY + (targetY - startY) * eased;
        obj.position.z = startZ + (targetZ - startZ) * eased;
        
        if (progress < 1) {
            requestAnimationFrame(doAnimate);
        } else if (onComplete) {
            onComplete();
        }
    }
    doAnimate();
}

// --------------------------------------------
// リアクション
// --------------------------------------------
function setPenlightColor(color) {
    penlightColor = color;
    const light = myPenlight.getObjectByName('penlightLight');
    if (light) light.material.color.set(color);
    const pointLight = myPenlight.getObjectByName('penlightPointLight');
    if (pointLight) pointLight.color.set(color);
}

function wavePenlight() {
    if (!penlightOn) return;
    const startRotation = myPenlight.rotation.z;
    let progress = 0;
    function swing() {
        progress += 0.15;
        if (progress <= Math.PI) {
            myPenlight.rotation.z = startRotation + Math.sin(progress) * 0.3;
            requestAnimationFrame(swing);
        } else {
            myPenlight.rotation.z = startRotation;
        }
    }
    swing();
}

function doJump() {
    const startY = myAvatar.position.y;
    let progress = 0;
    function jump() {
        progress += 0.1;
        if (progress <= Math.PI) {
            myAvatar.position.y = startY + Math.sin(progress) * 1;
            requestAnimationFrame(jump);
        } else {
            myAvatar.position.y = startY;
        }
    }
    jump();
    sendReaction('jump', null);
}

function doOtagei() {
    let progress = 0;
    function otagei() {
        progress += 0.12;
        if (progress <= Math.PI * 2) {
            myAvatar.rotation.z = Math.sin(progress * 3) * 0.2;
            if (myPenlight.visible) {
                myPenlight.rotation.z = Math.PI / 6 + Math.sin(progress * 5) * 0.5;
            }
            requestAnimationFrame(otagei);
        } else {
            myAvatar.rotation.z = 0;
            myPenlight.rotation.z = Math.PI / 6;
        }
    }
    otagei();
    sendReaction('otagei', penlightColor);
}

function doClap() {
    const originalScale = myAvatar.scale.x;
    let progress = 0;
    function clap() {
        progress += 0.2;
        if (progress <= Math.PI) {
            const scale = originalScale + Math.sin(progress) * 0.1;
            myAvatar.scale.set(scale, scale, scale);
            requestAnimationFrame(clap);
        } else {
            myAvatar.scale.set(originalScale, originalScale, originalScale);
        }
    }
    clap();
    sendReaction('clap', null);
}

// --------------------------------------------
// イベントリスナー
// --------------------------------------------
function setupEventListeners() {
    window.addEventListener('resize', onWindowResize);

    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            if (type === 'penlight') {
                penlightOn = !penlightOn;
                myPenlight.visible = penlightOn;
                const colorPanel = document.getElementById('penlight-colors');
                if (colorPanel) colorPanel.classList.toggle('hidden', !penlightOn);
                if (penlightOn) { wavePenlight(); sendReaction('penlight', penlightColor); }
            } else if (type === 'jump') {
                doJump();
            } else if (type === 'clap') {
                doClap();
            } else if (type === 'otagei') {
                doOtagei();
            }
        });
    });

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            setPenlightColor(btn.dataset.color);
            wavePenlight();
        });
    });

    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('chat-input');
            const message = input.value.trim();
            if (message) {
                addChatMessage(myUserName, message);
                sendChat(myUserName, message);
                input.value = '';
            }
        });
    }

    const stageBtn = document.getElementById('request-stage-btn');
    if (stageBtn) {
        stageBtn.addEventListener('click', () => requestSpeak());
    }

    const micBtn = document.getElementById('mic-toggle-btn');
    if (micBtn) {
        micBtn.addEventListener('click', () => {
            const isOn = toggleMic();
            micBtn.textContent = isOn ? '🎙️ 配信中' : '🎙️ マイク OFF';
            micBtn.classList.toggle('speaking', isOn);
        });
    }

    let touchStartX, touchStartY;
    renderer.domElement.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchmove', (e) => {
        if (!touchStartX || !touchStartY) return;
        
        if (isOnStage) {
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.02;
            myAvatar.position.x += deltaX;
            myAvatar.position.x = Math.max(-6, Math.min(6, myAvatar.position.x));
        } else {
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.01;
            const deltaZ = (e.touches[0].clientY - touchStartY) * 0.01;
            myAvatar.position.x += deltaX;
            myAvatar.position.z += deltaZ;
            myAvatar.position.x = Math.max(-12, Math.min(12, myAvatar.position.x));
            myAvatar.position.z = Math.max(-1, Math.min(10, myAvatar.position.z));
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --------------------------------------------
// アニメーションループ
// --------------------------------------------
function animate() {
    requestAnimationFrame(animate);
    
    updateStageSpeakers();
    animateVenue();
    
    if (myAvatar) {
        if (isOnStage) {
            camera.position.x += (myAvatar.position.x * 0.5 - camera.position.x) * 0.05;
            camera.position.y += (3.5 - camera.position.y) * 0.05;
            camera.position.z += (-2 - camera.position.z) * 0.05;
            camera.lookAt(myAvatar.position.x * 0.3, 1.5, 10);
        } else {
            camera.position.x += (myAvatar.position.x * 0.3 - camera.position.x) * 0.05;
            camera.position.z += (myAvatar.position.z + 8 - camera.position.z) * 0.05;
            camera.position.y += (5 - camera.position.y) * 0.05;
            camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
        }
    }
    renderer.render(scene, camera);
}

// --------------------------------------------
// 起動
// --------------------------------------------
init();
