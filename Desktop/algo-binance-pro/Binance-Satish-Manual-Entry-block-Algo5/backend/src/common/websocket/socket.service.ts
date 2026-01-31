import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { ManualLiveGateway } from './live.gateway';

@Injectable()
export class SocketService implements OnModuleInit {
  private server: Server;

  constructor(private readonly liveGateway: ManualLiveGateway) {}

  onModuleInit() {
    this.server = this.liveGateway.server;
    if (!this.server) {
      console.error('SocketService: Server not initialized in LiveGateway');
    }
  }

  emitLivePosition(userId: string, accountId: string, position: any) {
    if (this.server) {
      const room = `${userId}_${accountId}`;
      this.server.to(room).emit('live-data', { positionData: position });
    //  console.log(`[${new Date().toISOString()}] Emitted live position to user ${userId} account ${accountId} in room ${room}:`, position);
    } else {
      console.error('SocketService: Cannot emit live-position, server is undefined');
    }
  }
}