/**
 * graasp-plugin-websockets
 *
 * Fastify plugin for graasp-plugin-websockets
 *
 * Integrates the {@link WebSocketChannels} abstraction
 * in a fastify server plugin with @fastify/websocket
 */
import { RedisOptions } from 'ioredis';

import fws from '@fastify/websocket';
import { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';

import { AjvMessageSerializer } from './message-serializer';
import { MultiInstanceChannelsBroker } from './multi-instance';
import { WebSocketChannels } from './ws-channels';
import { WebsocketService } from './ws-service';

/**
 * Type definition for plugin options
 */
export interface WebsocketsPluginOptions {
  prefix: string;
  redis: {
    config: RedisOptions;
    channelName: string;
  };
  validateApiAccessToken: any;
}

/**
 * Helper function to log boot message after plugin initialization
 */
function logBootMessage(log: FastifyBaseLogger, options: WebsocketsPluginOptions) {
  const { redis, ...rest } = options;
  const { config, channelName } = redis;

  const loggedOptions = {
    ...rest,
    redis: {
      // don't log password
      ...config,
      password: undefined,
      channelName,
    },
  };
  delete loggedOptions.redis.password;

  log.info('graasp-plugin-websockets: plugin booted with options', loggedOptions);
}

const plugin: FastifyPluginAsync<WebsocketsPluginOptions> = async (fastify, options) => {
  // destructure passed fastify instance
  const { log } = fastify;
  const { validateApiAccessToken } = options;

  // Serializer / deserializer instance
  const serdes = new AjvMessageSerializer();

  // create channels abstraction instance
  const wsChannels = new WebSocketChannels(fastify.websocketServer, serdes.serialize, log);

  // create multi-instance channels broker
  const wsMultiBroker = new MultiInstanceChannelsBroker(wsChannels, options.redis, log);

  // create websockets service
  const wsService = new WebsocketService(wsChannels, wsMultiBroker, serdes.parse, log);

  // decorate server with service
  fastify.decorate('websocketsyjs', wsService);

  // decorate with debug internals in test mode
  if (process.env.NODE_ENV === 'test') {
    fastify.decorate('_debug_websocketsChannelsyjs', wsChannels);
  }

  // handle incoming requests
  // allow public
  // TODO: remove allow public
  fastify.get(
    options.prefix,
    { websocket: true },
    (conn, req) => {
      validateApiAccessToken(req.query.authorization, req);
      // raw websocket client
      const client = conn.socket;
      // member from valid session
      const { member } = req;

      wsChannels.clientRegister(client);

      client.on('message', (msg) => wsService.handleRequest(msg, member, client));

      client.on('error', log.error);

      client.on('close', (_code, _reason) => {
        wsChannels.clientRemove(client);
      });
    },
  );

  // cleanup on server close
  fastify.addHook('onClose', (instance, done) => {
    wsMultiBroker.close();
    wsChannels.close();
    done();
  });

  logBootMessage(log, options);
};

export default plugin;
