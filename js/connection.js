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
const pendingStreams = [];

let speakerCount = 0;
let audioUnlocked = false;

// 共有AudioContext（iOS Safari対策：1個だけ作成）
let sharedAudioContext = null;
let masterGainNode = null;

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
// 共有AudioContext管理（iOS Safari対策の核心）
// --------------------------------------------
function createSharedAudioContext() {
    if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
        return sharedAudioContext;
    }
    
    try {
        sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'interactive',
            sampleRate: 48000
        });
        
        masterGainNode = sharedAudioContext.createGain();
        masterGainNode.gain.value = 1.0;
        masterGainNode.connect(sharedAudioContext.destination);
        
        debugLog(`SharedAudioContext作成: state=${sharedAudioContext.state}`, 'info');
        return sharedAudioContext;
    } catch (e) {
        debugLog(`SharedAudioContext作成失敗: ${e.message}`, 'error');
        return null;
    }
}

async function unlockAudioContext() {
    if (audioUnlocked && sharedAudioContext && sharedAudioContext.state === 'running') {
        debugLog('AudioContext既にアンロック済み', 'info');
        return true;
    }
    
    if (!sharedAudioContext) {
        createSharedAudioContext();
    }
    
    if (!sharedAudioContext) {
        debugLog('AudioContext作成できず', 'error');
        return false;
    }
    
    try {
        if (sharedAudioContext.state === 'suspended') {
            debugLog('AudioContext resume試行...', 'info');
            await sharedAudioContext.resume();
            debugLog(`AudioContext resume完了: state=${sharedAudioContext.state}`, 'success');
        }
        
        if (sharedAudioContext.state === 'running') {
            audioUnlocked = true;
            debugLog('AudioContextアンロック成功！', 'success');
            
            connectPendingStreams();
            
            const btn = document.getElementById('audio-unlock-btn');
            if (btn) btn.remove();
            
            return true;
        } else {
            debugLog(`AudioContextがrunningにならない: ${sharedAudioContext.state}`, 'error');
            return false;
        }
    } catch (e) {
        debugLog(`AudioContext resume失敗: ${e.message}`, 'error');
        return false;
    }
}

function connectPendingStreams() {
    if (!sharedAudioContext || sharedAudioContext.state !== 'running') {
        debugLog('AudioContextがrunningではないため、ストリーム接続をスキップ', 'warn');
        return;
    }
    
    debugLog(`待機中ストリーム接続: ${pendingStreams.length}件`, 'info');
    
    while (pendingStreams.length > 0) {
        const { stream, trackName, odUserId } = pendingStreams.shift();
        connectStreamToAudioContext(stream, trackName, odUserId);
    }
}

function connectStreamToAudioContext(stream, trackName, odUserId) {
    debugLog(`ストリーム接続試行: ${trackName}, AudioContext state=${sharedAudioContext?.state}, audioUnlocked=${audioUnlocked}`, 'info');
    
    if (!sharedAudioContext || sharedAudioContext.state !== 'running') {
        debugLog(`ストリーム待機リストに追加: ${trackName}`, 'info');
        pendingStreams.push({ stream, trackName, odUserId });
        showAudioUnlockButton();
        return false;
    }
    
    try {
        const source = sharedAudioContext.createMediaStreamSource(stream);
        const gainNode = sharedAudioContext.createGain();
        gainNode.gain.value = 1.0;
        
        source.connect(gainNode);
        gainNode.connect(masterGainNode);
        
        const trackInfo = subscribedTracks.get(trackName);
        if (trackInfo) {
            trackInfo.source = source;
            trackInfo.gainNode = gainNode;
        }
        
        const latency = sharedAudioContext.baseLatency ? (sharedAudioContext.baseLatency * 1000).toFixed(1) : '不明';
        debugLog(`ストリーム接続成功: ${trackName} (レイテンシ: ${latency}ms)`, 'success');
        
        if (callbacks.remoteAvatars && odUserId) {
            const userData = callbacks.remoteAvatars.get(odUserId);
            if (userData && userData.avatar) {
                addSpeakerIndicator(userData.avatar);
            }
        }
        
        return true;
    } catch (e) {
        debugLog(`ストリーム接続失敗: ${e.message}`, 'error');
        return false;
    }
}

// --------------------------------------------
// 音声アンロックボタン（iOS Safari用）
// --------------------------------------------
function showAudioUnlockButton() {
    if (audioUnlocked && sharedAudioContext && sharedAudioContext.state === 'running') {
        return;
    }
    
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
        debugLog('音声アンロックボタン押下', 'info');
        const success = await unlockAudioContext();
        if (success) {
            debugLog('ユーザー操作による音声アンロック完了！', 'success');
        } else {
            debugLog('音声アンロック失敗', 'error');
        }
    };
    
    document.body.appendChild(btn);
    debugLog('音声アンロックボタン表示', 'warn');
}

function setupAudioUnlock() {
    createSharedAudioContext();
    
    const handleUserGesture = async () => {
        if (audioUnlocked && sharedAudioContext && sharedAudioContext.state === 'running') {
            return;
        }
        
        debugLog('ユーザー操作検出、AudioContextアンロック試行', 'info');
        await unlockAudioContext();
    };
    
    document.addEventListener('touchstart', handleUserGesture, { once: false, passive: true });
    document.addEventListener('touchend', handleUserGesture, { once: false, passive: true });
    document.addEventListener('click', handleUserGesture, { once: false });
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
            if (obj.source) { try { obj.source.disconnect(); } catch(e) {} }
            if (obj.gainNode) { try { obj.gainNode.disconnect(); } catch(e) {} }
            if (obj.pc) { try { obj.pc.close(); } catch(e) {} }
        });
        subscribedTracks.clear();
        pendingSubscriptions.clear();
        pendingStreams.length = 0;
        
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
            const reqUserId = data.userId || data.odUserId;
            const reqUserName = data.userName || 'ゲスト';
            
            if (!speakRequests.find(r => r.userId === reqUserId)) {
                speakRequests.push({ userId: reqUserId, userName: reqUserName });
                debugLog(`登壇リクエスト受信: ${reqUserName} (${reqUserId})`, 'info');
            }
            
            if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            break;

        case 'speakRequestsUpdate':
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
            
            if (!audioUnlocked || !sharedAudioContext || sharedAudioContext.state !== 'running') {
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
    
    currentSpeakers = speakersArray.map(id => {
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
        debugLog('マイク取得開始...', 'info');
        
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: false,
                autoGainControl: false,
                latency: 0.01,
                sampleRate: 48000,
                channelCount: 1
            }, 
            video: false 
        });
        
        debugLog('マイク取得成功', 'success');
        
        // マイク許可はユーザー操作なので、ここでAudioContextをアンロック
        await unlockAudioContext();
        
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
                maxBitrate: 128000,
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
    
    debugLog(`購読処理: ${trackName}`, 'info');
    
    try {
        const pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        pc.ontrack = (event) => {
            debugLog(`音声トラック受信: ${trackName}`, 'success');
            
            const stream = event.streams[0] || new MediaStream([event.track]);
            
            debugLog(`トラック状態: readyState=${event.track.readyState}, AudioContext=${sharedAudioContext?.state}, audioUnlocked=${audioUnlocked}`, 'info');
            
            // 共有AudioContextに接続（新しいAudioContextを作らない！）
            connectStreamToAudioContext(stream, trackName, pendingInfo.odUserId);
        };
        
        let offerSdp = typeof data.offer === 'string' ? data.offer : data.offer.sdp;
        
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 100);
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
            pc: pc, 
            sessionId: data.sessionId,
            source: null,
            gainNode: null
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
            if (obj.source) { 
                try { obj.source.disconnect(); } catch(e) {} 
            }
            if (obj.gainNode) { 
                try { obj.gainNode.disconnect(); } catch(e) {} 
            }
            if (obj.pc) { 
                try { obj.pc.close(); } catch(e) {} 
            }
            subscribedTracks.delete(trackName);
        }
    }
    for (const [trackName, obj] of pendingSubscriptions) {
        if (obj.odUserId === odUserId) pendingSubscriptions.delete(trackName);
    }
    
    for (let i = pendingStreams.length - 1; i >= 0; i--) {
        if (pendingStreams[i].odUserId === odUserId) {
            pendingStreams.splice(i, 1);
        }
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
        speakRequests = speakRequests.filter(r => r.userId !== userId);
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
    }
}

export function denySpeak(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        debugLog(`登壇却下送信: ${userId}`, 'info');
        socket.send(JSON.stringify({ type: 'denySpeak', userId }));
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

export function getSpeakRequests() {
    return [...speakRequests];
}

export function getCurrentSpeakers() {
    return [...currentSpeakers];
}
