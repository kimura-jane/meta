import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

interface User {
  id: string;
  name: string;
  x: number;
  z: number;
  isSpeaker: boolean;
  sessionId: string | null;
}

export default class Server implements Party.Server {
  users: Record<string, User> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map(); // odUserId -> trackName
  sessions: Map<string, string> = new Map(); // odUserId -> sessionId

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
      z: Math.random() * 10 - 5,
      isSpeaker: false,
      sessionId: null,
    };
    
    this.users[conn.id] = user;
    
    // 初期データを送信（sessionsも含む）
    conn.send(JSON.stringify({
      type: "init",
      users: this.users,
      yourId: conn.id,
      speakers: Array.from(this.speakers),
      tracks: Array.from(this.tracks.entries()),
      sessions: Array.from(this.sessions.entries()),
    }));
    
    // 他のユーザーに通知
    this.room.broadcast(JSON.stringify({
      type: "userJoin",
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
            this.users[sender.id].z = data.z;
            this.room.broadcast(JSON.stringify({
              type: "position",
              odUserId: sender.id,
              x: data.x,
              z: data.z,
            }), [sender.id]);
          }
          break;
          
        case "reaction":
          this.room.broadcast(JSON.stringify({
            type: "reaction",
            odUserId: sender.id,
            reaction: data.reaction,
          }));
          break;
          
        case "chat":
          this.room.broadcast(JSON.stringify({
            type: "chat",
            odUserId: sender.id,
            name: this.users[sender.id]?.name || "匿名",
            message: data.message,
          }));
          break;
          
        case "requestSpeak":
          await this.handleRequestSpeak(sender);
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
    
    const result = await this.createSession();
    
    if (result.success && result.sessionId) {
      this.speakers.add(sender.id);
      this.users[sender.id].isSpeaker = true;
      this.users[sender.id].sessionId = result.sessionId;
      this.sessions.set(sender.id, result.sessionId);
      
      sender.send(JSON.stringify({
        type: "speakApproved",
        sessionId: result.sessionId,
      }));
      
      this.room.broadcast(JSON.stringify({
        type: "speakerJoined",
        odUserId: sender.id,
        sessionId: result.sessionId,
      }), [sender.id]);
      
      console.log(`[handleRequestSpeak] User ${sender.id} approved, sessionId: ${result.sessionId}`);
    } else {
      sender.send(JSON.stringify({
        type: "speakDenied",
        reason: result.error || "セッション作成失敗",
      }));
      console.log(`[handleRequestSpeak] User ${sender.id} denied: ${result.error}`);
    }
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
    
    // tracksの検証
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
      
      // 他のユーザーに新しいトラックを通知
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
    console.log(`[handleSubscribeTrack] User ${sender.id} subscribing to ${trackName}`);
    
    // 購読者用のセッションを取得または作成
    let subscriberSessionId = this.sessions.get(sender.id);
    
    if (!subscriberSessionId) {
      const result = await this.createSession();
      if (result.success && result.sessionId) {
        subscriberSessionId = result.sessionId;
        this.sessions.set(sender.id, subscriberSessionId);
        console.log(`[handleSubscribeTrack] Created session for subscriber: ${subscriberSessionId}`);
      } else {
        sender.send(JSON.stringify({
          type: "error",
          code: "SRV_ERR_SESSION_CREATE_FAILED",
        }));
        return;
      }
    }
    
    const result = await this.subscribeTrack(subscriberSessionId, remoteSessionId, trackName);
    
    if (result.success && result.offer) {
      sender.send(JSON.stringify({
        type: "subscribed",
        offer: result.offer,
        sessionId: subscriberSessionId,
        trackName,
        tracks: result.tracks,
      }));
      console.log(`[handleSubscribeTrack] Success, sent offer to ${sender.id}`);
    } else {
      sender.send(JSON.stringify({
        type: "error",
        code: result.error || "SRV_ERR_SUBSCRIBE_FAILED",
      }));
      console.log(`[handleSubscribeTrack] Failed: ${result.error}`);
    }
  }

  async handleSubscribeAnswer(sender: Party.Connection, data: any) {
    const { sessionId, answer } = data;
    console.log(`[handleSubscribeAnswer] User ${sender.id}, sessionId: ${sessionId}`);
    
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
      
      delete this.users[conn.id];
      
      this.room.broadcast(JSON.stringify({
        type: "userLeave",
        odUserId: conn.id,
      }));
    }
  }

  // Cloudflare API methods
  
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
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
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
          type: offer.type,
          sdp: offer.sdp,
        },
        tracks,
      };
      
      console.log(`[publishTrack] POST ${url}`);
      console.log(`[publishTrack] Body: ${JSON.stringify(body).substring(0, 500)}`);
      
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
  ): Promise<{ success: boolean; offer?: any; tracks?: any[]; error?: string }> {
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
      console.log(`[subscribeTrack] Response: ${res.status} ${responseText.substring(0, 500)}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}` };
      }
      
      const json = JSON.parse(responseText);
      
      if (!json.sessionDescription) {
        return { success: false, error: "SRV_ERR_NO_OFFER" };
      }
      
      return { 
        success: true, 
        offer: json.sessionDescription,
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
          type: answer.type,
          sdp: answer.sdp,
        },
      };
      
      console.log(`[sendAnswer] PUT ${url}`);
      console.log(`[sendAnswer] Body: ${JSON.stringify(body).substring(0, 300)}`);
      
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      
      const responseText = await res.text();
      console.log(`[sendAnswer] Response: ${res.status} ${responseText.substring(0, 300)}`);
      
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
