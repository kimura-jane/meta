import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

interface User {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  avatarUrl: string | null;
  isSpeaker: boolean;
  sessionId: string | null;
}

interface SpeakRequest {
  userId: string;
  userName: string;
  timestamp: number;
}

export default class Server implements Party.Server {
  users: Record<string, User> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();
  sessions: Map<string, string> = new Map();
  subscriberSessions: Map<string, string> = new Map();
  speakRequests: SpeakRequest[] = [];

  constructor(readonly room: Party.Room) {}

  getToken(): string {
    return (this.room.env.CLOUDFLARE_CALLS_TOKEN as string) || "";
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const name = url.searchParams.get("name") || "匿名";
    
    const user: User = {
      id: conn.id,
      name,
      x: Math.random() * 10 - 5,
      y: 0,
      z: Math.random() * 10 - 5,
      avatarUrl: null,
      isSpeaker: false,
      sessionId: null,
    };
    
    this.users[conn.id] = user;
    
    conn.send(JSON.stringify({
      type: "init",
      users: this.users,
      yourId: conn.id,
      speakers: Array.from(this.speakers),
      tracks: Array.from(this.tracks.entries()),
      sessions: Array.from(this.sessions.entries()),
      speakRequests: this.speakRequests,
    }));
    
    this.room.broadcast(JSON.stringify({
      type: "userJoin",
      odUserId: conn.id,
      userName: name,
      user,
    }), [conn.id]);
    
    console.log(`[onConnect] User ${conn.id} (${name}) joined`);
  }

  async onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case "position":
          if (this.users[sender.id]) {
            this.users[sender.id].x = data.x;
            this.users[sender.id].y = data.y ?? 0;
            this.users[sender.id].z = data.z;
            this.room.broadcast(JSON.stringify({
              type: "position",
              odUserId: sender.id,
              x: data.x,
              y: data.y ?? 0,
              z: data.z,
            }), [sender.id]);
          }
          break;
          
        case "avatarChange":
          if (this.users[sender.id]) {
            this.users[sender.id].avatarUrl = data.imageUrl;
            this.room.broadcast(JSON.stringify({
              type: "avatarChange",
              odUserId: sender.id,
              imageUrl: data.imageUrl,
            }), [sender.id]);
          }
          break;
          
        case "nameChange":
          if (this.users[sender.id]) {
            this.users[sender.id].name = data.name;
            this.room.broadcast(JSON.stringify({
              type: "nameChange",
              odUserId: sender.id,
              name: data.name,
            }), [sender.id]);
          }
          break;
          
        case "reaction":
          this.room.broadcast(JSON.stringify({
            type: "reaction",
            odUserId: sender.id,
            reaction: data.reaction,
            color: data.color,
          }));
          break;
          
        case "chat":
          this.room.broadcast(JSON.stringify({
            type: "chat",
            odUserId: sender.id,
            senderId: sender.id,
            name: this.users[sender.id]?.name || "匿名",
            message: data.message,
          }));
          break;
          
        case "requestSpeak":
          await this.handleRequestSpeak(sender);
          break;
          
        case "approveSpeak":
          await this.handleApproveSpeak(sender, data.userId);
          break;
          
        case "denySpeak":
          this.handleDenySpeak(sender, data.userId);
          break;
          
        case "kickSpeaker":
          await this.handleKickSpeaker(sender, data.userId);
          break;
          
        case "stopSpeak":
          await this.handleStopSpeak(sender);
          break;
          
        case "publishTrack":
          await this.handlePublishTrack(sender, data);
          break;
          
        case "subscribeTrack":
          await this.handleSubscribeTrack(sender, data);
          break;
          
        case "subscribeAnswer":
          await this.handleSubscribeAnswer(sender, data);
          break;
          
        case "backgroundChange":
          this.room.broadcast(JSON.stringify({
            type: "backgroundChange",
            url: data.url,
          }));
          break;
          
        case "brightnessChange":
          this.room.broadcast(JSON.stringify({
            type: "brightnessChange",
            value: data.value,
          }));
          break;
          
        case "announce":
          this.room.broadcast(JSON.stringify({
            type: "announce",
            message: data.message,
          }));
          break;
      }
    } catch (e) {
      console.error("[onMessage] Error:", e);
    }
  }

  async handleRequestSpeak(sender: Party.Connection) {
    console.log(`[handleRequestSpeak] User ${sender.id} requesting to speak`);
    
    if (this.speakers.size >= 5) {
      sender.send(JSON.stringify({ type: "speakDenied", reason: "満員です" }));
      return;
    }
    
    // 既にリクエスト済みか確認
    if (this.speakRequests.find(r => r.userId === sender.id)) {
      sender.send(JSON.stringify({ type: "speakDenied", reason: "既にリクエスト済みです" }));
      return;
    }
    
    // 既に登壇中か確認
    if (this.speakers.has(sender.id)) {
      sender.send(JSON.stringify({ type: "speakDenied", reason: "既に登壇中です" }));
      return;
    }
    
    // リクエストをリストに追加
    const request: SpeakRequest = {
      userId: sender.id,
      userName: this.users[sender.id]?.name || "匿名",
      timestamp: Date.now(),
    };
    this.speakRequests.push(request);
    
    // 全員にリクエストを通知
    this.room.broadcast(JSON.stringify({
      type: "speakRequest",
      userId: sender.id,
      userName: request.userName,
    }));
    
    // リクエストリストの更新も送信
    this.room.broadcast(JSON.stringify({
      type: "speakRequestsUpdate",
      requests: this.speakRequests,
    }));
    
    console.log(`[handleRequestSpeak] Request added, total requests: ${this.speakRequests.length}`);
  }

  async handleApproveSpeak(sender: Party.Connection, targetUserId: string) {
    console.log(`[handleApproveSpeak] Approving user ${targetUserId}`);
    
    // リクエストリストから削除
    this.speakRequests = this.speakRequests.filter(r => r.userId !== targetUserId);
    
    // 対象ユーザーの接続を取得
    const targetConn = this.room.getConnection(targetUserId);
    if (!targetConn) {
      console.log(`[handleApproveSpeak] Target user ${targetUserId} not found`);
      return;
    }
    
    if (this.speakers.size >= 5) {
      targetConn.send(JSON.stringify({ type: "speakDenied", reason: "満員です" }));
      return;
    }
    
    const result = await this.createSession();
    
    if (result.success && result.sessionId) {
      this.speakers.add(targetUserId);
      if (this.users[targetUserId]) {
        this.users[targetUserId].isSpeaker = true;
        this.users[targetUserId].sessionId = result.sessionId;
      }
      this.sessions.set(targetUserId, result.sessionId);
      
      targetConn.send(JSON.stringify({
        type: "speakApproved",
        sessionId: result.sessionId,
      }));
      
      this.room.broadcast(JSON.stringify({
        type: "speakerJoined",
        odUserId: targetUserId,
        userName: this.users[targetUserId]?.name || "匿名",
        sessionId: result.sessionId,
        speakers: Array.from(this.speakers),
      }), [targetUserId]);
      
      // リクエストリストの更新を送信
      this.room.broadcast(JSON.stringify({
        type: "speakRequestsUpdate",
        requests: this.speakRequests,
      }));
      
      console.log(`[handleApproveSpeak] User ${targetUserId} approved, sessionId: ${result.sessionId}, speakers: ${this.speakers.size}`);
    } else {
      targetConn.send(JSON.stringify({
        type: "speakDenied",
        reason: result.error || "セッション作成失敗",
      }));
      console.log(`[handleApproveSpeak] User ${targetUserId} denied: ${result.error}`);
    }
  }

  handleDenySpeak(sender: Party.Connection, targetUserId: string) {
    console.log(`[handleDenySpeak] Denying user ${targetUserId}`);
    
    // リクエストリストから削除
    this.speakRequests = this.speakRequests.filter(r => r.userId !== targetUserId);
    
    // 対象ユーザーに通知
    const targetConn = this.room.getConnection(targetUserId);
    if (targetConn) {
      targetConn.send(JSON.stringify({
        type: "speakDenied",
        reason: "リクエストが却下されました",
      }));
    }
    
    // リクエストリストの更新を送信
    this.room.broadcast(JSON.stringify({
      type: "speakRequestsUpdate",
      requests: this.speakRequests,
    }));
    
    console.log(`[handleDenySpeak] User ${targetUserId} denied, remaining requests: ${this.speakRequests.length}`);
  }

  async handleKickSpeaker(sender: Party.Connection, targetUserId: string) {
    console.log(`[handleKickSpeaker] Kicking user ${targetUserId}`);
    
    if (!this.speakers.has(targetUserId)) {
      console.log(`[handleKickSpeaker] User ${targetUserId} is not a speaker`);
      return;
    }
    
    // 登壇者リストから削除
    this.speakers.delete(targetUserId);
    this.tracks.delete(targetUserId);
    this.sessions.delete(targetUserId);
    
    if (this.users[targetUserId]) {
      this.users[targetUserId].isSpeaker = false;
      this.users[targetUserId].sessionId = null;
    }
    
    // 対象ユーザーに通知
    const targetConn = this.room.getConnection(targetUserId);
    if (targetConn) {
      targetConn.send(JSON.stringify({
        type: "kicked",
      }));
    }
    
    // 全員に通知
    this.room.broadcast(JSON.stringify({
      type: "speakerLeft",
      odUserId: targetUserId,
      speakers: Array.from(this.speakers),
    }));
    
    console.log(`[handleKickSpeaker] User ${targetUserId} kicked, remaining speakers: ${this.speakers.size}`);
  }

  async handleStopSpeak(sender: Party.Connection) {
    console.log(`[handleStopSpeak] User ${sender.id} stopping`);
    
    this.speakers.delete(sender.id);
    this.tracks.delete(sender.id);
    this.sessions.delete(sender.id);
    
    if (this.users[sender.id]) {
      this.users[sender.id].isSpeaker = false;
      this.users[sender.id].sessionId = null;
    }
    
    this.room.broadcast(JSON.stringify({
      type: "speakerLeft",
      odUserId: sender.id,
      speakers: Array.from(this.speakers),
    }));
  }

  async handlePublishTrack(sender: Party.Connection, data: any) {
    console.log(`[handlePublishTrack] User ${sender.id}`);
    
    const token = this.getToken();
    if (!token) {
      sender.send(JSON.stringify({ type: "error", code: "SRV_ERR_TOKEN_NOT_SET" }));
      return;
    }
    
    const sessionId = data.sessionId;
    if (!sessionId) {
      sender.send(JSON.stringify({ type: "error", code: "SRV_ERR_NO_SESSION_ID" }));
      return;
    }
    
    const offer = data.offer;
    if (!offer || !offer.sdp) {
      sender.send(JSON.stringify({ type: "error", code: "SRV_ERR_NO_OFFER" }));
      return;
    }
    
    const tracks = data.tracks;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      sender.send(JSON.stringify({ type: "error", code: "SRV_ERR_NO_TRACKS" }));
      return;
    }
    
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!track.mid) {
        sender.send(JSON.stringify({ type: "error", code: `SRV_ERR_TRACK_${i}_NO_MID` }));
        return;
      }
      if (!track.trackName) {
        sender.send(JSON.stringify({ type: "error", code: `SRV_ERR_TRACK_${i}_NO_NAME` }));
        return;
      }
    }
    
    const result = await this.publishTrack(sessionId, offer, tracks);
    
    if (result.success && result.answer) {
      const trackName = tracks[0].trackName || `audio-${sender.id}`;
      this.tracks.set(sender.id, trackName);
      
      sender.send(JSON.stringify({
        type: "trackPublished",
        answer: result.answer,
      }));
      
      this.room.broadcast(JSON.stringify({
        type: "newTrack",
        odUserId: sender.id,
        trackName,
        sessionId,
      }), [sender.id]);
      
      console.log(`[handlePublishTrack] Success, trackName: ${trackName}`);
    } else {
      sender.send(JSON.stringify({
        type: "error",
        code: result.error || "SRV_ERR_PUBLISH_FAILED",
      }));
      console.log(`[handlePublishTrack] Failed: ${result.error}`);
    }
  }

  async handleSubscribeTrack(sender: Party.Connection, data: any) {
    const { remoteSessionId, trackName } = data;
    console.log(`[handleSubscribeTrack] User ${sender.id} subscribing to ${trackName}, remoteSessionId: ${remoteSessionId}`);
    
    const subscriptionKey = `${sender.id}-${trackName}`;
    
    const result = await this.createSession();
    if (!result.success || !result.sessionId) {
      sender.send(JSON.stringify({
        type: "error",
        code: "SRV_ERR_SESSION_CREATE_FAILED",
      }));
      return;
    }
    
    const subscriberSessionId = result.sessionId;
    this.subscriberSessions.set(subscriptionKey, subscriberSessionId);
    console.log(`[handleSubscribeTrack] Created NEW subscriber session for ${trackName}: ${subscriberSessionId}`);
    
    const subscribeResult = await this.subscribeTrack(subscriberSessionId, remoteSessionId, trackName);
    
    console.log(`[handleSubscribeTrack] subscribeTrack result - success: ${subscribeResult.success}, hasOffer: ${!!subscribeResult.offer}`);
    
    if (subscribeResult.success) {
      if (subscribeResult.offer) {
        sender.send(JSON.stringify({
          type: "subscribed",
          offer: subscribeResult.offer,
          sessionId: subscriberSessionId,
          trackName,
          tracks: subscribeResult.tracks,
        }));
        console.log(`[handleSubscribeTrack] Success with offer`);
      } else {
        sender.send(JSON.stringify({
          type: "error",
          code: "SRV_ERR_NO_OFFER_IN_RESPONSE",
        }));
        console.log(`[handleSubscribeTrack] No offer in response`);
      }
    } else {
      sender.send(JSON.stringify({
        type: "error",
        code: subscribeResult.error || "SRV_ERR_SUBSCRIBE_FAILED",
      }));
      console.log(`[handleSubscribeTrack] Failed: ${subscribeResult.error}`);
    }
  }

  async handleSubscribeAnswer(sender: Party.Connection, data: any) {
    const { sessionId, answer } = data;
    console.log(`[handleSubscribeAnswer] User ${sender.id}, sessionId: ${sessionId}`);
    
    if (!answer || !answer.sdp) {
      sender.send(JSON.stringify({
        type: "error",
        code: "SRV_ERR_NO_ANSWER_SDP",
      }));
      return;
    }
    
    const result = await this.sendAnswer(sessionId, answer);
    
    if (result.success) {
      sender.send(JSON.stringify({
        type: "subscribeAnswerAck",
        sessionId,
      }));
      console.log(`[handleSubscribeAnswer] Success`);
    } else {
      sender.send(JSON.stringify({
        type: "error",
        code: result.error || "SRV_ERR_RENEGOTIATE_FAILED",
      }));
      console.log(`[handleSubscribeAnswer] Failed: ${result.error}`);
    }
  }

  onClose(conn: Party.Connection) {
    const user = this.users[conn.id];
    if (user) {
      console.log(`[onClose] User ${conn.id} (${user.name}) left`);
      
      this.speakers.delete(conn.id);
      this.tracks.delete(conn.id);
      this.sessions.delete(conn.id);
      
      // リクエストリストからも削除
      this.speakRequests = this.speakRequests.filter(r => r.userId !== conn.id);
      
      for (const [key, _] of this.subscriberSessions) {
        if (key.startsWith(`${conn.id}-`)) {
          this.subscriberSessions.delete(key);
        }
      }
      
      delete this.users[conn.id];
      
      this.room.broadcast(JSON.stringify({
        type: "userLeave",
        odUserId: conn.id,
        speakers: Array.from(this.speakers),
      }));
      
      // リクエストリストの更新も送信
      this.room.broadcast(JSON.stringify({
        type: "speakRequestsUpdate",
        requests: this.speakRequests,
      }));
    }
  }

  async createSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };
    }
    
    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`;
      console.log(`[createSession] POST ${url}`);
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });
      
      const responseText = await res.text();
      console.log(`[createSession] Response: ${res.status} ${responseText.substring(0, 200)}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}` };
      }
      
      const json = JSON.parse(responseText);
      
      if (!json.sessionId) {
        return { success: false, error: "SRV_ERR_NO_SESSION_ID_IN_RESPONSE" };
      }
      
      return { success: true, sessionId: json.sessionId };
    } catch (e) {
      console.error("[createSession] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async publishTrack(
    sessionId: string,
    offer: { type: string; sdp: string },
    tracks: any[]
  ): Promise<{ success: boolean; answer?: any; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };
    }
    
    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      const body = {
        sessionDescription: {
          type: "offer",
          sdp: offer.sdp,
        },
        tracks,
      };
      
      console.log(`[publishTrack] POST ${url}`);
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      
      const responseText = await res.text();
      console.log(`[publishTrack] Response: ${res.status} ${responseText.substring(0, 500)}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}` };
      }
      
      const json = JSON.parse(responseText);
      
      if (!json.sessionDescription) {
        return { success: false, error: "SRV_ERR_NO_ANSWER" };
      }
      
      return { success: true, answer: json.sessionDescription };
    } catch (e) {
      console.error("[publishTrack] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async subscribeTrack(
    subscriberSessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ 
    success: boolean; 
    offer?: any; 
    tracks?: any[]; 
    error?: string 
  }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };
    }
    
    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${subscriberSessionId}/tracks/new`;
      const body = {
        tracks: [
          {
            location: "remote",
            sessionId: remoteSessionId,
            trackName: trackName,
          },
        ],
      };
      
      console.log(`[subscribeTrack] POST ${url}`);
      console.log(`[subscribeTrack] Body: ${JSON.stringify(body)}`);
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      
      const responseText = await res.text();
      console.log(`[subscribeTrack] FULL Response: ${responseText}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}` };
      }
      
      const json = JSON.parse(responseText);
      
      const offer = json.sessionDescription;
      
      console.log(`[subscribeTrack] Parsed - hasSessionDescription: ${!!json.sessionDescription}, type: ${json.sessionDescription?.type}`);
      
      return { 
        success: true, 
        offer: offer,
        tracks: json.tracks,
      };
    } catch (e) {
      console.error("[subscribeTrack] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async sendAnswer(
    sessionId: string,
    answer: { type: string; sdp: string }
  ): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };
    }
    
    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`;
      const body = {
        sessionDescription: {
          type: "answer",
          sdp: answer.sdp,
        },
      };
      
      console.log(`[sendAnswer] PUT ${url}`);
      console.log(`[sendAnswer] SDP length: ${answer.sdp?.length || 0}`);
      
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      
      const responseText = await res.text();
      console.log(`[sendAnswer] Response: ${res.status} ${responseText}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}` };
      }
      
      return { success: true };
    } catch (e) {
      console.error("[sendAnswer] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }
}
