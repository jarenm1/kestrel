import type { Message } from "@cloudagents/protocol"

export type FromThread = NonNullable<Message["fromThread"]>

/**
 * What the receiving agent reads for a message another agent of the owner sent with `thread_send`: who sent it and
 * how to answer. Replies are limited to real answers so two agents cannot keep waking each other with courtesies.
 */
export const peerMessageText = (from: FromThread, text: string): string =>
  [
    `Message from the agent of another of your user's threads, "${from.title}" (thread id ${from.id}):`,
    "",
    text,
    "",
    `If it asks for something, answer with thread_send to thread ${from.id}. Do not reply to acknowledgements or thanks.`,
  ].join("\n")
