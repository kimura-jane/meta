import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  users: Record<string, any> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();

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
        if (this.speakers.size < 5) {
          this.speakers.add(sender.id);
          this.users[sender.id].isSpeaker = true;
          
          const session = await this.createSession();
          if (session) {
            this.users[sender.id].sessionId = session.sessionId;
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
        } else {
          sender.send(JSON.stringify({
            type: 'speakDenied',
            reason: '登壇者は最大5人までです'
          }));
        }
        break;

      case 'stopSpeak':
        this.speakers.delete(sender.id);
        if (this.users[sender.id]) {
          this.users[sender.id].isSpeaker = false;
          this.users[sender.id].sessionId = null;
        }
        this.tracks.delete(sender.id);
        
        this.room.broadcast(JSON.stringify({
          type: 'speakerLeft',
          userId: sender.id,
          speakers: Array.from(this.speakers)
        }));
        break;

      case 'publishTrack':
        const publishResult = await this.publishTrack(
          data.sessionId,
          data.offer,
          data.trackName
        );
        if (publishResult) {
          this.tracks.set(sender.id, data.trackName);
          sender.send(JSON.stringify({
            type: 'trackPublished',
            answer: publishResult.answer,
            trackName: data.trackName
          }));
          
          this.room.broadcast(JSON.stringify({
            type: 'newTrack',
            userId: sender.id,
            trackName: data.trackName,
            sessionId: data.sessionId
          }), [sender.id]);
        }
        break;

      case 'subscribeTrack':
        const subResult = await this.subscribeTrack(
          data.sessionId,
          data.remoteSessionId,
          data.trackName
        );
        if (subResult) {
          sender.send(JSON.stringify({
            type: 'subscribed',
            offer: subResult.offer,
            trackName: data.trackName
          }));
        }
        break;

      case 'subscribeAnswer':
        await this.sendAnswer(data.sessionId, data.answer);
        break;
    }
  }

  async onClose(connection: Party.Connection) {
    this.speakers.delete(connection.id);
    this.tracks.delete(connection.id);
    delete this.users[connection.id];
    
    this.room.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: connection.id,
      speakers: Array.from(this.speakers)
    }));
  }

  private getToken(): string {
    return (this.room as any).env?.CLOUDFLARE_CALLS_TOKEN || "";
  }

  private async createSession(): Promise<{ sessionId: string } | null> {
    try {
      const res = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getToken()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        }
      );
      const json = await res.json() as any;
      return { sessionId: json.sessionId };
    } catch (e) {
      console.error('createSession error:', e);
      return null;
    }
  }

  private async publishTrack(
    sessionId: string,
    offer: any,
    trackName: string
  ): Promise<{ answer: any } | null> {
    try {
      const res = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getToken()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionDescription: offer,
            tracks: [{
              location: 'local',
              trackName: trackName
            }]
          })
        }
      );
      const json = await res.json() as any;
      return { answer: json.sessionDescription };
    } catch (e) {
      console.error('publishTrack error:', e);
      return null;
    }
  }

  private async subscribeTrack(
    sessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ offer: any } | null> {
    try {
      const res = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.getToken()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            tracks: [{
              location: 'remote',
              trackName: trackName,
              sessionId: remoteSessionId
            }]
          })
        }
      );
      const json = await res.json() as any;
      return { offer: json.sessionDescription };
    } catch (e) {
      console.error('subscribeTrack error:', e);
      return null;
    }
  }

  private async sendAnswer(sessionId: string, answer: any): Promise<void> {
    try {
      await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.getToken()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionDescription: answer
          })
        }
      );
    } catch (e) {
      console.error('sendAnswer error:', e);
    }
  }
}
