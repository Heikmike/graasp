import WebSocket from 'ws';
import * as Y from 'yjs';

import { FastifyBaseLogger } from 'fastify';

import { Websocket } from '@graasp/sdk';

import { Actor, Member } from '../member/entities/member';
import {
  createServerErrorResponse,
  createServerSuccessResponse,
  createServerUpdate,
} from './message';
import { MultiInstanceChannelsBroker } from './multi-instance';
import { WebSocketChannels } from './ws-channels';

export interface SubscriptionRequest {
  /**
   * Subscription target channel name
   */
  channel: string;
  /**
   * Member requesting a subscription
   */
  member: Member;
}

type ValidationFn = (request: SubscriptionRequest) => Promise<void>;

/**
 * Concrete implementation of the WebSocket service
 * Provides WebSocket connectivity to the rest of the server
 * @see {WebSocketService}
 */
export class WebsocketService {
  // store for validation functions indexed by topic
  private validators: Map<string, ValidationFn> = new Map();
  // channels abstraction reference
  private wsChannels: WebSocketChannels;
  // multi-instance channels broker reference (to send across servers cluster)
  private wsMultiBroker: MultiInstanceChannelsBroker;
  // parser function that converts raw client websocket data into JS
  private parse: (data: WebSocket.Data) => Websocket.ClientMessage | undefined;
  // logger
  private logger: FastifyBaseLogger;
  // YJS document
  private yjsDoc: Y.Doc;

  constructor(
    wsChannels: WebSocketChannels,
    wsMultiBroker: MultiInstanceChannelsBroker,
    parse: (data: WebSocket.Data) => Websocket.ClientMessage | undefined,
    log: FastifyBaseLogger,
  ) {
    this.wsChannels = wsChannels;
    this.wsMultiBroker = wsMultiBroker;
    this.parse = parse;
    this.logger = log;
    this.yjsDoc = new Y.Doc();
  }

  /**
   * Helper to scope channel by topic
   * @param channel public channel name
   * @param topic topic into which the channel should be scoped
   * @returns low-level unique channel name that includes scoping information
   */
  private scope(channel: string, topic: string): string {
    if (channel === 'broadcast') {
      return channel;
    }
    return `${topic}/${channel}`;
  }

  /**
   * Helper to handle client subscribe and subscribeOnly actions
   */
  private async handleSubscribe(
    request: Websocket.ClientSubscribe | Websocket.ClientSubscribeOnly,
    member: Actor,
    client: WebSocket,
    subscribeFn: (client: WebSocket, channelName: string) => boolean,
  ) {
    let res: Websocket.ServerMessage;

    // prevent public subscribe
    if (!member) {
      res = createServerErrorResponse(
        { message: 'not authorized', name: 'websockets signed out' },
        request,
      );
      return this.wsChannels.clientSend(client, res);
    }

    const validate = this.validators.get(request.topic);
    if (validate === undefined) {
      this.logger.info(`graasp-plugin-websockets: Validator not found for topic ${request.topic}`);
      res = createServerErrorResponse(new Websocket.NotFoundError(), request);
    } else {
      try {
        await validate({
          channel: request.channel,
          member,
        });

        // scope channel into topic
        const scopedChannel = this.scope(request.channel, request.topic);

        // no throw so user is allowed, create channel if needed
        if (!this.wsChannels.channels.has(scopedChannel)) {
          this.wsChannels.channelCreate(scopedChannel, true);
        }

        res = subscribeFn(client, scopedChannel)
          ? createServerSuccessResponse(request)
          : createServerErrorResponse(new Websocket.NotFoundError(), request);
      } catch (error) {
        res = createServerErrorResponse(error, request);
      }
    }

    this.wsChannels.clientSend(client, res);
  }

  /**
   * Helper to handle unsubscribe action
   */
  private handleUnsubscribe(request: Websocket.ClientUnsubscribe, client: WebSocket) {
    // scope channel into topic
    const scopedChannel = this.scope(request.channel, request.topic);
    const res = this.wsChannels.clientUnsubscribe(client, scopedChannel)
      ? createServerSuccessResponse(request)
      : createServerErrorResponse(new Websocket.NotFoundError(), request);
    this.wsChannels.clientSend(client, res);
    // preemptively remove channel if empty
    this.wsChannels.channelDelete(scopedChannel, true);
  }

  /**
   * Simply forwards requests to the YJS websocket server
   * @param data raw websocket data sent from client
   * @param member member performing the request
   * @param socket client socket
   */
  handleRequest(data: WebSocket.Data, member: Actor, clientws: WebSocket): void {
    const { messageType, updateYjs, itemId, token } = JSON.parse(data.toString());
    let yjsDoc: Y.Doc;
    const yjsDocTemp = this.yjsDocs.find((doc) => doc[0] === itemId);
    const broadcastClients = this.clients.filter((client) => client[0] === itemId);
    const thisClient = this.clients.find((client) => client[1] === clientws);

    if (!yjsDocTemp) {
      yjsDoc = new Y.Doc();
      this.yjsDocs.push([itemId, yjsDoc]);
    } else {
      yjsDoc = yjsDocTemp[1];
    }

    if (!thisClient) {
      this.clients.push([itemId, clientws]);
    }

    switch (messageType) {
      case 'update':
        const updateDecoded = Buffer.from(updateYjs, 'base64');
        const update = new Uint8Array(updateDecoded as ArrayBuffer);
        Y.applyUpdate(yjsDoc, update);
        const newUpdate = Y.encodeStateAsUpdate(yjsDoc);
        // TODO: Send only to clients from item with itemId,
        // not to all clients
        // this.wsChannels.broadcast(newUpdate);
        if (broadcastClients) {
          broadcastClients.forEach((client) => {
            client[1].send(newUpdate);
          });
        }
      case 'init':
        const state = Y.encodeStateAsUpdate(yjsDoc);
        clientws.send(state);
    }
  }

  register(topic: string, validateClient: ValidationFn): this {
    if (this.validators.has(topic)) {
      this.logger.error(`graasp-plugin-websockets: Topic ${topic} is already registered`);
      throw new Error('WebSocketService.register: topic already exists!');
    }
    this.validators.set(topic, validateClient);
    return this;
  }

  publish<Message>(topic: string, channel: string, message: Message): void {
    // scope channel into topic
    const scopedChannel = this.scope(channel, topic);
    this.wsMultiBroker.dispatch(scopedChannel, createServerUpdate(topic, channel, message));
  }

  publishLocal<Message>(topic: string, channel: string, message: Message): void {
    // scope channel into topic
    const scopedChannel = this.scope(channel, topic);
    this.wsChannels.channelSend(scopedChannel, createServerUpdate(topic, channel, message));
  }
}
