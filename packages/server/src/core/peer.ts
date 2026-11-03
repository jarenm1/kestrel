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

/**
 * What the agent of a delegated thread reads for its assignment. The result reaches the delegating thread by itself
 * when the run ends, so the child MUST NOT send it again with `thread_send`: that would start a second parent run for
 * the same result, and its reply could wake the child again.
 */
export const delegatedAssignmentText = (from: FromThread, text: string): string =>
  [
    `Delegated task from the agent of thread "${from.title}" (thread id ${from.id}):`,
    "",
    text,
    "",
    `Its result is delivered to thread ${from.id} automatically when this run ends. Give your final response in this thread; do not send it with thread_send. If the user must decide something, use task_ask so they answer in this thread.`,
  ].join("\n")

/**
 * What an agent reads for a delegation notification Kestrel delivered itself (a child's result or question). These
 * MUST NOT invite `thread_send`: a reply would start the child again, and its question belongs to the user.
 */
export const automaticDelegationText = (from: FromThread, text: string, question: boolean): string =>
  [
    `Automatic notification from the delegated thread "${from.title}" (thread id ${from.id}):`,
    "",
    text,
    "",
    question
      ? "The question belongs to the user; do not answer it and do not message that thread about it."
      : "No reply is needed; do not message that thread about it. Use delegation_status if you need the result again.",
  ].join("\n")
