// ============================================
// connection.js - PartyKit接続・音声通話
// ============================================

import { debugLog, isIOS, addSpeakerIndicator, removeSpeakerIndicator, setAvatarImage } from './utils.js';

// --------------------------------------------
// 設定
// --------------------------------------------
const PARTYKIT_HOST = 'kimurameta.kimura-jane.partykit.dev';
const ROOM_ID = 'main-stage';

// --------------------------------------------
// 状態
// --------------------------------------------
let socket = null;
let connected = false;
let myServerConnectionId = null;
let turnCredentials = null;
let currentUserName = '';

let localStream = null;
let peerConnection = null;
let mySessionId = null;
let isSpeaker = false;
let isMicMuted = false;
let myPublishedTrackName = null;

const subscribedTracks = new Map();
const pendingSubscriptions = new Map();
const pendingAudioElements = [];

let speakerCount = 0;
let audioUnlocked = false;

// 登壇リクエスト・登壇者リスト
let speakRequests = [];
let currentSpeakers = [];

// コールバック
let callbacks = {
    onUserJoin: null,
    onUserLeave: null,
    onPosition: null,
    onReaction: null,
    onAvatarChange: null,
    onNameChange: null,
    onSpeakApproved: null,
    onSpeakerJoined: null,
    onSpeakerLeft: null,
    onConnectedChange: null,
    onSpeakRequestsUpdate: null,
    onCurrentSpeakersUpdate: null,
    onAnnounce: null,
    onBackgroundChange: null,
    onBrightnessChange: null,
    onChat: null,
    onKicked: null,
    remoteAvatars: null
};

export function setCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

export function getState() {
    return {
        connected,
        isSpeaker,
        isMicMuted,
        speakerCount,
        myServerConnectionId,
        subscribedTracks,
        speakRequests,
        currentSpeakers
    };
}

export function getMyConnectionId() {
    return myServerConnectionId;
}

// --------------------------------------------
// ICE サーバー設定
// --------------------------------------------
function getIceServers() {
    const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    
    if (turnCredentials) {
        servers.push({
            urls: 'turn:turn.cloudflare.com:3478?transport=udp',
            username: turnCredentials.username,
            credential: turnCredentials.credential
        });
        servers.push({
            urls: 'turn:turn.cloudflare.com:3478?transport=tcp',
            username: turnCredentials.username,
            credential: turnCredentials.credential
        });
    }
    
    return servers;
}

// --------------------------------------------
// 音声アンロック（iOS Safari用）
// --------------------------------------------
function setupAudioUnlock() {
    if (audioUnlocked) return;
    
    const unlockAudio = async () => {
        if (audioUnlocked) return;
        
        debugLog('音声アンロック試行...', 'info');
        
        for (const audio of pendingAudioElements) {
            try {
                await audio.play();
                debugLog('保留音声再生成功', 'success');
            } catch (e) {
                debugLog(`保留音声再生失敗: ${e.message}`, 'warn');
            }
        }
        
        for (const [trackName, obj] of subscribedTracks) {
            if (obj.audio) {
                try {
                    await obj.audio.play();
                    debugLog(`音声再生成功: ${trackName}`, 'success');
                } catch (e) {
                    debugLog(`音声再生失敗: ${trackName}: ${e.message}`, 'warn');
                }
            }
        }
        
        audioUnlocked = true;
        debugLog('音声アンロック完了', 'success');
        
        const btn = document.getElementById('audio-unlock-btn');
        if (btn) btn.remove();
    };
    
    document.addEventListener('touchstart', unlockAudio, { once: false });
    document.addEventListener('click', unlockAudio, { once: false });
}

function showAudioUnlockButton() {
    if (audioUnlocked) return;
    
    const existing = document.getElementById('audio-unlock-btn');
    if (existing) return;
    
    const btn = document.createElement('button');
    btn.id = 'audio-unlock-btn';
    btn.textContent = '🔊 タップして音声を有効化';
    btn.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 20px 40px;
        font-size: 18px;
        background: linear-gradient(135deg, #ff66ff, #9966ff);
        color: white;
        border: none;
        border-radius: 20px;
        z-index: 20000;
        cursor: pointer;
        box-shadow: 0 4px 30px rgba(255, 102, 255, 0.5);
    `;
    
    btn.onclick = async () => {
        debugLog('音声アンロック開始', 'info');
        
        for (const audio of pendingAudioElements) {
            try {
                await audio.play();
                debugLog('保留音声再生成功', 'success');
            } catch (e) {
                debugLog(`保留音声再生失敗: ${e.message}`, 'warn');
            }
        }
        
        for (const [trackName, obj] of subscribedTracks) {
            if (obj.audio) {
                try {
                    await obj.audio.play();
                    debugLog(`音声再生成功: ${trackName}`, 'success');
                } catch (e) {
                    debugLog(`音声再生失敗: ${trackName}: ${e.message}`, 'warn');
                }
            }
        }
        
        audioUnlocked = true;
        btn.remove();
        debugLog('音声アンロック完了', 'success');
    };
    
    document.body.appendChild(btn);
    debugLog('音声アンロックボタン表示', 'warn');
}

function resumeAllAudio() {
    debugLog('全音声再開処理', 'info');
    
    let hasFailedAudio = false;
    
    subscribedTracks.forEach((obj, trackName) => {
        if (obj.audio) {
            obj.audio.play()
                .then(() => debugLog(`音声再開: ${trackName}`, 'success'))
                .catch(e => {
                    debugLog(`音声再開失敗: ${trackName}: ${e.message}`, 'warn');
                    hasFailedAudio = true;
                });
        }
    });
    
    if (hasFailedAudio && !audioUnlocked) {
        showAudioUnlockButton();
    }
}

// --------------------------------------------
// PartyKit接続
// --------------------------------------------
export function connectToPartyKit(userName) {
    currentUserName = userName;
    const wsUrl = `wss://${PARTYKIT_HOST}/party/${ROOM_ID}?name=${encodeURIComponent(userName)}`;
    debugLog(`接続開始: ${PARTYKIT_HOST}`);
    
    setupAudioUnlock();
    
    try {
        socket = new WebSocket(wsUrl);
    } catch (e) {
        debugLog(`WebSocket作成エラー: ${e}`, 'error');
        return;
    }
    
    socket.onopen = () => {
        debugLog('PartyKit接続成功！', 'success');
        connected = true;
        if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);
    };
    
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type !== 'position') {
                debugLog(`受信: ${data.type}`);
            }
            handleServerMessage(data);
        } catch (e) {
            debugLog(`メッセージ解析エラー: ${e}`, 'error');
        }
    };
    
    socket.onclose = () => {
        debugLog('接続切断 - 3秒後再接続', 'warn');
        connected = false;
        if (callbacks.onConnectedChange) callbacks.onConnectedChange(false);
        
        subscribedTracks.forEach((obj) => {
            if (obj.pc) { try { obj.pc.close(); } catch(e) {} }
            if (obj.audio) { obj.audio.pause(); obj.audio.srcObject = null; }
            if (obj.audioContext) { try { obj.audioContext.close(); } catch(e) {} }
        });
        subscribedTracks.clear();
        pendingSubscriptions.clear();
        
        setTimeout(() => connectToPartyKit(currentUserName), 3000);
    };
    
    socket.onerror = () => {
        debugLog('WebSocketエラー', 'error');
    };
}

function handleServerMessage(data) {
    switch(data.type) {
        case 'init':
            myServerConnectionId = data.yourId;
            debugLog(`初期化: ID=${myServerConnectionId}, ${Object.keys(data.users).length}人`);
            
            if (data.turnCredentials) {
                turnCredentials = data.turnCredentials;
                debugLog('TURN認証情報取得', 'success');
            }
            
            Object.entries(data.users).forEach(([odUserId, user]) => {
                if (odUserId !== myServerConnectionId) {
                    if (callbacks.onUserJoin) {
                        callbacks.onUserJoin(odUserId, user.name || user.userName || 'ゲスト');
                    }
                    
                    if (callbacks.onPosition && user.x !== undefined && user.z !== undefined) {
                        setTimeout(() => {
                            callbacks.onPosition(odUserId, user.x, user.y ?? 0, user.z);
                        }, 100);
                    }
                    
                    if (callbacks.onAvatarChange && user.avatarUrl) {
                        setTimeout(() => {
                            callbacks.onAvatarChange(odUserId, user.avatarUrl);
                        }, 200);
                    }
                }
            });
            
            if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);
            updateSpeakerList(data.speakers || []);
            
            // 初期の登壇リクエストリストがあれば設定
            if (data.speakRequests) {
                speakRequests = data.speakRequests;
                if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            }
            
            if (data.brightness !== undefined && callbacks.onBrightnessChange) {
                callbacks.onBrightnessChange(data.brightness);
            }
            
            if (data.backgroundUrl && callbacks.onBackgroundChange) {
                callbacks.onBackgroundChange(data.backgroundUrl);
            }
            
            if (data.tracks && data.sessions) {
                const tracksArray = Array.isArray(data.tracks) ? data.tracks : [];
                const sessionsArray = Array.isArray(data.sessions) ? data.sessions : [];
                const sessionsMap = new Map(sessionsArray);
                
                setTimeout(() => {
                    tracksArray.forEach(([odUserId, trackName]) => {
                        if (odUserId === myServerConnectionId) return;
                        const speakerSessionId = sessionsMap.get(odUserId);
                        if (speakerSessionId) {
                            subscribeToTrack(odUserId, speakerSessionId, trackName);
                        }
                    });
                }, 500);
            }
            break;
            
        case 'userJoin':
            const joinUserId = data.odUserId || data.userId || data.user?.id;
            const joinUserName = data.userName || data.user?.name || 'ゲスト';
            debugLog(`userJoin: ${joinUserId} (${joinUserName})`, 'info');
            if (joinUserId && joinUserId !== myServerConnectionId && callbacks.onUserJoin) {
                callbacks.onUserJoin(joinUserId, joinUserName);
            }
            break;
            
        case 'userLeave':
            const leaveUserId = data.odUserId || data.userId;
            debugLog(`userLeave: ${leaveUserId}`, 'info');
            if (callbacks.onUserLeave) callbacks.onUserLeave(leaveUserId);
            removeRemoteAudio(leaveUserId);
            if (data.speakers) updateSpeakerList(data.speakers);
            // 退出したユーザーをリクエストリストからも削除
            speakRequests = speakRequests.filter(r => r.userId !== leaveUserId);
            if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            break;
            
        case 'position':
            const posUserId = data.odUserId || data.userId;
            const posX = data.x;
            const posY = data.y ?? 0;
            const posZ = data.z;
            if (callbacks.onPosition) {
                callbacks.onPosition(posUserId, posX, posY, posZ);
            }
            break;
            
        case 'avatarChange':
            const avatarUserId = data.odUserId || data.userId;
            debugLog(`avatarChange: ${avatarUserId} -> ${data.imageUrl}`, 'info');
            if (callbacks.onAvatarChange) {
                callbacks.onAvatarChange(avatarUserId, data.imageUrl);
            }
            break;
            
        case 'nameChange':
            const nameUserId = data.odUserId || data.userId;
            debugLog(`nameChange: ${nameUserId} -> ${data.name}`, 'info');
            if (callbacks.onNameChange) {
                callbacks.onNameChange(nameUserId, data.name);
            }
            break;
            
        case 'reaction':
            const reactUserId = data.odUserId || data.userId;
            if (callbacks.onReaction) callbacks.onReaction(reactUserId, data.reaction, data.color);
            break;
            
        case 'chat':
            if (callbacks.onChat) {
                const senderId = data.senderId || data.odUserId || data.userId;
                callbacks.onChat(senderId, data.name, data.message);
            }
            break;

        case 'speakRequest':
            // 新しい登壇リクエストを追加
            const reqUserId = data.userId || data.odUserId;
            const reqUserName = data.userName || 'ゲスト';
            
            // 重複チェック
            if (!speakRequests.find(r => r.userId === reqUserId)) {
                speakRequests.push({ userId: reqUserId, userName: reqUserName });
                debugLog(`登壇リクエスト受信: ${reqUserName} (${reqUserId})`, 'info');
            }
            
            if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            break;

        case 'speakRequestsUpdate':
            // サーバーからの登壇リクエストリスト全体更新
            speakRequests = data.requests || [];
            debugLog(`登壇リクエストリスト更新: ${speakRequests.length}件`, 'info');
            if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            break;

        case 'speakApproved':
            mySessionId = data.sessionId;
            isSpeaker = true;
            
            if (!currentSpeakers.find(s => s.userId === myServerConnectionId)) {
                currentSpeakers.push({ userId: myServerConnectionId, userName: currentUserName });
            }
            speakerCount = currentSpeakers.length;
            
            updateSpeakerButton();
            updateSpeakerCountUI();
            
            if (callbacks.onCurrentSpeakersUpdate) {
                callbacks.onCurrentSpeakersUpdate(currentSpeakers);
            }
            
            startPublishing();
            if (callbacks.onSpeakApproved) callbacks.onSpeakApproved();
            break;

        case 'speakDenied':
            debugLog(`speakDenied: ${data.reason}`, 'warn');
            if (callbacks.onChat) {
                callbacks.onChat('system', 'システム', data.reason || '登壇リクエストが却下されました');
            }
            break;

        case 'speakerJoined':
            const speakerJoinedId = data.odUserId || data.userId;
            const speakerJoinedName = data.userName || 'ゲスト';
            debugLog(`speakerJoined: ${speakerJoinedId} (${speakerJoinedName})`, 'info');
            
            // 登壇者リストに追加
            if (!currentSpeakers.find(s => s.userId === speakerJoinedId)) {
                currentSpeakers.push({ userId: speakerJoinedId, userName: speakerJoinedName });
            }
            
            if (data.speakers) updateSpeakerList(data.speakers);
            if (callbacks.onSpeakerJoined) callbacks.onSpeakerJoined(speakerJoinedId, speakerJoinedName);
            if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
            break;

        case 'speakerLeft':
            const leftUserId = data.odUserId || data.userId;
            debugLog(`speakerLeft: ${leftUserId}`, 'info');
            
            // 登壇者リストから削除
            currentSpeakers = currentSpeakers.filter(s => s.userId !== leftUserId);
            
            if (data.speakers) updateSpeakerList(data.speakers);
            removeRemoteAudio(leftUserId);
            if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(leftUserId);
            if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
            break;

        case 'trackPublished':
            handleTrackPublished(data);
            break;

        case 'newTrack':
            const trackUserId = data.odUserId || data.userId;
            const newTrackName = data.trackName;
            
            debugLog(`newTrack受信: user=${trackUserId}, track=${newTrackName}`, 'info');
            
            if (trackUserId === myServerConnectionId) return;
            if (myPublishedTrackName && newTrackName === myPublishedTrackName) return;
            
            if (!audioUnlocked) {
                showAudioUnlockButton();
            }
            
            setTimeout(() => {
                subscribeToTrack(trackUserId, data.sessionId, newTrackName);
            }, 300);
            break;

        case 'subscribed':
            handleSubscribed(data);
            break;
            
        case 'subscribeAnswerAck':
            debugLog('Answer確認OK', 'success');
            break;

        case 'announce':
            if (callbacks.onAnnounce) callbacks.onAnnounce(data.message);
            break;

        case 'backgroundChange':
            if (callbacks.onBackgroundChange) callbacks.onBackgroundChange(data.url);
            break;

        case 'brightnessChange':
            if (callbacks.onBrightnessChange) callbacks.onBrightnessChange(data.value);
            break;

        case 'kicked':
            // 強制降壇された
            debugLog('強制降壇されました', 'warn');
            stopSpeaking();
            if (callbacks.onKicked) callbacks.onKicked();
            if (callbacks.onChat) {
                callbacks.onChat('system', 'システム', '主催者により登壇を終了しました');
            }
            break;
            
        case 'error':
            debugLog(`サーバーエラー: ${data.code || data.message}`, 'error');
            break;
    }
}

// --------------------------------------------
// 登壇者数UIを更新
// --------------------------------------------
function updateSpeakerCountUI() {
    const el = document.getElementById('speaker-count');
    if (el) {
        el.textContent = speakerCount;
    }
}

// --------------------------------------------
// 登壇者リスト更新
// --------------------------------------------
function updateSpeakerList(speakers) {
    const speakersArray = Array.isArray(speakers) ? speakers : [];
    
    if (isSpeaker && !speakersArray.includes(myServerConnectionId)) {
        speakersArray.push(myServerConnectionId);
    }
    
    speakerCount = speakersArray.length;
    updateSpeakerButton();
    updateSpeakerCountUI();
    
    // currentSpeakers を更新
    currentSpeakers = speakersArray.map(id => {
        // 既存のエントリがあればそれを使う
        const existing = currentSpeakers.find(s => s.userId === id);
        if (existing) return existing;
        
        if (id === myServerConnectionId) {
            return { userId: id, userName: currentUserName };
        }
        const userData = callbacks.remoteAvatars?.get(id);
        return { userId: id, userName: userData?.userName || 'ゲスト' };
    });
    
    if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
    
    if (callbacks.remoteAvatars) {
        callbacks.remoteAvatars.forEach((userData, odUserId) => {
            if (userData && userData.avatar) {
                if (speakersArray.includes(odUserId)) {
                    addSpeakerIndicator(userData.avatar);
                } else {
                    removeSpeakerIndicator(userData.avatar);
                }
            }
        });
    }
}

// --------------------------------------------
// 音声通話
// --------------------------------------------
export function requestSpeak() {
    if (isSpeaker) {
        stopSpeaking();
        return;
    }
    debugLog('登壇リクエスト送信', 'info');
    socket.send(JSON.stringify({ type: 'requestSpeak' }));
}

export function stopSpeaking() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (isSpeaker) {
        currentSpeakers = currentSpeakers.filter(s => s.userId !== myServerConnectionId);
        speakerCount = Math.max(0, currentSpeakers.length);
        updateSpeakerCountUI();
        if (callbacks.onCurrentSpeakersUpdate) {
            callbacks.onCurrentSpeakersUpdate(currentSpeakers);
        }
    }
    
    isSpeaker = false;
    isMicMuted = false;
    mySessionId = null;
    myPublishedTrackName = null;
    updateSpeakerButton();
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stopSpeak' }));
    }
    
    if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(myServerConnectionId);
}

async function startPublishing() {
    try {
        debugLog('マイク取得開始（低遅延モード）...', 'info');
        
        // 低遅延設定でマイク取得
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,      // ハウリング防止のため有効
                noiseSuppression: false,     // 遅延削減
                autoGainControl: false,      // 遅延削減
                latency: 0.01,               // 最小遅延（10ms目標）
                sampleRate: 48000,           // 高サンプルレート
                channelCount: 1              // モノラル（処理軽減）
            }, 
            video: false 
        });
        
        debugLog('マイク取得成功（低遅延）', 'success');
        
        audioUnlocked = true;
        const unlockBtn = document.getElementById('audio-unlock-btn');
        if (unlockBtn) unlockBtn.remove();
        
        setTimeout(resumeAllAudio, 50);
        
        peerConnection = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('No audio track');
        
        const transceiver = peerConnection.addTransceiver(audioTrack, { 
            direction: 'sendonly',
            sendEncodings: [{
                maxBitrate: 128000,  // 128kbps
                priority: 'high'
            }]
        });
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        let mid = transceiver.mid;
        if (!mid) {
            const sdp = peerConnection.localDescription?.sdp || '';
            const midMatch = sdp.match(/a=mid:(\S+)/);
            mid = midMatch ? midMatch[1] : "0";
        }
        
        const trackName = `audio-${myServerConnectionId}`;
        myPublishedTrackName = trackName;
        
        debugLog(`トラック公開: ${trackName}`, 'info');
        
        socket.send(JSON.stringify({
            type: 'publishTrack',
            sessionId: mySessionId,
            offer: { sdp: peerConnection.localDescription.sdp, type: 'offer' },
            tracks: [{ location: 'local', mid: mid, trackName: trackName }]
        }));
        
    } catch (error) {
        debugLog(`publishエラー: ${error.message}`, 'error');
        stopSpeaking();
    }
}

async function handleTrackPublished(data) {
    if (!peerConnection || !data.answer) return;
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        debugLog('トラック公開完了', 'success');
        setTimeout(resumeAllAudio, 50);
    } catch (e) {
        debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
    }
}

async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
    if (odUserId === myServerConnectionId) return;
    if (trackName === myPublishedTrackName) return;
    if (subscribedTracks.has(trackName)) return;
    if (pendingSubscriptions.has(trackName)) return;
    
    debugLog(`トラック購読開始: ${trackName}`, 'info');
    
    pendingSubscriptions.set(trackName, { odUserId, remoteSessionId });
    
    socket.send(JSON.stringify({
        type: 'subscribeTrack',
        visitorId: odUserId,
        remoteSessionId: remoteSessionId,
        trackName: trackName
    }));
}

async function handleSubscribed(data) {
    if (!data.offer) return;
    
    const trackName = data.trackName;
    const pendingInfo = pendingSubscriptions.get(trackName);
    if (!pendingInfo) return;
    
    debugLog(`購読処理（低遅延モード）: ${trackName}`, 'info');
    
    try {
        const pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        let audioContext = null;
        
        pc.ontrack = (event) => {
            debugLog(`音声トラック受信: ${trackName}`, 'success');
            
            const stream = event.streams[0] || new MediaStream([event.track]);
            
            // AudioContext を使用した低遅延再生
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    latencyHint: 'interactive',  // 低遅延モード
                    sampleRate: 48000
                });
                
                const source = audioContext.createMediaStreamSource(stream);
                
                // ゲインノードで音量調整可能に
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 1.0;
                
                source.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                // AudioContext が suspended の場合は resume
                if (audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        debugLog(`AudioContext再開: ${trackName}`, 'success');
                    });
                }
                
                debugLog(`低遅延AudioContext有効: ${trackName} (レイテンシ: ${(audioContext.baseLatency * 1000).toFixed(1)}ms)`, 'success');
                
                const trackInfo = subscribedTracks.get(trackName);
                if (trackInfo) {
                    trackInfo.audioContext = audioContext;
                    trackInfo.gainNode = gainNode;
                }
                
            } catch (e) {
                debugLog(`AudioContext作成失敗、通常再生にフォールバック: ${e.message}`, 'warn');
                
                // フォールバック: 通常のAudio要素
                const audio = new Audio();
                audio.srcObject = stream;
                audio.autoplay = true;
                audio.volume = 1.0;
                
                pendingAudioElements.push(audio);
                
                audio.play()
                    .then(() => {
                        debugLog(`音声再生開始: ${trackName}`, 'success');
                        const idx = pendingAudioElements.indexOf(audio);
                        if (idx !== -1) pendingAudioElements.splice(idx, 1);
                    })
                    .catch((err) => {
                        debugLog(`音声再生失敗: ${err.message}`, 'warn');
                        if (!audioUnlocked) {
                            showAudioUnlockButton();
                        }
                    });
                
                const trackInfo = subscribedTracks.get(trackName);
                if (trackInfo) {
                    trackInfo.audio = audio;
                }
            }
            
            if (callbacks.remoteAvatars) {
                const trackInfo = subscribedTracks.get(trackName);
                if (trackInfo) {
                    const userData = callbacks.remoteAvatars.get(trackInfo.odUserId);
                    if (userData && userData.avatar) {
                        addSpeakerIndicator(userData.avatar);
                    }
                }
            }
        };
        
        let offerSdp = typeof data.offer === 'string' ? data.offer : data.offer.sdp;
        
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        // ICE gathering を素早く完了
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 100);  // 100msで打ち切り
            pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(timeout); resolve(); } };
        });
        
        socket.send(JSON.stringify({
            type: 'subscribeAnswer',
            sessionId: data.sessionId,
            answer: { type: 'answer', sdp: pc.localDescription.sdp }
        }));
        
        pendingSubscriptions.delete(trackName);
        subscribedTracks.set(trackName, { 
            odUserId: pendingInfo.odUserId, 
            audio: null, 
            audioContext: null,
            gainNode: null,
            pc: pc, 
            sessionId: data.sessionId 
        });
        
        debugLog(`購読完了: ${trackName}`, 'success');
        
    } catch (e) {
        debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
        pendingSubscriptions.delete(trackName);
    }
}

function removeRemoteAudio(odUserId) {
    for (const [trackName, obj] of subscribedTracks) {
        if (obj.odUserId === odUserId) {
            debugLog(`音声削除: ${trackName}`, 'info');
            if (obj.audio) { obj.audio.pause(); obj.audio.srcObject = null; }
            if (obj.audioContext) { try { obj.audioContext.close(); } catch(e) {} }
            if (obj.pc) { try { obj.pc.close(); } catch(e) {} }
            subscribedTracks.delete(trackName);
        }
    }
    for (const [trackName, obj] of pendingSubscriptions) {
        if (obj.odUserId === odUserId) pendingSubscriptions.delete(trackName);
    }
}

function updateSpeakerButton() {
    const btn = document.getElementById('request-stage-btn');
    const btnPanel = document.getElementById('request-stage-btn-panel');
    
    const updateBtn = (b) => {
        if (!b) return;
        if (isSpeaker) {
            b.textContent = `🎤 登壇中 (${speakerCount}/5)`;
            b.style.background = 'linear-gradient(135deg, #00c853, #69f0ae)';
        } else {
            b.textContent = `🎤 登壇リクエスト (${speakerCount}/5)`;
            b.style.background = '';
        }
    };
    
    updateBtn(btn);
    updateBtn(btnPanel);
}

export function toggleMic() {
    if (isSpeaker && localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isMicMuted = !audioTrack.enabled;
            debugLog(`マイク: ${isMicMuted ? 'OFF' : 'ON'}`, 'info');
            return !isMicMuted;
        }
    }
    return false;
}

// --------------------------------------------
// 送信
// --------------------------------------------
export function sendPosition(x, y, z) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'position', x, y, z }));
    }
}

export function sendReaction(reaction, color) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'reaction', reaction, color }));
    }
}

export function sendChat(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ 
            type: 'chat', 
            name: currentUserName,
            message: message,
            senderId: myServerConnectionId
        }));
    }
}

export function sendNameChange(newName) {
    currentUserName = newName;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'nameChange', name: newName }));
    }
}

export function sendAvatarChange(imageUrl) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'avatarChange', imageUrl }));
    }
}

export function sendBackgroundChange(url) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'backgroundChange', url }));
    }
}

export function sendBrightness(value) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'brightnessChange', value }));
    }
}

export function sendAnnounce(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'announce', message }));
    }
}

// --------------------------------------------
// 主催者機能
// --------------------------------------------
export function approveSpeak(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        debugLog(`登壇許可送信: ${userId}`, 'info');
        socket.send(JSON.stringify({ type: 'approveSpeak', userId }));
        // ローカルのリクエストリストからも削除
        speakRequests = speakRequests.filter(r => r.userId !== userId);
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
    }
}

export function denySpeak(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        debugLog(`登壇却下送信: ${userId}`, 'info');
        socket.send(JSON.stringify({ type: 'denySpeak', userId }));
        // ローカルのリクエストリストからも削除
        speakRequests = speakRequests.filter(r => r.userId !== userId);
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
    }
}

export function kickSpeaker(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        debugLog(`強制降壇送信: ${userId}`, 'info');
        socket.send(JSON.stringify({ type: 'kickSpeaker', userId }));
    }
}

// 登壇リクエストリストを取得
export function getSpeakRequests() {
    return [...speakRequests];
}

// 現在の登壇者リストを取得
export function getCurrentSpeakers() {
    return [...currentSpeakers];
}
