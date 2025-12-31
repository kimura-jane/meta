import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  users: Record<string, any> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();
  sessions: Map<string, string> = new Map();

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const odUserId = connection.id;
    
    this.users[odUserId] = {
      id: odUserId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3,
      isSpeaker: false,
      sessionId: null
    };

    connection.send(JSON.stringify({
      type: 'init',
      users: this.users,
      yourId: odUserId,
      speakers: Array.from(this.speakers),
      tracks: Object.fromEntries(this.tracks)
    }));

    this.room.broadcast(JSON.stringify({
      type: 'userJoin',
      user: this.users[odUserId]
    }), [connection.id]);
  }

  async onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'position':
        if (this.users[sender.id]) {
          this.users[sender.id].x = data.x;
          this.users[sender.id].y = data.y;
          this.users[sender.id].z = data.z;
        }
        this.room.broadcast(JSON.stringify({
          type: 'position',
          userId: sender.id,
          x: data.x,
          y: data.y,
          z: data.z
        }), [sender.id]);
        break;

      case 'reaction':
        this.room.broadcast(JSON.stringify({
          type: 'reaction',
          userId: sender.id,
          reaction: data.reaction,
          color: data.color
        }), [sender.id]);
        break;

      case 'chat':
        this.room.broadcast(JSON.stringify({
          type: 'chat',
          userId: sender.id,
          name: data.name,
          message: data.message
        }));
        break;

      case 'requestSpeak':
        await this.handleRequestSpeak(sender);
        break;

      case 'stopSpeak':
        this.handleStopSpeak(sender);
        break;

      case 'publishTrack':
        await this.handlePublishTrack(sender, data);
        break;

      case 'subscribeTrack':
        await this.handleSubscribeTrack(sender, data);
        break;

      case 'subscribeAnswer':
        await this.handleSubscribeAnswer(sender, data);
        break;
    }
  }

  async handleRequestSpeak(sender: Party.Connection) {
    console.log(`[handleRequestSpeak] userId=${sender.id}`);
    
    if (this.speakers.size >= 5) {
      sender.send(JSON.stringify({
        type: 'speakDenied',
        reason: '登壇者は最大5人までです'
      }));
      return;
    }

    const session = await this.createSession();
    console.log(`[handleRequestSpeak] createSession result:`, JSON.stringify(session));
    
    if (!session.success) {
      sender.send(JSON.stringify({
        type: 'error',
        message: `セッション作成失敗: ${session.error}`
      }));
      return;
    }

    this.speakers.add(sender.id);
    this.users[sender.id].isSpeaker = true;
    this.users[sender.id].sessionId = session.sessionId;
    this.sessions.set(sender.id, session.sessionId!);

    console.log(`[handleRequestSpeak] 登壇承認: sessionId=${session.sessionId}`);
    
    sender.send(JSON.stringify({
      type: 'speakApproved',
      sessionId: session.sessionId
    }));

    this.room.broadcast(JSON.stringify({
      type: 'speakerJoined',
      userId: sender.id,
      speakers: Array.from(this.speakers)
    }));
  }

  handleStopSpeak(sender: Party.Connection) {
    console.log(`[handleStopSpeak] userId=${sender.id}`);
    
    this.speakers.delete(sender.id);
    this.tracks.delete(sender.id);
    this.sessions.delete(sender.id);
    
    if (this.users[sender.id]) {
      this.users[sender.id].isSpeaker = false;
      this.users[sender.id].sessionId = null;
    }

    this.room.broadcast(JSON.stringify({
      type: 'speakerLeft',
      userId: sender.id,
      speakers: Array.from(this.speakers)
    }));
  }

  async handlePublishTrack(sender: Party.Connection, data: any) {
    console.log(`[handlePublishTrack] 開始`);
    console.log(`[handlePublishTrack] sessionId=${data.sessionId}`);
    console.log(`[handlePublishTrack] offer存在=${!!data.offer}`);
    console.log(`[handlePublishTrack] tracks存在=${!!data.tracks}, 長さ=${data.tracks?.length || 0}`);
    
    if (data.tracks && data.tracks.length > 0) {
      console.log(`[handlePublishTrack] tracks[0]:`, JSON.stringify(data.tracks[0]));
    }
    
    const result = await this.publishTrack(
      data.sessionId,
      data.offer,
      data.tracks
    );

    console.log(`[handlePublishTrack] 結果:`, JSON.stringify(result));

    if (result.success) {
      const trackName = data.tracks?.[0]?.trackName || `audio-${sender.id}`;
      this.tracks.set(sender.id, trackName);
      
      sender.send(JSON.stringify({
        type: 'trackPublished',
        answer: result.answer,
        trackName: trackName
      }));

      this.room.broadcast(JSON.stringify({
        type: 'newTrack',
        userId: sender.id,
        trackName: trackName,
        sessionId: data.sessionId
      }), [sender.id]);
    } else {
      sender.send(JSON.stringify({
        type: 'error',
        message: `トラック公開失敗: ${result.error}`
      }));
    }
  }

  async handleSubscribeTrack(sender: Party.Connection, data: any) {
    console.log(`[handleSubscribeTrack] 開始`);
    
    let subscriberSessionId = this.sessions.get(sender.id);
    
    if (!subscriberSessionId) {
      console.log(`[handleSubscribeTrack] セッション未存在、新規作成`);
      const session = await this.createSession();
      if (session.success) {
        subscriberSessionId = session.sessionId!;
        this.sessions.set(sender.id, subscriberSessionId);
      } else {
        sender.send(JSON.stringify({
          type: 'error',
          message: `購読セッション作成失敗: ${session.error}`
        }));
        return;
      }
    }

    const result = await this.subscribeTrack(
      subscriberSessionId,
      data.remoteSessionId,
      data.trackName
    );

    console.log(`[handleSubscribeTrack] 結果:`, JSON.stringify(result));

    if (result.success) {
      sender.send(JSON.stringify({
        type: 'subscribed',
        offer: result.offer,
        trackName: data.trackName,
        sessionId: subscriberSessionId
      }));
    } else {
      sender.send(JSON.stringify({
        type: 'error',
        message: `トラック購読失敗: ${result.error}`
      }));
    }
  }

  async handleSubscribeAnswer(sender: Party.Connection, data: any) {
    console.log(`[handleSubscribeAnswer] 開始`);
    const sessionId = this.sessions.get(sender.id) || data.sessionId;
    if (sessionId) {
      await this.sendAnswer(sessionId, data.answer);
    }
  }

  async onClose(connection: Party.Connection) {
    console.log(`[onClose] userId=${connection.id}`);
    
    this.speakers.delete(connection.id);
    this.tracks.delete(connection.id);
    this.sessions.delete(connection.id);
    delete this.users[connection.id];

    this.room.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: connection.id,
      speakers: Array.from(this.speakers)
    }));
  }

  private getToken(): string {
    const env = (this.room as any).env;
    return env?.CLOUDFLARE_CALLS_TOKEN || "";
  }

  private async createSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const token = this.getToken();
    console.log(`[createSession] token存在=${!!token}, token長=${token?.length || 0}`);
    
    if (!token) {
      return { success: false, error: 'SRV_ERR_TOKEN_NOT_SET' };
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`;
      console.log(`[createSession] URL=${url}`);
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const responseText = await res.text();
      console.log(`[createSession] status=${res.status}, response=${responseText}`);
      
      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);
      
      if (!json.sessionId) {
        return { success: false, error: `SRV_ERR_NO_SESSION_ID: ${responseText}` };
      }
      
      console.log(`[createSession] 成功: sessionId=${json.sessionId}`);
      return { success: true, sessionId: json.sessionId };
    } catch (e: any) {
      console.error(`[createSession] 例外:`, e);
      return { success: false, error: `SRV_ERR_EXCEPTION: ${e.message}` };
    }
  }

  private async publishTrack(
    sessionId: string,
    offer: any,
    tracks: any[]
  ): Promise<{ success: boolean; answer?: any; error?: string }> {
    const token = this.getToken();
    console.log(`[publishTrack] 開始`);
    console.log(`[publishTrack] token存在=${!!token}`);
    console.log(`[publishTrack] sessionId=${sessionId}`);
    console.log(`[publishTrack] offer存在=${!!offer}, offer.sdp長=${offer?.sdp?.length || 0}`);
    console.log(`[publishTrack] tracks存在=${!!tracks}, tracks長=${tracks?.length || 0}`);

    if (!token) {
      return { success: false, error: 'SRV_ERR_TOKEN_NOT_SET' };
    }

    if (!sessionId) {
      return { success: false, error: 'SRV_ERR_NO_SESSION_ID' };
    }

    if (!offer) {
      return { success: false, error: 'SRV_ERR_NO_OFFER' };
    }

    if (!offer.sdp) {
      return { success: false, error: 'SRV_ERR_NO_OFFER_SDP' };
    }

    if (!tracks || tracks.length === 0) {
      return { success: false, error: 'SRV_ERR_NO_TRACKS' };
    }

    // tracks の各要素を検証
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      console.log(`[publishTrack] tracks[${i}]:`, JSON.stringify(track));
      
      if (!track.mid) {
        return { success: false, error: `SRV_ERR_TRACK_${i}_NO_MID` };
      }
      if (!track.trackName) {
        return { success: false, error: `SRV_ERR_TRACK_${i}_NO_TRACKNAME` };
      }
      if (!track.location) {
        return { success: false, error: `SRV_ERR_TRACK_${i}_NO_LOCATION` };
      }
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      console.log(`[publishTrack] URL=${url}`);

      const body = {
        sessionDescription: {
          type: offer.type || 'offer',
          sdp: offer.sdp
        },
        tracks: tracks
      };

      console.log(`[publishTrack] リクエストbody:`, JSON.stringify(body).substring(0, 500));

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const responseText = await res.text();
      console.log(`[publishTrack] status=${res.status}`);
      console.log(`[publishTrack] response=${responseText.substring(0, 500)}`);

      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);

      if (!json.sessionDescription) {
        return { success: false, error: `SRV_ERR_NO_ANSWER: ${responseText}` };
      }

      console.log(`[publishTrack] 成功！answer.sdp長=${json.sessionDescription.sdp?.length || 0}`);
      return { success: true, answer: json.sessionDescription };
    } catch (e: any) {
      console.error(`[publishTrack] 例外:`, e);
      return { success: false, error: `SRV_ERR_EXCEPTION: ${e.message}` };
    }
  }

  private async subscribeTrack(
    sessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ success: boolean; offer?: any; error?: string }> {
    const token = this.getToken();
    console.log(`[subscribeTrack] 開始`);
    console.log(`[subscribeTrack] sessionId=${sessionId}, remoteSessionId=${remoteSessionId}, trackName=${trackName}`);

    if (!token) {
      return { success: false, error: 'SRV_ERR_TOKEN_NOT_SET' };
    }

    if (!sessionId) {
      return { success: false, error: 'SRV_ERR_NO_SESSION_ID' };
    }

    if (!remoteSessionId) {
      return { success: false, error: 'SRV_ERR_NO_REMOTE_SESSION_ID' };
    }

    if (!trackName) {
      return { success: false, error: 'SRV_ERR_NO_TRACK_NAME' };
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      console.log(`[subscribeTrack] URL=${url}`);

      const body = {
        tracks: [{
          location: 'remote',
          trackName: trackName,
          sessionId: remoteSessionId
        }]
      };

      console.log(`[subscribeTrack] body:`, JSON.stringify(body));

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const responseText = await res.text();
      console.log(`[subscribeTrack] status=${res.status}, response=${responseText.substring(0, 300)}`);

      if (!res.ok) {
        return { success: false, error: `SRV_ERR_HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);
      console.log(`[subscribeTrack] 成功！`);
      return { success: true, offer: json.sessionDescription };
    } catch (e: any) {
      console.error(`[subscribeTrack] 例外:`, e);
      return { success: false, error: `SRV_ERR_EXCEPTION: ${e.message}` };
    }
  }

  private async sendAnswer(sessionId: string, answer: any): Promise<void> {
    const token = this.getToken();
    console.log(`[sendAnswer] sessionId=${sessionId}`);

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`;
      
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionDescription: answer
        })
      });
      
      const responseText = await res.text();
      console.log(`[sendAnswer] status=${res.status}, response=${responseText.substring(0, 200)}`);
    } catch (e) {
      console.error('[sendAnswer] 例外:', e);
    }
  }
}
