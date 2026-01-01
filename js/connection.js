// ============================================
// PartyKit接続・音声通話
// ============================================

import { debugLog, isIOS, addChatMessage, addSpeakerIndicator, removeSpeakerIndicator } from './utils.js';

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
let myPublishedTrackName = null;

const subscribedTracks = new Map();
const pendingSubscriptions = new Map();

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
    onSpeakApproved: null,
    onSpeakerJoined: null,
    onSpeakerLeft: null,
    onConnectedChange: null,
    onSpeakRequestsUpdate: null,
    onCurrentSpeakersUpdate: null,
    onAnnounce: null,
    onBackgroundChange: null,
    remoteAvatars: null
};

export function setCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

export function getState() {
    return {
        connected,
        isSpeaker,
        speakerCount,
        myServerConnectionId,
        subscribedTracks,
        speakRequests,
        currentSpeakers
    };
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
function showAudioUnlockButton() {
    if (audioUnlocked) return;
    
    const existing = document.getElementById('audio-unlock-btn');
    if (existing) existing.remove();
    
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
        background: #ff6b6b;
        color: white;
        border: none;
        border-radius: 10px;
        z-index: 20000;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;
    
    btn.onclick = async () => {
        debugLog('音声アンロック開始', 'info');
        
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
    
    let hasAudio = false;
    subscribedTracks.forEach((obj, trackName) => {
        if (obj.audio) {
            hasAudio = true;
            obj.audio.play()
                .then(() => debugLog(`音声再開: ${trackName}`, 'success'))
                .catch(e => {
                    debugLog(`音声再開失敗: ${trackName}: ${e.message}`, 'warn');
                    if (isIOS() && !audioUnlocked) {
                        showAudioUnlockButton();
                    }
                });
        }
    });
    
    if (hasAudio && isIOS() && !audioUnlocked) {
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
            
            Object.values(data.users).forEach(user => {
                if (user.id !== myServerConnectionId && callbacks.onUserJoin) {
                    callbacks.onUserJoin(user);
                }
            });
            
            if (callbacks.onConnectedChange) callbacks.onConnectedChange(true);
            updateSpeakerList(data.speakers || []);
            
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
                }, 1000);
            }
            break;
            
        case 'userJoin':
            if (data.user.id !== myServerConnectionId && callbacks.onUserJoin) {
                callbacks.onUserJoin(data.user);
            }
            break;
            
        case 'userLeave':
            const leaveUserId = data.odUserId || data.userId;
            if (callbacks.onUserLeave) callbacks.onUserLeave(leaveUserId);
            removeRemoteAudio(leaveUserId);
            if (data.speakers) updateSpeakerList(data.speakers);
            break;
            
        case 'position':
            const posUserId = data.odUserId || data.userId;
            if (callbacks.onPosition) callbacks.onPosition(posUserId, data.x, data.y, data.z);
            break;
            
        case 'reaction':
            const reactUserId = data.odUserId || data.userId;
            if (callbacks.onReaction) callbacks.onReaction(reactUserId, data.reaction, data.color);
            break;
            
        case 'chat':
            addChatMessage(data.name, data.message);
            break;

        case 'speakRequest':
            // 主催者向け：新しい登壇リクエスト
            speakRequests.push({ id: data.userId, name: data.userName });
            if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
            break;

        case 'speakApproved':
            mySessionId = data.sessionId;
            isSpeaker = true;
            speakerCount++;
            updateSpeakerButton();
            startPublishing();
            if (callbacks.onSpeakApproved) callbacks.onSpeakApproved();
            addChatMessage('システム', '登壇が承認されました！');
            break;

        case 'speakDenied':
            addChatMessage('システム', data.reason || '登壇リクエストが却下されました');
            break;

        case 'speakerJoined':
            const joinedUserId = data.odUserId || data.userId;
            if (data.speakers) updateSpeakerList(data.speakers);
            if (callbacks.onSpeakerJoined) callbacks.onSpeakerJoined(joinedUserId);
            addChatMessage('システム', '新しい登壇者が参加しました');
            break;

        case 'speakerLeft':
            const leftUserId = data.odUserId || data.userId;
            if (data.speakers) updateSpeakerList(data.speakers);
            removeRemoteAudio(leftUserId);
            if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(leftUserId);
            break;

        case 'trackPublished':
            handleTrackPublished(data);
            break;

        case 'newTrack':
            const trackUserId = data.odUserId || data.userId;
            const newTrackName = data.trackName;
            
            if (trackUserId === myServerConnectionId) return;
            if (myPublishedTrackName && newTrackName === myPublishedTrackName) return;
            
            setTimeout(() => {
                subscribeToTrack(trackUserId, data.sessionId, newTrackName);
            }, 500);
            break;

        case 'subscribed':
            handleSubscribed(data);
            break;
            
        case 'subscribeAnswerAck':
            debugLog('Answer確認OK', 'success');
            break;

        case 'announce':
            // 全体アナウンス受信
            if (callbacks.onAnnounce) callbacks.onAnnounce(data.message);
            break;

        case 'backgroundChange':
            // 背景変更受信
            if (callbacks.onBackgroundChange) callbacks.onBackgroundChange(data.url);
            break;

        case 'kicked':
            // 強制退場された
            stopSpeaking();
            addChatMessage('システム', '主催者により登壇を終了しました');
            break;
            
        case 'error':
            debugLog(`サーバーエラー: ${data.code || data.message}`, 'error');
            break;
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
    
    isSpeaker = false;
    mySessionId = null;
    myPublishedTrackName = null;
    updateSpeakerButton();
    
    socket.send(JSON.stringify({ type: 'stopSpeak' }));
    addChatMessage('システム', '登壇を終了しました');
    
    if (callbacks.onSpeakerLeft) callbacks.onSpeakerLeft(myServerConnectionId);
}

async function startPublishing() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }, 
            video: false 
        });
        
        audioUnlocked = true;
        const unlockBtn = document.getElementById('audio-unlock-btn');
        if (unlockBtn) unlockBtn.remove();
        
        setTimeout(resumeAllAudio, 100);
        
        peerConnection = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('No audio track');
        
        const transceiver = peerConnection.addTransceiver(audioTrack, { direction: 'sendonly' });
        
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
        
        socket.send(JSON.stringify({
            type: 'publishTrack',
            sessionId: mySessionId,
            offer: { sdp: peerConnection.localDescription.sdp, type: 'offer' },
            tracks: [{ location: 'local', mid: mid, trackName: trackName }]
        }));
        
    } catch (error) {
        debugLog(`publishエラー: ${error.message}`, 'error');
        addChatMessage('システム', 'マイクにアクセスできませんでした');
        stopSpeaking();
    }
}

async function handleTrackPublished(data) {
    if (!peerConnection || !data.answer) return;
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        addChatMessage('システム', '音声配信を開始しました');
        setTimeout(resumeAllAudio, 100);
    } catch (e) {
        debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
    }
}

async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
    if (odUserId === myServerConnectionId) return;
    if (trackName === myPublishedTrackName) return;
    if (subscribedTracks.has(trackName)) return;
    if (pendingSubscriptions.has(trackName)) return;
    
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
    
    try {
        const pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        pc.ontrack = (event) => {
            const audio = new Audio();
            audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            audio.autoplay = true;
            
            audio.play().catch(() => {
                if (isIOS()) showAudioUnlockButton();
            });
            
            const trackInfo = subscribedTracks.get(trackName);
            if (trackInfo) {
                trackInfo.audio = audio;
                if (callbacks.remoteAvatars) {
                    const avatar = callbacks.remoteAvatars.get(trackInfo.odUserId);
                    if (avatar) addSpeakerIndicator(avatar);
                }
            }
        };
        
        let offerSdp = typeof data.offer === 'string' ? data.offer : data.offer.sdp;
        
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 200);
            pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(timeout); resolve(); } };
        });
        
        socket.send(JSON.stringify({
            type: 'subscribeAnswer',
            sessionId: data.sessionId,
            answer: { type: 'answer', sdp: pc.localDescription.sdp }
        }));
        
        pendingSubscriptions.delete(trackName);
        subscribedTracks.set(trackName, { odUserId: pendingInfo.odUserId, audio: null, pc: pc, sessionId: data.sessionId });
        
    } catch (e) {
        debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
        pendingSubscriptions.delete(trackName);
    }
}

function removeRemoteAudio(odUserId) {
    for (const [trackName, obj] of subscribedTracks) {
        if (obj.odUserId === odUserId) {
            if (obj.audio) { obj.audio.pause(); obj.audio.srcObject = null; }
            if (obj.pc) { try { obj.pc.close(); } catch(e) {} }
            subscribedTracks.delete(trackName);
        }
    }
    for (const [trackName, obj] of pendingSubscriptions) {
        if (obj.odUserId === odUserId) pendingSubscriptions.delete(trackName);
    }
}

function updateSpeakerList(speakers) {
    const speakersArray = Array.isArray(speakers) ? speakers : [];
    speakerCount = speakersArray.length;
    updateSpeakerButton();
    
    // 登壇者リスト更新（主催者メニュー用）
    currentSpeakers = speakersArray.map(id => {
        const avatar = callbacks.remoteAvatars?.get(id);
        return { id, name: avatar?.userData?.userName || id };
    });
    if (callbacks.onCurrentSpeakersUpdate) callbacks.onCurrentSpeakersUpdate(currentSpeakers);
    
    if (callbacks.remoteAvatars) {
        callbacks.remoteAvatars.forEach((avatar, odUserId) => {
            if (speakersArray.includes(odUserId)) {
                addSpeakerIndicator(avatar);
            } else {
                removeSpeakerIndicator(avatar);
            }
        });
    }
}

function updateSpeakerButton() {
    const btn = document.getElementById('request-stage-btn');
    if (btn) {
        if (isSpeaker) {
            btn.textContent = `🎤 登壇中 (${speakerCount}/5)`;
            btn.style.background = '#51cf66';
        } else {
            btn.textContent = `🎤 登壇リクエスト (${speakerCount}/5)`;
            btn.style.background = '';
        }
    }
}

export function toggleMic() {
    if (isSpeaker && localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            return audioTrack.enabled;
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

export function sendChat(name, message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'chat', name, message }));
    }
}

export function sendNameChange(newName) {
    currentUserName = newName;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'nameChange', name: newName }));
    }
}

export function sendBackgroundChange(url) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'backgroundChange', url }));
    }
}

export function sendAnnounce(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'announce', message }));
    }
}

export function approveSpeak(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'approveSpeak', userId }));
        // リクエストリストから削除
        speakRequests = speakRequests.filter(r => r.id !== userId);
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
    }
}

export function denySpeak(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'denySpeak', userId }));
        speakRequests = speakRequests.filter(r => r.id !== userId);
        if (callbacks.onSpeakRequestsUpdate) callbacks.onSpeakRequestsUpdate(speakRequests);
    }
}

export function kickSpeaker(userId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'kickSpeaker', userId }));
    }
}
