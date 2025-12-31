import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  users: Record<string, any> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();
  sessions: Map<string, string> = new Map(); // odUserId -> sessionId

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
          odUserId: sender.id,
          x: data.x,
          y: data.y,
          z: data.z
        }), [sender.id]);
        break;

      case 'reaction':
        this.room.broadcast(JSON.stringify({
          type: 'reaction',
          odUserId: sender.id,
          reaction: data.reaction,
          color: data.color
        }), [sender.id]);
        break;

      case 'chat':
        this.room.broadcast(JSON.stringify({
          type: 'chat',
          odUserId: sender.id,
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

    // Cloudflare APIでセッション作成
    const session = await this.createSession();
    
    if (!session) {
      sender.send(JSON.stringify({
        type: 'error',
        message: 'セッション作成に失敗しました'
      }));
      return;
    }

    this.speakers.add(sender.id);
    this.users[sender.id].isSpeaker = true;
    this.users[sender.id].sessionId = session.sessionId;
    this.sessions.set(sender.id, session.sessionId);

    sender.send(JSON.stringify({
      type: 'speakApproved',
      sessionId: session.sessionId
    }));

    this.room.broadcast(JSON.stringify({
      type: 'speakerJoined',
      odUserId: sender.id,
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
      odUserId: sender.id,
      speakers: Array.from(this.speakers)
    }));
  }

  async handlePublishTrack(sender: Party.Connection, data: any) {
    const result = await this.publishTrack(
      data.sessionId,
      data.offer,
      data.trackName
    );

    if (result) {
      this.tracks.set(sender.id, data.trackName);
      
      sender.send(JSON.stringify({
        type: 'trackPublished',
        answer: result.answer,
        trackName: data.trackName
      }));

      // 他のユーザーに新トラックを通知
      this.room.broadcast(JSON.stringify({
        type: 'newTrack',
        odUserId: sender.id,
        trackName: data.trackName,
        sessionId: data.sessionId
      }), [sender.id]);
    } else {
      sender.send(JSON.stringify({
        type: 'error',
        message: 'トラック公開に失敗しました'
      }));
    }
  }

  async handleSubscribeTrack(sender: Party.Connection, data: any) {
    // 購読者用のセッションを取得または作成
    let subscriberSessionId = this.sessions.get(sender.id);
    
    if (!subscriberSessionId) {
      const session = await this.createSession();
      if (session) {
        subscriberSessionId = session.sessionId;
        this.sessions.set(sender.id, subscriberSessionId);
      } else {
        sender.send(JSON.stringify({
          type: 'error',
          message: '購読用セッション作成に失敗'
        }));
        return;
      }
    }

    const result = await this.subscribeTrack(
      subscriberSessionId,
      data.remoteSessionId,
      data.trackName
    );

    if (result) {
      sender.send(JSON.stringify({
        type: 'subscribed',
        offer: result.offer,
        trackName: data.trackName,
        sessionId: subscriberSessionId
      }));
    } else {
      sender.send(JSON.stringify({
        type: 'error',
        message: 'トラック購読に失敗'
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
      odUserId: connection.id,
      speakers: Array.from(this.speakers)
    }));
  }

  // --------------------------------------------
  // Cloudflare API メソッド
  // --------------------------------------------

  private getToken(): string {
    const env = (this.room as any).env;
    const token = env?.CLOUDFLARE_CALLS_TOKEN || "";
    return token;
  }

  private async createSession(): Promise<{ sessionId: string } | null> {
    const token = this.getToken();
    
    if (!token) {
      console.error('CLOUDFLARE_CALLS_TOKEN is not set!');
      return null;
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`;
      console.log('Creating session, URL:', url);
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      console.log('createSession response status:', res.status);
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error('createSession error response:', errorText);
        return null;
      }

      const json = await res.json() as any;
      console.log('createSession success, sessionId:', json.sessionId);
      
      return { sessionId: json.sessionId };
    } catch (e) {
      console.error('createSession exception:', e);
      return null;
    }
  }

  private async publishTrack(
    sessionId: string,
    offer: any,
    trackName: string
  ): Promise<{ answer: any } | null> {
    const token = this.getToken();

    if (!token) {
      console.error('publishTrack: token is empty');
      return null;
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      console.log('publishTrack URL:', url);
      console.log('publishTrack trackName:', trackName);

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

      console.log('publishTrack response status:', res.status);

      if (!res.ok) {
        const errorText = await res.text();
        console.error('publishTrack error response:', errorText);
        return null;
      }

      const json = await res.json() as any;
      console.log('publishTrack success');

      if (!json.sessionDescription) {
        console.error('publishTrack: no sessionDescription in response');
        return null;
      }

      return { answer: json.sessionDescription };
    } catch (e) {
      console.error('publishTrack exception:', e);
      return null;
    }
  }

  private async subscribeTrack(
    sessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ offer: any } | null> {
    const token = this.getToken();

    if (!token) {
      console.error('subscribeTrack: token is empty');
      return null;
    }

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      console.log('subscribeTrack URL:', url);

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

      console.log('subscribeTrack response status:', res.status);

      if (!res.ok) {
        const errorText = await res.text();
        console.error('subscribeTrack error response:', errorText);
        return null;
      }

      const json = await res.json() as any;
      console.log('subscribeTrack success');

      return { offer: json.sessionDescription };
    } catch (e) {
      console.error('subscribeTrack exception:', e);
      return null;
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
