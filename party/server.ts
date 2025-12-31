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
    const userId = connection.id;
    
    this.users[userId] = {
      id: userId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3,
      isSpeaker: false,
      sessionId: null
    };

    connection.send(JSON.stringify({
      type: 'init',
      users: this.users,
      yourId: userId,
      speakers: Array.from(this.speakers),
      tracks: Object.fromEntries(this.tracks)
    }));

    this.room.broadcast(JSON.stringify({
      type: 'userJoin',
      user: this.users[userId]
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
    if (this.speakers.size >= 5) {
      sender.send(JSON.stringify({
        type: 'speakDenied',
        reason: '登壇者は最大5人までです'
      }));
      return;
    }

    const session = await this.createSession();
    
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
    const result = await this.publishTrack(
      data.sessionId,
      data.offer,
      data.trackName
    );

    if (result.success) {
      this.tracks.set(sender.id, data.trackName);
      
      sender.send(JSON.stringify({
        type: 'trackPublished',
        answer: result.answer,
        trackName: data.trackName
      }));

      this.room.broadcast(JSON.stringify({
        type: 'newTrack',
        userId: sender.id,
        trackName: data.trackName,
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
    let subscriberSessionId = this.sessions.get(sender.id);
    
    if (!subscriberSessionId) {
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
    const sessionId = this.sessions.get(sender.id) || data.sessionId;
    if (sessionId) {
      await this.sendAnswer(sessionId, data.answer);
    }
  }

  async onClose(connection: Party.Connection) {
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
    
    if (!token) {
      return { success: false, error: 'TOKEN_NOT_SET' };
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const responseText = await res.text();
      
      if (!res.ok) {
        return { success: false, error: `HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);
      
      if (!json.sessionId) {
        return { success: false, error: `NO_SESSION_ID: ${responseText}` };
      }
      
      return { success: true, sessionId: json.sessionId };
    } catch (e: any) {
      return { success: false, error: `EXCEPTION: ${e.message}` };
    }
  }

  private async publishTrack(
    sessionId: string,
    offer: any,
    trackName: string
  ): Promise<{ success: boolean; answer?: any; error?: string }> {
    const token = this.getToken();

    if (!token) {
      return { success: false, error: 'TOKEN_NOT_SET' };
    }

    if (!sessionId) {
      return { success: false, error: 'NO_SESSION_ID' };
    }

    if (!offer) {
      return { success: false, error: 'NO_OFFER' };
    }

    if (!trackName) {
      return { success: false, error: 'NO_TRACK_NAME' };
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;

      const body = {
        sessionDescription: offer,
        tracks: [{
          location: 'local',
          trackName: trackName
        }]
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const responseText = await res.text();

      if (!res.ok) {
        return { success: false, error: `HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);

      if (!json.sessionDescription) {
        return { success: false, error: `NO_ANSWER: ${responseText}` };
      }

      return { success: true, answer: json.sessionDescription };
    } catch (e: any) {
      return { success: false, error: `EXCEPTION: ${e.message}` };
    }
  }

  private async subscribeTrack(
    sessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ success: boolean; offer?: any; error?: string }> {
    const token = this.getToken();

    if (!token) {
      return { success: false, error: 'TOKEN_NOT_SET' };
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;

      const body = {
        tracks: [{
          location: 'remote',
          trackName: trackName,
          sessionId: remoteSessionId
        }]
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const responseText = await res.text();

      if (!res.ok) {
        return { success: false, error: `HTTP_${res.status}: ${responseText}` };
      }

      const json = JSON.parse(responseText);
      return { success: true, offer: json.sessionDescription };
    } catch (e: any) {
      return { success: false, error: `EXCEPTION: ${e.message}` };
    }
  }

  private async sendAnswer(sessionId: string, answer: any): Promise<void> {
    const token = this.getToken();

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`;
      
      await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionDescription: answer
        })
      });
    } catch (e) {
      console.error('sendAnswer error:', e);
    }
  }
}
