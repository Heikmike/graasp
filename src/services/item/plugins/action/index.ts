import { StatusCodes } from 'http-status-codes';

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import {
  AggregateBy,
  AggregateFunction,
  AggregateMetric,
  Context,
  CountGroupBy,
  FileItemType,
  HttpMethod,
} from '@graasp/sdk';

import { IdParam } from '../../../../types';
import { CLIENT_HOSTS } from '../../../../utils/config';
import { buildRepositories } from '../../../../utils/repositories';
import {
  LocalFileConfiguration,
  S3FileConfiguration,
} from '../../../file/interfaces/configuration';
import { ItemOpFeedbackErrorEvent, ItemOpFeedbackEvent, memberItemsTopic } from '../../ws/events';
import { CannotPostAction } from './errors';
import { ActionRequestExportService } from './requestExport/service';
import { exportAction, getAggregateActions, getItemActions, postAction } from './schemas';
import { ActionItemService } from './service';

export interface GraaspActionsOptions {
  shouldSave?: boolean;
  fileItemType: FileItemType;
  fileConfigurations: { s3: S3FileConfiguration; local: LocalFileConfiguration };
}

const plugin: FastifyPluginAsync<GraaspActionsOptions> = async (fastify) => {
  const {
    files: { service: fileService },
    actions: { service: actionService },
    items: { service: itemService },
    members: { service: memberService },
    mailer,
    db,
    websockets,
  } = fastify;

  const actionItemService = new ActionItemService(actionService, itemService, memberService);
  fastify.items.actions = { service: actionItemService };

  const requestExportService = new ActionRequestExportService(
    actionService,
    actionItemService,
    itemService,
    fileService,
    mailer,
  );

  const allowedOrigins = Object.values(CLIENT_HOSTS).map(({ url }) => url.origin);

  // get actions and more data matching the given `id`
  fastify.get<{ Params: IdParam; Querystring: { requestedSampleSize?: number; view?: Context } }>(
    '/:id/actions',
    {
      schema: getItemActions,
      preHandler: fastify.verifyAuthentication,
    },
    async ({ member, params: { id }, query }) => {
      return actionItemService.getBaseAnalyticsForItem(member, buildRepositories(), {
        sampleSize: query.requestedSampleSize,
        itemId: id,
        view: query.view?.toLowerCase(),
      });
    },
  );

  // get actions aggregate data matching the given `id`
  fastify.get<{
    Params: IdParam;
    Querystring: {
      requestedSampleSize: number;
      view: Context;
      type?: string[];
      countGroupBy: CountGroupBy[];
      aggregateFunction: AggregateFunction;
      aggregateMetric: AggregateMetric;
      aggregateBy?: AggregateBy[];
    };
  }>(
    '/:id/actions/aggregation',
    {
      schema: getAggregateActions,
      preHandler: fastify.verifyAuthentication,
    },
    async ({ member, params: { id }, query }) => {
      return actionItemService.getAnalyticsAggregation(member, buildRepositories(), {
        sampleSize: query.requestedSampleSize,
        itemId: id,
        view: query.view?.toLowerCase(),
        type: query.type,
        countGroupBy: query.countGroupBy,
        aggregationParams: {
          aggregateFunction: query.aggregateFunction,
          aggregateMetric: query.aggregateMetric,
          aggregateBy: query.aggregateBy,
        },
      });
    },
  );

  fastify.route<{ Params: IdParam; Body: { type: string; extra?: { [key: string]: unknown } } }>({
    method: HttpMethod.Post,
    url: '/:id/actions',
    schema: postAction,
    preHandler: fastify.attemptVerifyAuthentication,
    handler: async (request) => {
      const {
        member,
        params: { id: itemId },
        body: { type, extra = {} },
      } = request;

      // allow only from known hosts
      if (!request.headers.origin) {
        throw new CannotPostAction();
      }
      if (!allowedOrigins.includes(request.headers.origin)) {
        throw new CannotPostAction(request.headers.origin);
      }

      return db.transaction(async (manager) => {
        const repositories = buildRepositories(manager);
        const item = await itemService.get(member, repositories, itemId);
        await actionService.postMany(member, repositories, request, [
          {
            item,
            type,
            extra,
          },
        ]);
      });
    },
  });

  // export actions matching the given `id`
  fastify.route<{ Params: IdParam }>({
    method: 'POST',
    url: '/:id/actions/export',
    schema: exportAction,
    preHandler: fastify.verifyAuthentication,
    handler: async (request, reply) => {
      const {
        member,
        params: { id: itemId },
        log,
      } = request;
      db.transaction(async (manager) => {
        const repositories = buildRepositories(manager);
        const item = await requestExportService.request(member, repositories, itemId);
        if (member && item) {
          websockets.publish(
            memberItemsTopic,
            member.id,
            ItemOpFeedbackEvent('export', [itemId], { [item.id]: item }),
          );
        }
      }).catch((e: Error) => {
        log.error(e);
        if (member) {
          websockets.publish(
            memberItemsTopic,
            member.id,
            ItemOpFeedbackErrorEvent('export', [itemId], e),
          );
        }
      });

      // reply no content and let the server create the archive and send the mail
      reply.status(StatusCodes.NO_CONTENT);
    },
  });
};

export default fp(plugin);
