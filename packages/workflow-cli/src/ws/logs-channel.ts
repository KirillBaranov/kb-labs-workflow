/**
 * @module @kb-labs/workflow-cli/ws/logs-channel
 * WebSocket channel for real-time job logs streaming
 */

import { defineWebSocket, defineMessage, MessageRouter } from '@kb-labs/sdk';

// Define typed messages
const SubscribeMsg = defineMessage<{ jobId: string; level?: string }>('subscribe');
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
const UnsubscribeMsg = defineMessage<{}>('unsubscribe');

const LogMsg = defineMessage<{
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: Record<string, unknown>;
}>('log');

const CompleteMsg = defineMessage<{ jobId: string; status: string }>('complete');
const ErrorMsg = defineMessage<{ error: string }>('error');

// Incoming/Outgoing types (discriminated unions)
type Incoming = ReturnType<typeof SubscribeMsg.create> | ReturnType<typeof UnsubscribeMsg.create>;

type Outgoing =
  | ReturnType<typeof LogMsg.create>
  | ReturnType<typeof CompleteMsg.create>
  | ReturnType<typeof ErrorMsg.create>;

export default defineWebSocket<unknown, Incoming, Outgoing>({
  path: '/logs/:jobId',
  description: 'Real-time job logs streaming',

  handler: {
    async onConnect(ctx, sender) {
      // Note: jobId will come from path params via runtime, not ctx.params
      // For now, log connection without jobId
      ctx.platform.logger.info('[logs-channel] Client connected', { connectionId: sender.getConnectionId() });

      // TODO: Subscribe to job logs stream from daemon
      // Client needs to send Subscribe message with jobId
    },

    async onMessage(ctx, message, sender) {
      const router = new MessageRouter()
        .on(SubscribeMsg, async (ctx, payload, _rawSender) => {
          const { jobId, level } = payload;

          ctx.platform.logger.info('[logs-channel] Subscribing to logs', { jobId, level });

          // TODO: Start streaming logs from daemon
          // For now, send confirmation
          await sender.send(
            LogMsg.create({
              timestamp: new Date().toISOString(),
              level: 'info',
              message: `Subscribed to logs for job ${jobId} (level: ${level || 'all'})`,
            })
          );
        })
        .on(UnsubscribeMsg, async (ctx, _payload, _rawSender) => {
          ctx.platform.logger.info('[logs-channel] Unsubscribing from logs');
          // TODO: Stop streaming
        });

      await router.handle(ctx, message as any, sender.raw);
    },

    async onDisconnect(ctx, code, reason) {
      ctx.platform.logger.info('[logs-channel] Client disconnected', { code, reason });
      // TODO: Cleanup subscriptions
    },

    async onError(ctx, error, sender) {
      ctx.platform.logger.error('[logs-channel] Error', error);
      try {
        await sender.send(ErrorMsg.create({ error: error.message }));
      } catch (sendError) {
        ctx.platform.logger.error('[logs-channel] Failed to send error message', sendError instanceof Error ? sendError : undefined);
      }
    },
  },
});
