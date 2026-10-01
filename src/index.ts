/**
 * Pi extension entrypoint. Keep these host imports as static string literals so
 * Pi's extension loader can resolve them in every supported runtime.
 */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startKeyRotator } from "./start.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  StreamSimpleLike,
} from "./types.ts";

export default async function apiKeyRotatorExtension(pi: ExtensionAPI): Promise<void> {
  await startKeyRotator(pi as unknown as ExtensionApiLike, {
    baseStreamSimple: streamSimple as unknown as StreamSimpleLike,
    createEventStream: createAssistantMessageEventStream as unknown as EventStreamFactory,
    errorPolicy: {
      isContextOverflow: (message) => isContextOverflow(message as never),
      isRetryableAssistantError: (message) => isRetryableAssistantError(message as never),
    },
  });
}
