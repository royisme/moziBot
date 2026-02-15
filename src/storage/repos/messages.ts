import type { Message } from "../types";
import { withConnection } from "../connection";

export const messages = {
  create: (msg: Message) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO messages (id, channel, chat_id, sender_id, content, timestamp) VALUES ($id, $channel, $chat_id, $sender_id, $content, $timestamp)`,
        )
        .run({
          id: msg.id,
          channel: msg.channel,
          chat_id: msg.chat_id,
          sender_id: msg.sender_id,
          content: msg.content,
          timestamp: msg.timestamp,
        }),
    ),
  getById: (id: string): Message | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | null,
    ),
  listByChat: (chatId: string): Message[] =>
    withConnection(
      (conn) =>
        conn
          .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC")
          .all(chatId) as Message[],
    ),
};
