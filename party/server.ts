import type * as Party from "partykit/server";

export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  users: Record<string, any> = {};

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const userId = connection.id;
    
    this.users[userId] = {
      id: userId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3
    };

    connection.send(JSON.stringify({
      type: 'init',
      users: this.users,
      yourId: userId
    }));

    this.room.broadcast(JSON.stringify({
      type: 'userJoin',
      user: this.users[userId]
    }), [connection.id]);
  }

  async onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message as string);

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
    }
  }

  async onClose(connection: Party.Connection) {
    delete this.users[connection.id];
    this.room.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: connection.id
    }));
  }
}
